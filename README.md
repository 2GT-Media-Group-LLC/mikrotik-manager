<h1 align="center">MikroTik Manager</h1>

<p align="center">
  <strong>A self-hosted control plane for your entire MikroTik fleet.</strong><br>
  Monitor, configure, and safely change routers, switches, and access points — from one web interface.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.23.3_Beta-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-AGPLv3-blue" alt="License" />
  <img src="https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/built%20with-Claude%20AI-blueviolet?logo=anthropic&logoColor=white" alt="Built with Claude" />
</p>

<p align="center">
  <img src=".github/images/Dashboard.png" alt="MikroTik Manager Dashboard" width="100%" />
</p>

---

## Contents

- [What it is](#what-it-is)
- [What makes it different](#what-makes-it-different)
- [Screenshots](#screenshots)
- [Get running in five minutes](#get-running-in-five-minutes)
- [Features](#features)
  - [Safety and change protection](#safety-and-change-protection)
  - [Monitoring and operations](#monitoring-and-operations)
  - [Switching, VLANs and wireless](#switching-vlans-and-wireless)
  - [Firewall and network services](#firewall-and-network-services)
  - [Visibility and troubleshooting](#visibility-and-troubleshooting)
  - [Fleet operations](#fleet-operations)
  - [Access control and platform](#access-control-and-platform)
- [Reference](#reference)
- [Contributing](#contributing)
- [License](#license)

---

## What it is

MikroTik Manager gives a whole fleet of RouterOS devices a single management surface: live monitoring,
client tracking, VLAN and wireless configuration, firewall management, firmware rollouts, backups, and
traffic analytics — without logging into WinBox on each box in turn.

It runs entirely on your own hardware via Docker Compose, talks to devices over the RouterOS API (and
SSH where RouterOS requires it), and stores nothing outside your network.

---

## What makes it different

Plenty of tools can *show* you a MikroTik fleet. The hard part is **changing** one safely.

### RouterOS will happily lock you out of your own device

RouterOS applies every command immediately and independently. There is no transaction, no rollback,
and no cross-object validation — so it will accept a change that severs the very path you are managing
it over. MikroTik's own documented advice for enabling VLAN filtering is, literally, to have a serial
console ready.

That is the problem this project takes seriously. Three layers address it, and they are the reason
this platform exists rather than another dashboard.

### 🛡️ Change Guard — the device rescues itself

Before applying a risky change, the device saves a restore point and arms a scheduler to reapply it.
The change goes in, then reachability is proven **on a brand-new connection**. Confirmed, and the
scheduler is disarmed. Unreachable, and the device restores itself and comes back — unattended, with
nobody driving to the site.

Verified end to end on a CRS running RouterOS 7.23.3 by deliberately deleting a switch's own
management address:

```
T+0      restore point saved, revert scheduler armed, change applied
T+0s     device drops off the network
T+40s    manager gives up after 4 fresh connection attempts and reports back
T+120s   device restores its own backup and reboots
T+3m     device is back, change undone, scheduler and restore point gone
```

It runs entirely over the RouterOS API, so it works on devices with no SSH credentials configured, and
it covers twelve change types — bridge VLAN filtering, port PVID and tagging, bridge VLAN add/update/
delete, IP address add/remove, route add/remove, bond create/delete, and management service toggles.

### 🔮 Lockout prediction — a warning that names the actual mechanism

Rather than blocklisting operations someone once thought were dangerous, the platform reads live device
state, works out how the manager actually reaches the device, simulates your change against it, and
reports any invariant that flips from satisfied to violated.

The ingress port comes from the bridge forwarding table and the manager's own address from the device's
connection tracking, so the warning is specific enough to act on:

> **This change is predicted to cut management access to 2GT-NW-100G.**
> Management arrives untagged on `sfp28-1` (PVID 1) — the gateway's MAC is learned there — but VLAN 1
> has no bridge VLAN entry listing `bridge1` as an untagged member.

A predicted lockout is refused outright. Overriding a critical verdict means typing the device name,
and the change still runs under Change Guard.

### 🩺 Config Health — finds what RouterOS accepted but never applied

A standing, read-only audit for configurations RouterOS takes without complaint and then quietly
ignores. It encodes MikroTik's documented Layer 2 misconfigurations — an IP address or VLAN interface
on a bridge slave port, a bond slave that is also a bridge port, MTU above L2MTU, a PVID that
`frame-type=admit-only-vlan-tagged` renders inert, management surviving only on a dynamic VLAN entry,
and more.

Every finding explains what it does to your network, how to fix it, how long it has been there, and
links the relevant MikroTik documentation.

### And the rest of the toolbox

|  | |
|---|---|
| **Staged firmware rollouts** | Canary waves, pre-upgrade backup, reboot verification, and halt-on-failure so a bad build never reaches the fleet |
| **Built-in NetFlow collector** | Traffic analytics with per-client attribution and application breakdown — no external collector to run |
| **CAPsMAN aware** | Centrally provisioned APs are recognised, grouped under their controller, and protected from local writes the controller would discard |
| **Rogue AP detection** | A foreign BSSID broadcasting one of your SSIDs is flagged as an evil twin |
| **Anomaly insights** | Client counts and CPU compared against each device's own same-hour 14-day baseline, not a fixed threshold |
| **Enterprise auth** | OIDC/SSO, TOTP two-factor, role-based access, and scoped API tokens |

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src=".github/images/Device%20List.png" alt="Device List" /><br>
      <sub><b>Device list</b></sub>
    </td>
    <td align="center" width="50%">
      <img src=".github/images/Device%20Overview.png" alt="Device Overview" /><br>
      <sub><b>Device overview</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src=".github/images/Device%20Ports.png" alt="Switch Ports" /><br>
      <sub><b>Switch ports &amp; throughput</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Device%20Hardware.png" alt="Hardware Monitor" /><br>
      <sub><b>Hardware monitor</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src=".github/images/Topology.png" alt="Network Topology" /><br>
      <sub><b>Network topology</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Device%20Wireless%20Radio.png" alt="Wireless Radio Management" /><br>
      <sub><b>Wireless radios</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src=".github/images/Clients.png" alt="Client List" /><br>
      <sub><b>Client tracking</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Client%20Details.png" alt="Client Details" /><br>
      <sub><b>Client detail</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src=".github/images/Events.png" alt="Event Log" /><br>
      <sub><b>Event log</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Backups.png" alt="Backup Management" /><br>
      <sub><b>Backups</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src=".github/images/Login%20Page.png" alt="Login Page" width="70%" /><br>
      <sub><b>Sign-in, with optional SSO and two-factor</b></sub>
    </td>
  </tr>
</table>

---

## Get running in five minutes

You need [Docker](https://docs.docker.com/get-docker/) with Compose v2, and MikroTik devices running
**RouterOS 6.x or 7.x** reachable on their API port (`8728`, or `8729` for API-SSL).

### Option A — pre-built images (recommended)

No source checkout, no build toolchain.

```bash
# 1. Grab the compose file and environment template
curl -O https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/docker-compose.ghcr.yml
curl -O https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/.env.example
mv .env.example .env

# 2. Set your domain in .env (secrets auto-generate if you leave them unset)
#    CORS_ORIGIN=https://manager.example.com

# 3. Start
docker compose -f docker-compose.ghcr.yml up -d
```

Open **https://localhost** (or your server's hostname) and sign in with `admin` / `admin`.
**Change that password immediately** under Settings → Users.

> **Updating:** `docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d`

### Option B — build from source

```bash
git clone https://github.com/2GT-Media-Group-LLC/mikrotik-manager.git
cd mikrotik-manager
cp .env.example .env       # edit CORS_ORIGIN for production
docker compose up -d
```

First run builds the frontend and backend, initialises PostgreSQL and InfluxDB, and generates a
self-signed TLS certificate. Accept the browser warning, or upload a real certificate under
**Settings → TLS Certificate**.

> **Updating:** `git pull && docker compose up -d --build backend nginx` — migrations run automatically on startup.

### If a device won't connect

API access is usually enabled already. If not:

```
/ip service enable api          # port 8728
/ip service enable api-ssl      # port 8729, TLS
```

Devices on the SSL port are reached over TLS automatically — RouterOS's default self-signed
certificates are accepted, so credentials are encrypted in transit with no manual trust step.

---

## Features

### Safety and change protection

The layers described [above](#what-makes-it-different), plus the surrounding machinery.

- **Change Guard** — device-side auto-revert on twelve change types, over the RouterOS API, no SSH required
- **Lockout prediction** — live-state simulation that refuses a change predicted to sever management, with the hop chain that explains why
- **Config Health** — scheduled audit for RouterOS's documented Layer 2 misconfigurations, surfaced on the device's Security tab and in the dashboard
- **Firewall lockout guard** — refuses an unscoped `input`-chain drop/reject that would lock you out, requiring explicit confirmation
- **CAPsMAN write protection** — a provisioned radio is owned by the controller, so local SSID creates, edits and deletes are refused rather than silently discarded
- **Capability probe** — `POST /api/devices/:id/change-guard/probe` reports what safety mechanisms a device actually supports, tested rather than assumed, and leaves nothing behind
- **Guard history** — every protected change recorded per device as `committed`, `reverted`, or `failed`

<details>
<summary><b>What you see when auto-revert fires</b></summary>

<br>

The request returns **HTTP 200** with `guard.auto_reverting: true` and *"Contact with the device was
lost while applying this change. It is restoring itself and should come back shortly."* — not an error.

This matters: the most dangerous changes sever the very connection carrying them, so the API call times
out even though the change succeeded on the device. **Reachability, not the exception, decides the
outcome.** A change that throws while the device is still reachable is a genuine failure, and the guard
is disarmed immediately so nothing reboots for nothing.

Two consequences worth knowing before relying on it:

- **Binary mode reboots the device** to restore. That is the price of a restore that recovers deleted
  interfaces exactly. Script mode (`/export` + `/import`) avoids the reboot but is additive, so it
  cannot recover a deletion.
- **The restore point is saved before the scheduler is armed**, so a rollback returns a configuration
  containing neither the scheduler nor the change. Self-cleaning, and a revert loop is impossible.

</details>

### Monitoring and operations

- **Live dashboard** — device counts, wireless clients, active alerts, fleet-wide 30-day availability, device-type distribution, firmware notifications, and a historical client graph (1h → 30d)
- **Operations view** — a second dashboard mode built for running the network:
  - **Things to handle** — a server-side insights engine, severity-ordered: offline devices, pending firmware, CPU/memory pressure, missing backups, connectivity flapping, WiFi quality problems, and Config Health findings
  - **Quick actions that actually run** — discovery, back up all online devices, sync config, or open an in-browser SSH terminal, each with inline progress
  - **Capacity &amp; health** — per-device CPU and memory meters sorted by pressure
  - **Security posture rollup** — fleet hardening score and the lowest-scoring devices
  - **Anomaly insights** — each device's last 30 minutes of client count and CPU compared against its **own same-hour-of-day 14-day baseline**, flagging ≥2.5σ deviations plus error-log bursts
- **Availability tracking** — per-device uptime %, outage count, and longest outage over 30 days
- **Alerts** — device up/down, CPU/memory thresholds, certificate expiry, firmware available, log errors and warnings, new device discovered, and config drift, each with cooldowns
- **Delivery channels** — Email, Slack, Discord, Telegram, and **ntfy** (self-hosted or `ntfy.sh`, with severity mapped onto ntfy priority so outages break through do-not-disturb and recoveries stay quiet)
- **Maintenance windows** — one-time or recurring (cron) windows per device that suppress alerts automatically

### Switching, VLANs and wireless

- **VLAN management** — create, edit and delete VLANs; per-port membership with tagged/untagged control
- **Per-port connected clients** — selecting a port shows who is *physically* on it. Uplink and trunk ports are auto-detected (via an LLDP/MNDP neighbour, MACs spanning multiple VLANs, or a high MAC count) and show an explainer rather than every MAC reachable through them, with one-click disclosure of the full table
- **Copy VLANs between switches** — a three-step wizard with click-to-cycle port assignment, conflict detection, and a review summary before anything is applied
- **Wireless management** — SSID create/edit/enable/disable/delete, bulk SSID deployment across APs, WPA2/WPA3 security profiles, and support for both the RouterOS 7 `wifi` package and the legacy `wlan` package
- **RF Health** — channel usage across 2.4/5/6 GHz with co-channel overlap highlighting, AP deployment density plotted against RSSI, TX-retry histograms, and a connectivity funnel (association → authentication → DHCP) derived from device logs
- **Spectral and AP scans** — scheduled or on demand, per radio
- **Rogue &amp; neighbour AP detection** — stored scan results cross-referenced against your own SSIDs and radio MACs; a foreign BSSID broadcasting your SSID is flagged as an evil twin
- **Device fingerprinting** — every client classified into a category (server, computer, phone, TV, camera, printer, console, IoT…) from OUI and hostname, overridable per client and persistent across polls
- **CAPsMAN** — role detection (standalone / CAP / controller / controller-with-local-radios), provisioned interfaces labelled with their controller, and a controller panel grouping every AP with its radios, live channel, provisioned SSID and client counts. CAPs are matched to managed devices by radio MAC — hardware identity, so it cannot confuse two devices on two segments. Read-only for now; see [CAPsMAN scope](#capsman-scope)
- **Guest WiFi** — a guided wizard that builds a full captive portal in one pass: guest SSID on every radio, VLAN segregation, IP pool, DHCP, hotspot profile, bandwidth-limited user profile and optional NAT. Plus batch vouchers with printable 3-up sheets, a live guests-online table, and an inline walled garden

### Firewall and network services

A Meraki/UniFi-grade firewall experience on the full RouterOS feature set.

- **Security Center** — fleet-wide hardening scores, per-device posture, and a "Common Findings" rollup aggregating identical issues across every device
- **Friendly rule builder** — action chips, address and address-list pickers, well-known port presets, connection-state chips, per-rule logging, and a plain-English preview of every rule
- **Address lists as reusable objects** — define `LAN`, `Trusted`, `Blocklist` once and reference them anywhere
- **Rule reordering** — order is decisive in RouterOS; move rules with one click
- **Hit counters** — per-rule packet and byte counts surface which rules match and flag dead ones
- **NAT wizards** — guided Port Forward, Masquerade and 1:1 NAT flows, plus a Custom mode
- **Security posture audit** — per-device hardening checklist with a score and one-click remediation
- **Bandwidth control** — simple queues per IP, subnet or interface, with a one-click "limit this client"
- **Active connections** — live connection-tracking table with search

Each network service supports multi-device management with conflict detection:

| Service | Capabilities |
|---|---|
| **DHCP** | IPv4 &amp; IPv6 servers, address pools, static leases, live lease table |
| **DNS** | Upstream servers, static records (A/AAAA/CNAME/MX/NS/PTR/TXT/SRV), cache flush, DoH |
| **NTP** | Server (broadcast/manycast), client (unicast/multicast), sync status |
| **WireGuard** | Interface management, peer configuration, public keys, RX/TX stats |
| **Logging** | Syslog actions and routing rules, single-device or push-to-all with per-entry coverage |
| **NetFlow** | One-toggle Traffic Flow export per device, pointed at the built-in collector |
| **Discovery &amp; SNMP** | Fleet-wide LLDP toggle and SNMP v1/v2c/v3, scoped to all devices, routers, or switches |

### Visibility and troubleshooting

- **Network topology** — auto-discovered from LLDP, CDP and MNDP, with LLDP treated as ground truth and lower-priority protocols suppressed for the same neighbour. Bidirectional pairs merge into one edge with both port names. Neighbours are resolved to managed devices by MAC before IP, because a MAC is unique fleet-wide and an address is not
- **Manual links** — drag between any two devices to record a connection discovery cannot see; stored persistently and drawn as purple dashed edges
- **Orphan detection** — devices with no known connections are grouped with a prompt to link them
- **Traffic analytics** — a built-in NetFlow v9/IPFIX collector on UDP 2055, per-client attribution, application breakdown (HTTPS, QUIC, DNS, SSH, email, WireGuard…), top talkers over 1h → 30d, automatic deduplication when a flow crosses two managed routers, and NAT-tolerant ingest for routers exporting from behind NAT or a VPN subnet router
- **Configuration history** — snapshots of each device's full `/export`, deduplicated by content hash so only real changes are stored, with side-by-side line diffs, a change summary, and **one-click rollback** through the proven restore path
- **Audit log** — every authenticated write recorded with user, timestamp, method, path, entity, IP and response status
- **Global search** — devices, clients and events from the top bar
- **Per-device tools**:

| Tool | Description |
|---|---|
| **Ping** | ICMP reachability with RTT and loss |
| **Traceroute** | Hop-by-hop path trace |
| **IP Scan** | ARP sweep of a subnet to find live hosts |
| **Wake-on-LAN** | Magic packet sent from the MikroTik device |
| **Packet Capture** | RouterOS sniffer for 5–60s, downloaded as a `.pcap` for Wireshark (requires SSH) |
| **Bandwidth Test** | Throughput between two devices; the target's test server is enabled and disabled automatically |

### Fleet operations

- **Firmware orchestration** — fleet version overview, live update checks, and MikroTik's official release notes in-app. Staged rollouts run in **waves** (wave 1 = canary) through a verified pipeline per device: pre-upgrade backup → install → ride out the reboot → confirm it returned healthy on the new version → next. **Halt on failure** stops the rollout if any device fails, and a device that comes back on the *old* version counts as a failure. Rollouts can be scheduled, and cancelling never interrupts an in-flight flash
- **Backups** — on demand or on a daily/weekly/monthly schedule for all online devices, downloadable from the UI. Config snapshots and their restorable `.rsc` are one artifact: delete either and both go, so they never drift apart
- **Configuration templates** — reusable sets (DNS, NTP, syslog) pushed to many devices with per-device result reporting
- **Bulk device add** — "Try All" on discovered devices runs as a server-side job that survives a closed browser tab, with live progress and cancel
- **Device organisation** — colour-coded tags, rack location, physical address with map support, and per-device notes

### Access control and platform

- **Roles** — Admin, Operator (read/write), Viewer (read-only)
- **Two-factor authentication** — per-user TOTP via QR code, required at login once enabled
- **Single sign-on (OIDC)** — any standards-compliant provider (Entra ID, Okta, Google Workspace, Keycloak, Authentik…), with group-to-role mapping, auto-provisioning, and local login retained as break-glass. Configured entirely in the UI — see [Single sign-on setup](#single-sign-on-oidc)
- **Scoped API tokens** — `mtm_…` tokens with read or write scope and optional expiry, shown once and stored only as a SHA-256 hash. No token can perform admin actions or manage other tokens
- **Outbound webhooks** — subscribe to any of twelve events, delivered as HMAC-SHA256-signed JSON POSTs through the same pipeline that respects alert rules, cooldowns and maintenance windows
- **Scheduled email reports** — daily, weekly or monthly HTML fleet summaries to any recipient list
- **Credential presets** — shared device credentials, optionally restricted to admins only
- **Encryption at rest** — device passwords encrypted with AES-256-GCM under a [self-healing key](#secret-management-self-healing)
- **TLS** — self-signed certificate generated on first run, replaceable via the Settings UI; nginx terminates TLS and redirects HTTP

---

## Reference

### Environment variables

Set in `.env`. Both secrets auto-generate on first boot if you leave them unset.

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *auto-generated &amp; persisted* | Signs session tokens. Set it to pin your own value. |
| `ENCRYPTION_KEY` | *auto-generated &amp; persisted* | Encrypts device passwords at rest. Set it to pin your own value. |
| `CORS_ORIGIN` | *localhost defaults* | Comma-separated browser origins allowed to call the API. **Required in production.** |
| `DB_PASSWORD` | `mikrotik_secure_pw` | PostgreSQL password |
| `INFLUXDB_TOKEN` | `mytoken123456789` | InfluxDB admin token |
| `INFLUXDB_ORG` | `mikrotik-manager` | InfluxDB organization |
| `INFLUXDB_BUCKET` | `metrics` | InfluxDB bucket for time-series data |
| `INFLUXDB_ADMIN_PASSWORD` | `admin_password_123` | InfluxDB admin UI password |
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |

> Never commit `.env`. It is already in `.gitignore`.

### Change Guard and Config Health settings

These live in the Settings UI rather than `.env`, so they apply without a restart.

| Setting | Default | Description |
|---|---|---|
| `change_guard_enabled` | `true` | Master switch. When off, guarded changes still apply — with no safety net and no lockout refusal. |
| `change_guard_mode` | `binary` | `binary` = `/system backup` restore; recovers deletions exactly, **reboots the device**. `script` = `/export` + `/import`; no reboot, but additive, so it cannot undo a deletion. |
| `change_guard_timeout_sec` | `120` | How long the device waits before rescuing itself. Must exceed the manager's verification window (~40s) with margin for a slow device. |
| `config_health_enabled` | `true` | Runs the standing configuration audit. |
| `config_health_interval_min` | `60` | Audit cadence per device — one read-only snapshot over the API. |

Overriding a predicted lockout is deliberate by design: the API requires `confirm_lockout: true` and the
UI requires typing the device name. The change then runs under Change Guard regardless, so an override
is a decision to *rely on* auto-revert — not to bypass protection.

### CAPsMAN scope

Provisioning, configuration edits and interface enable/disable are **deliberately not exposed**. A
CAPsMAN configuration applies to every access point bound to it simultaneously, which is the fleet-wide
version of the failure Change Guard exists to prevent. Those operations are held back until they carry
the same prediction-and-revert protection that per-device changes do.

Legacy `/caps-man` (the pre-RouterOS 7 controller) is a separate API tree and is not covered yet.

### Secret management (self-healing)

`JWT_SECRET` and `ENCRYPTION_KEY` are managed automatically:

- **Set to a strong value in the environment** — that value is used, and you stay in control.
- **Unset or left at an old default** — the backend generates a strong secret once, persists it to the
  `app_data` volume (`SECRETS_DIR`, default `/app/data`), and reuses it every boot. Secrets live outside
  the database, so a database dump alone cannot reveal the key protecting the credentials inside it.

Upgrades are non-breaking. Existing ciphertext is decrypted via a **legacy-key fallback** (including
previous defaults) and transparently re-encrypted under the current key by a background sweep. Rotating
the JWT secret off a public default invalidates sessions signed with it — users simply log in again.

**Key rotation:** set a new `ENCRYPTION_KEY` (or delete the persisted secret to force regeneration) and
restart. Old rows keep decrypting via the fallback and are re-encrypted forward automatically. **If the
persisted secret and every prior key are lost**, ciphertext under that key cannot be recovered — re-enter
device credentials or restore a backup.

### Single sign-on (OIDC)

Authorization Code flow with PKCE. The server validates the ID token (JWKS signature plus `iss`, `aud`,
`exp`, `nonce`) and then issues the platform's normal session, so SSO users get the same experience as
local ones. **No environment variables or redeploy** — everything is configured in the UI, with the
client secret encrypted at rest.

**1. Register the app with your provider.** Create an OIDC web application and note its **Issuer URL**
(the base serving `/.well-known/openid-configuration`), **Client ID** and **Client Secret** — public
clients with no secret work too, via PKCE. Use this redirect URI:

```
https://<your-host>/api/auth/oidc/callback
```

**2. Configure it under Settings → SSO / OIDC.**

| Field | Purpose |
|---|---|
| **Issuer URL** | Your provider's base URL; **Test discovery** verifies reachability. |
| **Client ID / Secret** | From step 1. The secret is write-only; leave blank to keep the existing one. |
| **Scopes** | Default `openid profile email`. Add a groups scope if your IdP needs one. |
| **Username / Email / Groups claim** | Defaults `preferred_username`, `email`, `groups`. |
| **Group → role mapping** | Map IdP groups to admin / operator / viewer. Highest-privilege match wins. |
| **Default role** | For users matching no mapping (default **viewer**). |
| **Auto-provision** | Create a local user on first sign-in. |
| **Link by verified email** | Attach an SSO identity to an existing account when `email_verified` matches. |
| **Allowed email domains** | Optional allowlist. |
| **Button label** | Text on the login button, e.g. "Sign in with Okta". |

**Behaviour and safety:**

- **Provisioning** — first sign-in creates a user, or links to an existing local account when the
  verified email matches. SSO users have no local password.
- **Roles** are always resolved server-side from your mapping, and existing users are never silently
  demoted when a login carries no matching group.
- **Break-glass** — local login stays available, so the seeded admin can always get in even if the IdP
  is misconfigured or unreachable.
- **Behind a proxy** — the redirect URI derives from the request host; set **Public base URL** to pin it
  when your external URL differs from what the backend sees.

### Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **State / data** | TanStack Query v5, React Router v6, Zustand |
| **Charts / topology / maps** | Recharts, @xyflow/react, Leaflet |
| **Terminal** | xterm.js |
| **Backend** | Node.js, Express, TypeScript |
| **Primary DB** | PostgreSQL 15 |
| **Time-series DB** | InfluxDB 2.7 |
| **Cache / queue** | Redis 7, BullMQ |
| **Real-time** | Socket.IO |
| **Device comms** | RouterOS API (8728 / 8729), SSH2 |
| **Proxy** | nginx — TLS termination and static serving |
| **Container** | Docker Compose |

### Project structure

```
mikrotik-manager/
├── frontend/               # React + TypeScript (Vite)
│   └── src/
│       ├── pages/          # One component per route
│       ├── components/     # Shared UI
│       ├── services/       # API client (Axios)
│       ├── hooks/          # Custom React hooks
│       └── types/          # TypeScript definitions
│
├── backend/                # Node.js + Express + TypeScript
│   └── src/
│       ├── routes/         # REST API handlers
│       ├── services/       # Polling, alerts, backups, orchestration
│       │   ├── mikrotik/   # RouterOS API client and device collector
│       │   ├── changeGuard/# Auto-revert, lockout prediction, Config Health
│       │   └── topology/   # Neighbour graph construction
│       ├── db/             # Schema and migrations
│       ├── config/         # Database, InfluxDB, Redis connections
│       ├── middleware/     # Auth, audit logging, error handling
│       └── utils/          # Crypto, OUI lookup, VLAN parsing
│
├── nginx/                  # Reverse proxy config and Dockerfile
├── docker-compose.yml      # Build from source
├── docker-compose.ghcr.yml # Pre-built images
└── .env.example
```

---

## Contributing

Contributions are welcome. Please open an issue before submitting a pull request so we can discuss the
approach — several recent features started as exactly that conversation.

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit your changes
4. Push and open a pull request

---

## License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE) for the full text.

- You are free to use, modify and distribute this software.
- If you run a modified version as a network service, you **must** make your modified source available
  to users of that service under the same license.
- Distributed copies and derivatives must also carry AGPLv3.

This license keeps improvements — including those deployed as a service — open and available.

---

## AI assistance

This project was designed and built with the help of [Claude](https://claude.ai) by Anthropic. AI
assistance was used throughout: architecture, backend services, frontend components, the CI/CD pipeline,
security configuration and unit tests.

We believe in being transparent about how software is made. The code is reviewed and tested with AI
assistance and maintained by the project authors.

---

## Disclaimer

Not affiliated with or endorsed by MikroTik. MikroTik and RouterOS are trademarks of SIA MikroTīkls.
Use at your own risk, and always test configuration changes outside production first.
