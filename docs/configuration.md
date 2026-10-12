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
| `PASSWORD_LOGIN` | `true` | `false` makes sign-in SSO-only. See [SSO-only sign-in](sso-oidc.md#behaviour-and-safety) |
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS, or serves the app with `TLS_MODE=proxy`) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |
| `BIND_ADDRESS` | *every interface* | Host address the web UI is published on. See [Network exposure](#network-exposure). |
| `NETFLOW_BIND_ADDRESS` | *every interface* | Host address the NetFlow collector (UDP 2055) is published on. |
| `TLS_MODE` | `https` | `proxy` when your own reverse proxy terminates TLS. See [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `TRUSTED_PROXIES` | *none* | Your reverse proxy's address or range, so the client address it forwards is believed. |

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
- **nginx**: only the capabilities it uses, and a read-only root filesystem.
- **Postgres, Redis, InfluxDB**: on the internal network only.
- **Logs** from every container rotate at 10 MB, five files each.

The containers don't set `no-new-privileges`. On Ubuntu with AppArmor it stops them starting at
all: the first command in the container fails with "operation not permitted". 0.24.51 set it,
and on such hosts the update left the databases restarting; 0.24.52 removes it.

## TLS

A self-signed certificate is generated on first run. Replace it under
**Settings → TLS Certificate** by uploading a certificate and private key, or regenerate the
self-signed one; nginx terminates TLS, picks up the new certificate within a few seconds, and
redirects HTTP to HTTPS.

Before 0.24.37 both failed with "permission denied": the certificate volume was owned by
root and the backend runs as a normal user. The nginx container now hands the volume to the
backend user (uid 100, gid 101) at every start, which also fixes existing installs.

## Behind a reverse proxy

If you already run a reverse proxy (Nginx Proxy Manager, Traefik, Caddy, HAProxy) that holds
your certificates, let it terminate TLS and hand plain HTTP to the manager (#256). Set in
`.env`:

```
TLS_MODE=proxy
TRUSTED_PROXIES=10.0.0.5
CORS_ORIGIN=https://mtm.example.com
```

Then `docker compose up -d`.

| Variable | Default | What it does |
|---|---|---|
| `TLS_MODE` | `https` | `proxy` serves the app over plain HTTP on `HTTP_PORT` instead of redirecting it to HTTPS. HTTPS on `HTTPS_PORT` keeps working with the manager's own certificate. |
| `TRUSTED_PROXIES` | *none* | Your proxy's address or range (CIDR), comma-separated, IPv4 or IPv6. Only requests from these addresses may say who the client is (`X-Forwarded-For`) and that the browser used HTTPS (`X-Forwarded-Proto`). |
| `CORS_ORIGIN` | | The address people type in the browser, as the proxy serves it. The browser sends it with every request, and the API refuses origins not on the list. |

Point the proxy at `http://<manager host>:<HTTP_PORT>`, and turn on WebSocket support: live
updates and the device terminal run over `/socket.io/`.

Give the proxy a read timeout of at least 300 seconds (the same as the manager's own). Many
proxies default to 60, and a protected change on a slow device can take longer: on a CRS112 a
bridge move took about a minute and a half end to end.

**Keep the plain HTTP port for the proxy only.** Anyone else who can reach it talks to the
manager unencrypted. If the proxy runs on the same host, `BIND_ADDRESS=127.0.0.1` keeps both
ports off the network; otherwise use one of the options in
[Network exposure](#network-exposure).

**Why `TRUSTED_PROXIES` matters.** Without it every request appears to come from the proxy:
the audit log shows the proxy's address, and the per-address limit on sign-in attempts counts
all your users as one, so a busy morning or a few typos can stop everyone signing in for a
while. Headers from anyone
else are ignored, so a client can't claim to be somewhere else by sending its own
`X-Forwarded-For`. The nginx container logs a warning at start if `TLS_MODE=proxy` is set
without it.

Not sure which address the proxy arrives from? Leave `TRUSTED_PROXIES` unset, sign in once
through the proxy, and look at the **IP** column of the newest entry under **Settings →
Audit Log**. A proxy on the same host usually arrives from the Docker network's gateway
(such as `172.18.0.1`), not `127.0.0.1`.

**A proxy in Docker** can join the manager's network instead of going through a published
port. Its upstream is then `http://nginx:80`, and `TRUSTED_PROXIES` is the proxy container's
address, or the network's range such as `172.18.0.0/16`.

**SSO** builds its redirect address from the host and scheme the proxy forwards, so it works
as long as `TRUSTED_PROXIES` is right. If your provider still rejects the callback, set
**Public base URL** in the SSO settings (see [SSO](sso-oidc.md)).

### Examples

Nginx Proxy Manager: a proxy host with scheme `http`, the manager's address and `HTTP_PORT`,
**Websockets Support** on, and your certificate on the SSL tab.

Caddy:

```
mtm.example.com {
    reverse_proxy 10.0.0.20:80
}
```

Traefik, with the manager's nginx service on Traefik's network:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.mtm.rule=Host(`mtm.example.com`)
  - traefik.http.routers.mtm.entrypoints=websecure
  - traefik.http.routers.mtm.tls=true
  - traefik.http.services.mtm.loadbalancer.server.port=80
```

Caddy and Traefik send `X-Forwarded-For` and `X-Forwarded-Proto` and pass WebSockets through
by default.

HAProxy:

```
frontend https-in
    bind :443 ssl crt /etc/haproxy/certs/mtm.pem
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    default_backend mtm

backend mtm
    timeout server 300s
    timeout tunnel 1h
    server mtm 10.0.0.20:80
```

`option forwardfor` adds `X-Forwarded-For`. HAProxy passes WebSocket upgrades through by
itself; `timeout tunnel` keeps an open terminal from being cut after the server timeout.

NetScaler (Citrix ADC): a load-balancing virtual server of type SSL with your certificate, and
an HTTP service to the manager's `HTTP_PORT`. The pieces that matter here:

```
add ns httpProfile mtm_http -webSocket ENABLED
add service mtm_svc 10.0.0.20 HTTP 80 -cip ENABLED X-Forwarded-For -svrTimeout 300
add lb vserver mtm_vs SSL 203.0.113.10 443 -httpProfileName mtm_http -cltTimeout 300
bind lb vserver mtm_vs mtm_svc
bind ssl vserver mtm_vs -certkeyName mtm_cert
add rewrite action mtm_xfp insert_http_header X-Forwarded-Proto "\"https\""
add rewrite policy mtm_xfp_pol true mtm_xfp
bind lb vserver mtm_vs -policyName mtm_xfp_pol -priority 100 -type REQUEST
```

NetScaler connects to the manager from its subnet IP (SNIP), not the virtual server's address,
so that's the address for `TRUSTED_PROXIES`.

## Updating and image versions

Images are published to GHCR only after CI has passed on that commit:
`ghcr.io/2gt-media-group-llc/mikrotik-manager-backend` and `…-nginx`. Each is tagged
`latest`, its version (for example `0.24.37-beta`) and `sha-<commit>`. To stay on a
version, replace `latest` with the version tag in `docker-compose.ghcr.yml`.

**Update the compose file too, not only the images.** `docker compose pull` fetches new images
but leaves your compose file as it was, and some releases add settings that only work if the
compose file passes them to the containers. A setting in `.env` that the compose file doesn't
mention never reaches the container, silently. For example, `TLS_MODE` and `TRUSTED_PROXIES`
([Behind a reverse proxy](#behind-a-reverse-proxy)) need the compose file from 0.46.0 or later;
with an older one, the manager stays in HTTPS mode and a proxy in front of it loops on
redirects. So when updating:

- from a git checkout: `git pull`, then `docker compose pull && docker compose up -d`;
- with only the GHCR compose file: download `docker-compose.ghcr.yml` again (keep your `.env`),
  then pull and start as above.

To check that a setting arrived, ask the container: `docker compose exec nginx printenv TLS_MODE`.

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
