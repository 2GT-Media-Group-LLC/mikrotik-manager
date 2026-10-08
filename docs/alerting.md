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
| `cve_active` | A RouterOS version the fleet runs is affected by a CVE that's known to be exploited, or rated critical or high (from the [vulnerability list](security.md)). Off by default. Checked after the daily list refresh and as soon as the rule is turned on; each CVE and version is announced once. Uncertain matches don't alert |
| `log_error` / `log_warning` | An error or warning line newly read from the device's own log, from the last 15 minutes (one alert per poll for each; an older backlog read from a newly added device doesn't alert). Clock adjustments (`ntp change time`, `cloud change time`) are stored as info, not errors, and hidden on the Events page unless **Clock changes** is ticked |
| `device_discovered` | An unmanaged neighbour appeared via LLDP/CDP/MNDP |
| `config_drift` | The device's configuration changed (off by default) |
| `device_degraded` / `device_health_restored` | A power supply, fan or temperature problem appeared or cleared. See [Hardware health](devices.md#hardware-health) |
| `device_identity_changed` | A device's API-SSL certificate, SSH host key or serial number changed, so the manager stopped connecting to it (on by default). See [Certificate, host key and serial number pinning](security.md#certificate-host-key-and-serial-number-pinning) |
| `wireguard_stale` | A WireGuard peer's last handshake is older than the threshold, in minutes (default 15; off by default). WireGuard re-handshakes about every two minutes while traffic flows, so a much older handshake means the tunnel is down. Peers that have never connected, disabled peers and peers on a disabled interface are left out. Handshakes are read with the slow poll and checked every 5 minutes; the cooldown applies to each peer separately |
| `interface_errors` | Bad frames on a port: FCS, alignment, overflow and other receive errors, per minute, averaged over 5 minutes (default 10; off by default). Usually a failing optic or cable while the link stays up. See [Interface errors and flapping](#interface-errors-and-flapping); the cooldown applies to each port separately |
| `interface_flapping` | A port's link went down at least the threshold number of times in the last hour (default 3; off by default). The cooldown applies to each port separately |
| `optic_degraded` | An optic's receive or transmit light is at least the threshold in dB away from the port's usual level, either way (default 3 dB; off by default), its receive light crosses an optional fixed limit, or the module is at 70 °C or more. See [Optic light levels](#optic-light-levels); the cooldown applies to each port separately |

Alerts are suppressed for devices inside an active [maintenance window](#maintenance-windows).
Devices marked as [expected to go offline](devices.md#devices-that-go-offline-on-purpose)
only send an offline alert once they have been gone longer than their limit.

### The manager's own sessions

Each poll signs in to the device, and backups, bulk commands and the terminal open SSH
sessions. RouterOS logs every one, so the manager would otherwise store and alert on its
own logins. These lines are left out of Events and log alerts:

- `user <account> logged in/out from <manager address> via api`, for the device's API
  account;
- `user <account> logged in/out from <manager address> via ssh`, for the manager's SSH
  account;
- `publickey accepted for user: <account>, fingerprint: ...` when the fingerprint is the
  key the manager deployed to that device, which nobody else holds.

The manager's address is learned from the device's list of active sessions. Until it's
known, the login lines are kept. Anyone else's login, including with the same account from
another address, is always kept.

## Interface errors and flapping

A failing optic, a dirty or damaged patch cable, or a problem at the far end often keeps
the link up while it corrupts frames, so link state alone misses it (#249). Every fast
poll (30 seconds) reads each Ethernet port's error counters and link-down count, and keeps
only the intervals in which they grew, for a week.

- **Counted:** FCS errors, alignment errors, receive overflow (a full receive buffer, which
  is congestion rather than a bad link), and other physical-layer errors (fragments,
  jabber, code, carrier, runts, late collisions). Oversized frames aren't counted; they
  point to an MTU mismatch, not a bad link. Not every model reports every counter.
- **Rates, not totals:** errors from before the manager started watching, or from a
  problem that has stopped, don't count. A counter that goes backwards (a reboot or a
  reset) only sets a new starting point.
- **On the Ports tab**, a port with errors in the last 15 minutes gets a yellow outline and
  a **!**. It turns red when it reaches the `interface_errors` rate or the
  `interface_flapping` count. Hovering gives the counts, and the port's info card shows the
  last hour broken down by kind.
- **On the dashboard**, the Operations list names the affected ports per device.

The markers use the alert rules' thresholds even when the alerts themselves are off, so
setting a threshold also sets where red begins.

RouterOS shows a port's FEC mode but keeps no count of corrected or uncorrected FEC
errors, so FEC error rates can't be watched. Errors that FEC can't correct still show up as
FCS errors.

## Optic light levels

Light that slowly fades is often the first sign of a failing optic, a dirty connector or a
damaged fibre, before any frames go bad. The slow poll (every 5 minutes) already reads
each SFP and QSFP port, and now keeps the optic's receive and transmit power, temperature,
bias current and supply voltage for two weeks. Copper DAC cables and modules without
diagnostics report none of these and are skipped.

What counts as low depends on the optic and the length of the link, so each port is
compared with **its own usual level**: the median of the past week, leaving out the last
hour so a fresh drop doesn't hide itself. A port needs about three hours of readings
before it's judged.

- **Red** when the light is at least the `optic_degraded` threshold away from usual, in
  either direction (3 dB by default), or the module is at 70 °C or more, the limit for
  commercial-grade optics. Light that drops usually means a dirty connector, a damaged
  fibre or an ageing laser; light that rises can mean a failing sensor in the optic,
  reflection off a damaged end face, or its power control misbehaving (#249).
- **Yellow** at half the threshold, or from 60 °C, which usually means poor airflow or a
  failed fan.
- **Optional fixed limits:** under Settings → Alerting, **Optic receive limits** sets a low
  and a high receive level (dBm). Crossing either turns the port red and alerts. They're off
  until set, because the right values depend on the optics: around -8 and +2 dBm suits 100G
  optics, but a 10G LR link runs fine near -12 dBm.
- On a multi-lane module (QSFP), the weakest lane counts, and the port card lists every
  lane.
- No light at all means the link is down, which the link-down and
  [flapping](#interface-errors-and-flapping) checks already report.

The port's info card on the Ports tab shows the light now, its usual level, how far below
it is, and a chart of the past week. Ports past the threshold are also listed on the
dashboard.

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

CAPsMAN's own certificates work the other way round. The ones it generates for itself and its
CAPs (named `CAPsMAN-CA-<mac>`, `CAPsMAN-<mac>` and `CAP-<mac>`, with a `WiFi-` prefix on the
newer wifi package) are valid until 2038 and
need no attention, so they're hidden by default; **Show CAPsMAN certificates (N)** lists them.
One that is no longer valid is always shown.

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
a channel without retyping them. They are stored encrypted with the same key as device
passwords (SMTP password, bot and app tokens, Slack and Discord webhook URLs), and decrypted
only to send. Channels saved before 0.24.50 are encrypted at the next start.

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
| Device offline or degraded, certificate or host key changed, log errors, CPU/memory pressure | **4** — breaks through do-not-disturb |
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
| Device offline or degraded, certificate or host key changed, log errors, CPU/memory pressure | **8** |
| Certificate expiry, config drift, firmware available | 5 |
| Recovery, new device discovered | 2 |

## Outbound webhooks

Subscribe any URL to seventeen events: device up/down, log errors and warnings, high CPU,
high memory, certificate expiry, device discovered, firmware update available, config drift,
firmware rollout completed/failed, hardware degraded/healthy again, a changed device
certificate or host key, a serious CVE affecting the fleet, and a stale WireGuard peer.

Deliveries are JSON `POST`s, **HMAC-SHA256 signed** in `X-MTM-Signature` when a secret is
set. The secret is stored encrypted. Last-delivery status is tracked per webhook and there is a Send-test button.

Webhooks fire through the same pipeline as other alerts, so they respect alert rules,
cooldowns and maintenance windows rather than bypassing them.

## Scheduled email reports

Daily, weekly or monthly (sent on the 1st) HTML fleet summaries to any recipient list, using the same SMTP
settings as email alerts. Each report covers devices online, outages and total downtime,
error and warning counts, updates pending, backups taken, and top clients by traffic.
Send-now is available for an immediate copy.

## Maintenance windows

Schedule planned downtime so alerts are held back automatically, rather than being muted
globally and forgotten. Managed under **Settings → Maintenance**.

- **Devices:** all devices, or the ones you tick. A window with no devices ticked covers
  every device.
- **Repeat:** just once, every day, or every week on the same day. A repeating window starts
  on the date you give and lasts as long as the first occurrence (end minus start); the time
  of day follows the manager's time zone (**Settings → General**).
- Windows can be disabled early and deleted.

Through the API a window can repeat on any cron expression (`recurring_cron`, five fields).

Before 0.24.37, windows made in the UI suppressed nothing: the form saved an empty device
list, which matched no device, and repeating windows only ever worked once.
