# Configuration

[← Documentation index](README.md)

## Environment variables

Set in `.env` at the project root. Changing any of these requires a container restart.

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *auto-generated & persisted* | Signs session tokens. Set it to pin your own value. |
| `ENCRYPTION_KEY` | *auto-generated & persisted* | Encrypts device passwords at rest. Set it to pin your own value. |
| `CORS_ORIGIN` | *localhost defaults* | Comma-separated browser origins allowed to call the API. **Required in production.** |
| `DB_PASSWORD` | `mikrotik_secure_pw` | PostgreSQL password |
| `INFLUXDB_TOKEN` | `mytoken123456789` | InfluxDB admin token |
| `INFLUXDB_ORG` | `mikrotik-manager` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `metrics` | InfluxDB bucket for time-series data |
| `INFLUXDB_ADMIN_PASSWORD` | `admin_password_123` | InfluxDB admin UI password |
| `REDIS_PASSWORD` | *none* | Makes Redis require a password. Can be set or changed at any time |
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |
| `BIND_ADDRESS` | *every interface* | Host address the web UI is published on. See [Network exposure](#network-exposure). |
| `NETFLOW_BIND_ADDRESS` | *every interface* | Host address the NetFlow collector (UDP 2055) is published on. |

> Never commit `.env`. It is already listed in `.gitignore`.

For a production deployment the only variable you genuinely must set is `CORS_ORIGIN`.
Both secrets generate themselves safely — see below.

## Internal service passwords

`DB_PASSWORD`, `INFLUXDB_TOKEN`, `INFLUXDB_ADMIN_PASSWORD` and `REDIS_PASSWORD` protect the
databases. Their defaults are public, so set your own. Postgres, InfluxDB and Redis sit on a
network of their own that only the backend joins, with no route out, so nothing else can reach
them. The passwords are a second layer.

**On a new install**, set them in `.env` before the first `docker compose up -d`. Hex values
are the easiest, since they need no quoting anywhere:

```
openssl rand -hex 24
```

**On an existing install**, Postgres and InfluxDB keep the password they were first started
with: they read these variables only when their data volume is empty. Changing `.env` alone
then leaves the backend unable to log in. Change the password inside the database first, then
in `.env`:

- **Postgres**:

  ```
  docker compose exec postgres psql -U mikrotik -d mikrotik_manager \
    -c "ALTER USER mikrotik WITH PASSWORD 'new-password'"
  ```

  Then set `DB_PASSWORD=new-password` in `.env` and run `docker compose up -d`.

- **InfluxDB token**: create a new all-access token, put it in `INFLUXDB_TOKEN`, run
  `docker compose up -d`, then delete the old token:

  ```
  docker compose exec influxdb influx auth create --all-access --org mikrotik-manager
  ```

  `influx auth list` shows the old token's ID, and `influx auth delete --id <id>` removes it.

- **Redis** stores no password, so `REDIS_PASSWORD` can be set or changed at any time; run
  `docker compose up -d` afterwards.

Before 0.24.51 the database password was part of a connection URL, so a password containing
`/`, `@` or `:` stopped the backend from starting. It is now passed on its own.

## First login

A new install has one account, **admin** with the password **admin**. Signing in with it
goes straight to a page that asks for a new password (at least 10 characters and at most
72 bytes, with a letter and a number); nothing else works until it is set. The 72-byte limit
is bcrypt's: it ignores anything longer, so a longer password changed only at the end would
still accept the old one. The login page shows the
default credentials only until then. An existing install still using admin/admin gets
the same prompt at its next login.

## Sessions

A sign-in lasts up to 24 hours, but every request checks the account as it is now, so a
session ends straight away when:

- the user **logs out** (that session only);
- an admin **changes the user's role** or **resets their password** (all of that user's
  sessions, in every browser);
- the user **changes their own password** (all their other sessions; the browser they
  changed it in stays signed in);
- the account is **deleted**.

The role in effect is always the account's current one. Open live-update and terminal
connections are checked again every minute and closed when their session has ended, and a
terminal re-checks the account before it opens a shell. Before 0.24.46 a session kept its
original role and access for its full 24 hours, whatever happened to the account.

An admin who resets their *own* password from **Settings → Users** is signed out and
signs in again with the new one. API tokens are separate and unaffected: revoke those
under **Settings → Automation → API Tokens**.

## Secret management (self-healing)

`JWT_SECRET` and `ENCRYPTION_KEY` are managed automatically so that a fresh install is
secure by default and an upgrade never strands existing data.

- **Set to a strong value in the environment** — that value is used, and you stay in
  control.
- **Unset, or left at a value from an example file** (for `JWT_SECRET`, anything
  starting `changeme`) — the backend generates a strong secret once,
  persists it to the `app_data` volume (`SECRETS_DIR`, default `/app/data`), and reuses
  it on every boot.

Secrets live outside the database deliberately: a database dump alone cannot reveal the
key protecting the credentials stored inside it.

### Upgrading is non-breaking

Existing ciphertext is decrypted through a **legacy-key fallback** — including previous
shipped defaults — and transparently re-encrypted under the current key by a background
sweep. Nothing needs to be re-entered.

Rotating the JWT secret off a public default invalidates sessions signed with it. Users
simply log in again once.

### Changing JWT_SECRET

Setting `JWT_SECRET` in `.env` (or changing it) is treated as a rotation. The secret the
manager was using before, and any older ones, keep working for 24 hours from the first start
with the new value, so signed-in users aren't cut off mid-session, and then stop. They are also
removed from `secrets.json`, so unsetting `JWT_SECRET` later never brings a retired secret back
(the manager generates a fresh one instead). This is the step to take if `secrets.json` may
have leaked; before 0.24.50 the leaked secret stayed valid. If the old secret must stop
working at once rather than after 24 hours, also delete the `retiringJwtSecrets` entry from
`secrets.json` in the `app_data` volume and restart the backend; everyone then signs in again.

### Key rotation

**Settings → General → Encryption key** shows where the key comes from, a short key ID (a
fingerprint, not the key), and how many stored values are under the current key, under an
older key, or under no key the manager has.

Everything the key protects is covered: device API and SSH passwords, credential presets, SSH
private keys, the SSO client secret, alert channel secrets (SMTP password, Telegram bot token,
ntfy and Gotify tokens, Slack and Discord webhook URLs), webhook signing secrets, and backups
that contain secrets. On every start, anything
still under an older key is re-encrypted with the current one.

**A key the manager generated** (the default, kept in `app_data/secrets.json`):

1. Click **Rotate key…** and confirm. A new key is written to `secrets.json` with the old one
   kept beside it, and only then does the manager switch. Everything is re-encrypted straight
   away.
2. When the card shows nothing under an older key, click **Retire older keys**.

**A key you set in `.env`:**

1. Put the new key in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEY_PREVIOUS`, then
   restart (`docker compose up -d`). The manager re-encrypts everything with the new key as it
   starts.
2. When the card shows nothing under an older key, remove `ENCRYPTION_KEY_PREVIOUS` and
   restart again.

`ENCRYPTION_KEY_PREVIOUS` takes a comma-separated list if you have more than one old key.

!!! danger "Changing `ENCRYPTION_KEY` without `ENCRYPTION_KEY_PREVIOUS`"
    Before 0.24.46 this silently made every stored credential unreadable. Now the manager
    notices at startup: it shows **Encryption key missing** to admins, logs it, and refuses to
    save new credentials, so nothing is written under the wrong key. Put the original key back
    (in `ENCRYPTION_KEY`, or in `ENCRYPTION_KEY_PREVIOUS`) and restart, and everything reads
    again. Don't re-enter device passwords first.

The same happens if the key is lost with the `app_data` volume, for example after moving the
manager to a new host with only a database dump: restore `secrets.json` and restart.

## Backing up the manager

A complete backup is these four things. The first is useless without the second.

| What | Where | Why |
|---|---|---|
| The database | `docker compose exec postgres pg_dump -U mikrotik mikrotik_manager` | Devices, settings, history, and the encrypted credentials |
| The encryption key | `app_data` volume (`secrets.json`), or your `ENCRYPTION_KEY` | Without it the credentials in the dump can't be decrypted |
| Device backups | `backups_data` volume | The configuration backups themselves; some are encrypted with the key |
| TLS certificate | `certs_data` volume | Only if you installed your own certificate |

Store the key **separately** from the database dump. Together they give anyone the admin
passwords of every managed device; apart, neither does. To restore, bring back all four, with
the key in place before the manager's first start.

## Settings stored in the database

These are edited in the Settings UI and take effect without a restart:

| Area | Settings | Documented in |
|---|---|---|
| Change Guard | `change_guard_enabled`, `change_guard_mode`, `change_guard_timeout_sec` | [Change Guard](change-guard.md) |
| Config Health | `config_health_enabled`, `config_health_interval_min` | [Change Guard](change-guard.md) |
| Polling | fast / slow / log intervals, MAC scan, spectral and AP scan cadence | Settings → Polling |
| Config snapshots | `config_snapshot_enabled`, `config_snapshot_interval_min`, `config_snapshot_retention` | Settings → Config History |
| NetFlow | collector address and port, version, retention, top-N clients | Settings → NetFlow |
| Alerting | rules, thresholds, cooldowns, channels | [Alerting](alerting.md) |

## Network exposure

The manager holds the admin credentials for every device it manages, so keep it off the
internet: reach it over your LAN or a VPN.

By default Docker publishes the web UI (80, 443) and the NetFlow collector (UDP 2055) on
**every** host interface. **A host firewall such as ufw or firewalld does not close
them**: Docker adds its own rules for published ports, and traffic to them never reaches
the chains those tools manage. On a host with a public or DMZ interface, the manager is
reachable from the internet even though ufw says the port is closed.

Pick one of these:

- **Publish on one address.** Set `BIND_ADDRESS` (and `NETFLOW_BIND_ADDRESS`) in `.env` to
  the host's LAN or VPN address, then `docker compose up -d`:

  ```
  BIND_ADDRESS=192.168.1.10
  NETFLOW_BIND_ADDRESS=192.168.1.10
  ```

  Only that address listens. To reach it over IPv6 as well, leave it unset and use the
  next option instead.

- **Filter in the `DOCKER-USER` chain.** Docker checks this chain before its own rules, so
  it does apply to published ports. For example, to allow the UI only from 192.168.1.0/24
  and NetFlow only from your routers' management subnet, where `eth0` is the public
  interface:

  ```
  iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 ! -s 192.168.1.0/24 -j DROP
  iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 ! -s 192.168.1.0/24 -j DROP
  iptables -I DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 2055 ! -s 10.10.0.0/24 -j DROP
  ```

  These rules don't survive a reboot by themselves; save them the way your distribution
  does (for example `netfilter-persistent save`).

- **Put the host behind a firewall it doesn't control**, such as the router in front of it
  or a cloud security group.

NetFlow has no authentication of its own, so whatever can reach UDP 2055 can send flows.
The collector only accepts flows from managed devices unless you turn on **Accept flows
from unknown exporters** (see [Traffic](traffic.md)), but limiting who can reach the port
is still the real protection.

Before 0.24.47 there was no bind setting, and the ports were always published on every
interface.

## Container hardening

From 0.24.51 the containers run with less:

- **backend**: every Linux capability dropped except `NET_RAW` (server-side ARP discovery), a
  read-only root filesystem, and a non-root user that owns only its data directories. It can
  write its volumes and `/tmp`, and nothing else.
- **nginx**: only the capabilities it uses, no privilege escalation, and a read-only root
  filesystem.
- **Postgres, Redis, InfluxDB**: no privilege escalation, on the internal network only.
- **Logs** from every container rotate at 10 MB, five files each.

## TLS

A self-signed certificate is generated on first run. Replace it under
**Settings → TLS Certificate** by uploading a certificate and private key, or regenerate the
self-signed one; nginx terminates TLS, picks up the new certificate within a few seconds, and
redirects HTTP to HTTPS.

Before 0.24.37 both failed with "permission denied": the certificate volume was owned by
root and the backend runs as a normal user. The nginx container now hands the volume to the
backend user (uid 100, gid 101) at every start, which also fixes existing installs.

## Updating and image versions

Images are published to GHCR only after CI has passed on that commit:
`ghcr.io/2gt-media-group-llc/mikrotik-manager-backend` and `…-nginx`. Each is tagged
`latest`, its version (for example `0.24.37-beta`) and `sha-<commit>`. To stay on a
version, replace `latest` with the version tag in `docker-compose.ghcr.yml`.

From 0.24.51 each image carries an SBOM and build provenance, and is signed with
[cosign](https://docs.sigstore.dev/) by the workflow that built it. To check an image before
running it:

```
cosign verify ghcr.io/2gt-media-group-llc/mikrotik-manager-backend:latest \
  --certificate-identity-regexp 'https://github.com/2GT-Media-Group-LLC/mikrotik-manager/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Base images and the database images are pinned by digest, so a tag moved upstream can't change
what's built or run until an update is reviewed.


## Dark Site Mode

**Settings → Dark Site Mode** lists every feature that makes a request to the
internet on its own, with where each one goes and what stops working without it. Each can be
turned off individually. All are **on** by default.

| Feature | Destination | When off |
|---|---|---|
| Maps and address lookup | `*.tile.openstreetmap.org`, `nominatim.openstreetmap.org` | No location maps; addresses are kept as text |
| Platform update check | `raw.githubusercontent.com` | The dashboard does not report newer releases |
| Daily RouterOS update check | MikroTik's update servers, contacted **by each device** | Devices are not asked daily; the on-demand button still works |
| RouterOS changelogs | `download.mikrotik.com` | Release notes are not shown |
| MAC vendor database download | `standards-oui.ieee.org` | The vendor list is not refreshed; an existing copy is still used |
| RouterOS vulnerability list | `services.nvd.nist.gov`, `www.cisa.gov` | The Security page doesn't list known CVEs for the fleet's versions |
| Documentation link | `2gt-media-group-llc.github.io` | The top-bar documentation button is hidden |

Alert channels — Slack, Discord, Telegram, ntfy, webhooks — are not listed. They send only
when a destination has been configured, so leaving them unconfigured is already the off switch.

The daily RouterOS check is the one that is easy to miss when auditing a firewall: the request
comes from each MikroTik device, not from the manager's host.

The MAC vendor database is downloaded at startup when the cached copy is older than its refresh
interval. With the download off, the cached copy is used however old it is. Before v0.24.24 a
failed download discarded the cache and left vendor lookups empty; it now falls back to it.
