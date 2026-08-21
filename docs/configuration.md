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
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |

> Never commit `.env`. It is already listed in `.gitignore`.

For a production deployment the only variable you genuinely must set is `CORS_ORIGIN`.
Both secrets generate themselves safely — see below.

## Secret management (self-healing)

`JWT_SECRET` and `ENCRYPTION_KEY` are managed automatically so that a fresh install is
secure by default and an upgrade never strands existing data.

- **Set to a strong value in the environment** — that value is used, and you stay in
  control.
- **Unset, or left at an old default** — the backend generates a strong secret once,
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

### Key rotation

Set a new `ENCRYPTION_KEY` (or delete the persisted secret to force regeneration) and
restart. Old rows keep decrypting through the fallback and are re-encrypted forward
automatically.

> **If the persisted secret and every prior key are lost**, ciphertext encrypted under
> that key cannot be recovered. Re-enter device credentials, or restore from a backup.

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

## TLS

A self-signed certificate is generated on first run. Replace it under
**Settings → TLS Certificate** by uploading a certificate and private key; nginx
terminates TLS and redirects HTTP to HTTPS.
