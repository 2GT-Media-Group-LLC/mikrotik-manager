# Alerting

[← Documentation index](README.md)

## Alert rules

Each rule can be enabled independently, with its own threshold where applicable and a
cooldown that prevents a flapping device from flooding your channels.

| Event | Notes |
|---|---|
| `device_offline` / `device_online` | Raised by the poller; recovery closes the outage record |
| `high_cpu` / `high_memory` | Configurable threshold |
| `cert_expiry` | Certificate approaching expiry |
| `firmware_update_available` | A newer RouterOS release exists for the device |
| `log_error` / `log_warning` | Matched from the device's own log |
| `device_discovered` | An unmanaged neighbour appeared via LLDP/CDP/MNDP |
| `config_drift` | The device's configuration changed (off by default) |

Alerts are suppressed for devices inside an active [maintenance window](#maintenance-windows).

## Delivery channels

Email, Slack, Discord, Telegram and **ntfy**. Channels are configured under
**Settings → Alerts → Channels**; secrets are masked on read and preserved when you save
a channel without retyping them.

### ntfy

Works with the public `ntfy.sh` or your own instance.

| Field | Notes |
|---|---|
| **Server URL** | Blank for `https://ntfy.sh`, or your own instance |
| **Topic** | Required |
| **Access token** | `tk_…`; preferred, since it can be scoped and revoked |
| **Username / password** | Basic-auth alternative |
| **Manager URL** | Optional — makes each notification tappable, opening the device it refers to |

Authentication is optional, but an unprotected topic means anyone who guesses the name
can publish to it, so use one of the two.

**Priority mapping.** Severity maps onto ntfy's 1–5 scale so the channel stays worth
being woken by:

| Events | Priority |
|---|---|
| Device offline, log errors, CPU/memory pressure | **4** — breaks through do-not-disturb |
| Certificate expiry, config drift, firmware available | 3 — default |
| Device recovery, new device discovered | 2 — low |

Each notification carries its event type as a **tag**, so a client can be filtered to
wake only for the events you care about rather than needing a channel per event.

## Outbound webhooks

Subscribe any URL to twelve events: device up/down, log errors, high CPU, high memory,
certificate expiry, device discovered, firmware update available, config drift, and
firmware rollout completed/failed.

Deliveries are JSON `POST`s, **HMAC-SHA256 signed** in `X-MTM-Signature` when a secret is
set. Last-delivery status is tracked per webhook and there is a Send-test button.

Webhooks fire through the same pipeline as other alerts, so they respect alert rules,
cooldowns and maintenance windows rather than bypassing them.

## Scheduled email reports

Daily, weekly or monthly HTML fleet summaries to any recipient list, using the same SMTP
settings as email alerts. Each report covers devices online, outages and total downtime,
error and warning counts, updates pending, backups taken, and top clients by traffic.
Send-now is available for an immediate copy.

## Maintenance windows

Schedule planned downtime per device, or across a group, so alerts are suppressed
automatically rather than being muted globally and forgotten.

- One-time or recurring (cron-based)
- Active windows can be deactivated early
- Managed under **Settings → Maintenance**
