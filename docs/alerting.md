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
| `device_degraded` / `device_health_restored` | A power supply, fan or temperature problem appeared or cleared. See [Hardware health](devices.md#hardware-health) |

Alerts are suppressed for devices inside an active [maintenance window](#maintenance-windows).
Devices marked as [expected to go offline](devices.md#devices-that-go-offline-on-purpose)
only send an offline alert once they have been gone longer than their limit.

## Certificate expiry

Certificates on each device are read on the slow poll and checked hourly. The
`cert_expiry` rule decides the rest: its **threshold** is the warning window in days
(14 by default) and its **cooldown** how often you are told about the same certificate
(daily by default).

It is **off by default** — turn it on in Settings → Alerts.

Every certificate is tracked separately, so a device with an expiring CA and an expiring
client certificate raises two alerts rather than one. A certificate authority is named as
such, because its expiry invalidates everything it signed rather than one connection.

Three states raise an alert:

| State | Meaning |
|---|---|
| expired | Already past its date; anything relying on it is failing now |
| expiring | Inside the warning window |
| not yet valid | Validity starts in the future — usually a wrong device clock |

A fourth state is shown but deliberately **does not** alert:

| State | Meaning |
|---|---|
| revoked | Withdrawn by its issuer, whatever its dates say |

Revocation cannot be worked out from dates — a revoked certificate keeps a perfectly good
expiry — so it is read from the device and shown with the date it was withdrawn in place of a
countdown that would be true and useless. It does not alert because revoking is something you
did on purpose, and some revoked certificates cannot be deleted at all while a CA still
references them through a CRL. Alerting would mean a daily reminder of a decision you have
already made and cannot undo.

Every collected certificate is listed on the **device page** under System & Config, and
across the fleet on the **Security** page — with its expiry date, days remaining, key type,
and whether it is a certificate authority. Expiring and expired ones also appear on the
**Operations** dashboard.

Where a device has expired certificates, a **Hide expired** toggle appears above the list,
remembered separately for the device page and the fleet view. It exists for certificates that
cannot be removed — RouterOS refuses to delete one while a CA still references it — which
would otherwise sit permanently red with nothing to be done about them. Expired certificates
are shown by default and the hidden count stays visible, because they are the main thing this
feature exists to surface.

The state shown on those pages is decided by the server using the same function and the same
threshold that produce the alert, so a page cannot disagree with an email sent about the same
certificate.

!!! note "Alert history records deliveries, not events"
    `alert_history` is written when a channel accepts an alert. With no channels
    configured, an alert can fire, be logged to the server log, and leave no row. The
    server log line begins `[Certs]`.

## Delivery channels

Email, Slack, Discord, Telegram, **ntfy** and **Gotify**. Channels are configured under
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

### Gotify

For a self-hosted [Gotify](https://gotify.net) server.

| Field | Notes |
|---|---|
| **Server URL** | Required, e.g. `https://gotify.example.com` (a sub-path works too) |
| **App token** | In Gotify, create an application under **Apps** and copy its token |
| **Manager URL** | Optional. Makes each notification open the device it refers to |

The token is sent in the `X-Gotify-Key` header, not the URL, so it doesn't end up in proxy logs.

**Priority mapping.** Gotify's Android app treats 8 and above as high importance:

| Events | Priority |
|---|---|
| Device offline or degraded, log errors, CPU/memory pressure | **8** |
| Certificate expiry, config drift, firmware available | 5 |
| Recovery, new device discovered | 2 |

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
