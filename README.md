# MikroTik Manager

A self-hosted, full-stack network management platform for MikroTik devices. Monitor, configure, and manage your entire MikroTik infrastructure — routers, switches, and wireless access points — from a single web interface.

![Version](https://img.shields.io/badge/version-0.23.2_Beta-blue)
![License](https://img.shields.io/badge/license-AGPLv3-blue)
![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)
![Built with Claude](https://img.shields.io/badge/built%20with-Claude%20AI-blueviolet?logo=anthropic&logoColor=white)

---

## Screenshots

<p align="center">
  <img src=".github/images/Login%20Page.png" alt="Login Page" width="100%" />
</p>

<br>

### Dashboard

<p align="center">
  <img src=".github/images/Dashboard.png" alt="Dashboard" width="100%" />
</p>

### Device Management

<table>
  <tr>
    <td align="center">
      <img src=".github/images/Device%20List.png" alt="Device List" /><br>
      <sub><b>Device List</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Device%20Overview.png" alt="Device Overview" /><br>
      <sub><b>Device Overview</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src=".github/images/Device%20Ports.png" alt="Switch Ports" /><br>
      <sub><b>Switch Ports &amp; Throughput</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Device%20Hardware.png" alt="Hardware Monitor" /><br>
      <sub><b>Hardware Monitor</b></sub>
    </td>
  </tr>
</table>

### Wireless

<p align="center">
  <img src=".github/images/Device%20Wireless%20Radio.png" alt="Wireless Radio Management" width="100%" />
</p>

### Client Tracking

<table>
  <tr>
    <td align="center">
      <img src=".github/images/Clients.png" alt="Client List" /><br>
      <sub><b>Client List</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Client%20Details.png" alt="Client Details" /><br>
      <sub><b>Client Detail View</b></sub>
    </td>
  </tr>
</table>

### Network Topology

<p align="center">
  <img src=".github/images/Topology.png" alt="Network Topology" width="100%" />
</p>

### Events &amp; Backups

<table>
  <tr>
    <td align="center">
      <img src=".github/images/Events.png" alt="Event Log" /><br>
      <sub><b>Event Log</b></sub>
    </td>
    <td align="center">
      <img src=".github/images/Backups.png" alt="Backup Management" /><br>
      <sub><b>Backup Management</b></sub>
    </td>
  </tr>
</table>

---

## Features

### Dashboard
- Live KPI cards: total devices, online/offline count, connected wireless clients, active alerts, fleet-wide 30-day availability %
- Device type distribution chart
- Firmware update notifications with per-device details
- Historical client count graph (1h → 30d range)
- **Operations view** — a second dashboard mode focused on running the network:
  - **Things to handle** — a server-side insights engine that surfaces actionable issues across the fleet: offline devices, firmware/RouterBOOT updates, CPU/memory pressure, devices missing recent backups, connectivity flapping, and WiFi quality problems (weak-signal clients, co-channel overlap, high TX-retry radios), severity-ordered
  - **Quick actions that actually run** — Run discovery, Back up all online devices, Sync config (pull `/export` + re-collect), and Open terminal (device picker → live in-browser SSH terminal), each with inline progress/result
  - **Capacity & health** — per-device CPU/memory meters sorted by pressure
  - **Security posture rollup** — fleet average hardening score, high-severity finding count, and the lowest-scoring devices, deep-linking to the Security Center
  - **Recent activity feed** — merged config changes, user actions, and alerts
  - **Anomaly insights** (Mist-style) — compares each device's last 30 minutes of client-count and CPU against its **same-hour-of-day 14-day baseline** and flags ≥2.5σ deviations, plus error-log burst detection — surfaced alongside rogue-AP alerts in Things to handle

### Device Management
- Add, edit, and delete MikroTik devices (routers, switches, wireless APs)
- Automatic polling: status, model, firmware version, RouterOS version
- Firmware update availability detection
- Per-device notes, rack location, and physical address with map support
- Device credential encryption at rest
- **Encrypted API (api-ssl)** — devices whose API runs on the SSL port (8729) are reached over TLS automatically; RouterOS's default self-signed certificates are accepted, so the credentials and session are encrypted in transit without any manual certificate trust
- **Bulk device add** — "Try All" discovered devices runs as a server-side background job (survives browser tab close) with live progress and cancel support
- CPU load and historical sparkline displayed correctly for all device types, including hardware switches that report 0% CPU via ASIC offloading
- **Device tags** — colored labels for organizing and filtering devices; full tag management in Settings
- **30-day availability tracking** — per-device uptime %, outage count, and longest outage duration recorded automatically; visible on the device Overview tab and the fleet dashboard

### Routers
- Routing table viewer
- Interface overview with IP assignments
- Router-specific settings and configuration

### Firewall & Security
A Meraki/UniFi-grade firewall experience built on the full RouterOS feature set:
- **Dedicated Security Center** — a top-level section with fleet-wide hardening scores, a per-device posture list, and a "Common Findings" rollup that aggregates identical issues across every device; "Manage" deep-links into a device's Security tab. Firewall/NAT, bandwidth, and connections are available on every managed RouterOS device (routers, switches, and APs)
- **Friendly rule builder** — Allow/Drop/Reject action chips, Any/Address/Address-List source & destination pickers, well-known port presets (HTTPS/HTTP/SSH/DNS/RDP/SMB), connection-state chips, per-rule logging, and a live plain-English preview of every rule
- **Address lists as reusable objects** — define `LAN`, `Trusted`, `Blocklist` etc. once and reference them from any rule (the Meraki/UniFi "groups" concept)
- **Rule reordering** — move rules up/down (order is decisive in RouterOS) with a single click
- **Hit counters & dead-rule insight** — per-rule packet/byte counters surface which rules are matching and flag zero-hit rules; one-click counter reset
- **NAT wizards** — guided Port Forward, Masquerade (internet sharing), and 1:1 NAT flows instead of raw fields, plus a Custom mode
- **Safe-apply lockout guard** — refuses to apply an unscoped `input`-chain drop/reject that would lock the platform/admin out of the device, requiring explicit confirmation
- **Security posture audit** — per-device hardening checklist (insecure services like telnet/ftp/www/api, missing input-chain firewall, SNMP exposure, outdated RouterOS/RouterBOOT firmware) with a score and one-click remediation, plus a management-services table
- **Bandwidth control** — simple-queue management with up/down caps per IP, subnet, or interface, and a one-click "Limit this client" action on the client detail page
- **Active connections viewer** — live connection-tracking table (source/destination, protocol, state, rate, bytes) with search

### Lockout Protection & Config Health
RouterOS applies every command immediately and independently. There is no transaction and no
cross-object validation, so it will accept a change that severs its own management path — MikroTik's
documented advice for enabling VLAN filtering is literally to have a serial console ready. Three
layers close that gap:

- **Change Guard (device-side auto-revert)** — before a risky change, the device saves a restore
  point and arms a scheduler to reapply it. The change is applied, then reachability is proven on a
  brand-new connection. Confirmed → the scheduler is disarmed; unreachable → the device restores
  itself and comes back on its own. All over the RouterOS API, so it works without SSH credentials.
  Covers 12 change types: bridge VLAN filtering, port PVID/tagging, bridge VLAN add/update/delete,
  IP address add/remove, route add/remove, bond create/delete, and management service toggles
- **Lockout prediction** — rather than blocklisting "dangerous" operations (which only catches what
  someone thought of), the platform reads live device state, resolves the actual management path,
  simulates the proposed change against it, and reports any invariant that flips from satisfied to
  violated. The ingress port is taken from the bridge forwarding table and the manager's own address
  from the device's connection tracking, so the warning names the real mechanism: *"management
  arrives untagged on sfp28-1 (PVID 1) — the gateway's MAC is learned there — but VLAN 1 has no
  bridge VLAN entry listing bridge1 as an untagged member."* A predicted lockout is refused with a
  409 and an explanation of the hop chain; overriding a critical verdict requires typing the device
  name, and the change then runs under Change Guard anyway
- **Config Health (standing audit)** — a scheduled, read-only audit for configurations RouterOS
  accepted and will never complain about, encoding MikroTik's documented Layer2 misconfigurations:
  an IP address or VLAN interface on a bridge slave port, a VLAN interface added as a bridge port,
  a bond slave that is also a bridge port, MTU above L2MTU, a multi-VLAN bridge entry with untagged
  ports, several bridges competing for hardware offload, a port belonging to no VLAN on a filtering
  bridge, a PVID that `frame-type=admit-only-vlan-tagged` makes inert, and management that survives
  only on a dynamic VLAN entry. Each finding explains what it actually does to the network, how to
  fix it, how long it has been present, and links the MikroTik documentation. Findings appear on the
  device's Security tab and in the dashboard's "Things to handle"

- **Capability probe** — `POST /api/devices/:id/change-guard/probe` reports what safety mechanisms a
  device actually supports, tested on the device rather than assumed. Non-destructive: it creates and
  removes a harmless scheduler and leaves nothing behind. It also establishes whether `/system history`
  can revert a change without a reboot — on RouterOS 7.23 over the binary API, `/system/history/print`
  works and a bare `/undo` reverts the newest action, while `/system/history/undo` and `/undo numbers=`
  do not exist. Undo is therefore untargeted, and it cannot replace auto-revert (a dead-man switch has
  to fire once the manager has already lost contact), so binary restore remains the default

#### What you see when auto-revert fires

Verified end to end on a CRS running RouterOS 7.23.3, by deliberately deleting a switch's own
management address and letting the safety net recover it unattended:

```
T+0      restore point saved, revert scheduler armed, change applied
T+0s     device drops off the network
T+40s    manager gives up after 4 fresh connection attempts and reports back
T+120s   device restores its own backup and reboots
T+3m     device is back, change undone, scheduler and restore point gone
```

The request returns **HTTP 200** with `guard.auto_reverting: true` and *"Contact with the device was
lost while applying this change. It is restoring itself and should come back shortly."* — not an
error. This matters: the most dangerous changes sever the very connection carrying them, so the API
call times out even though the change succeeded on the device. Reachability, not the exception,
decides the outcome; a change that throws while the device is still reachable is a genuine failure
and is disarmed immediately so nothing reboots for nothing.

Two consequences worth knowing before you rely on it:

- **Binary mode reboots the device** to restore. That is the cost of a restore that recovers deleted
  interfaces exactly. Script mode (`/export` + `/import`) avoids the reboot but is additive, so it
  cannot recover a deletion.
- **The restore point is saved before the scheduler is armed**, so a rollback returns a configuration
  containing neither the scheduler nor the change. It is self-cleaning, and a revert loop is
  impossible.

Guard history is recorded per device in `device_change_guards`: `committed` (change kept),
`reverted` (device left to rescue itself), `failed` (change rejected, nothing applied).

Configure under **Settings → Change Guard** (`change_guard_enabled`, `change_guard_mode`,
`change_guard_timeout_sec`) and **Config Health** (`config_health_enabled`,
`config_health_interval_min`, default 60 minutes).

### Switches
- VLAN management (create, edit, delete VLANs)
- Per-port configuration and VLAN membership
- Switch overview with port status
- **Per-port connected clients** — selecting a port shows the clients actually connected to it (hostname, MAC, IP, VLAN, connection time) with links to each client's page. Crucially, it distinguishes *physically connected* clients from the raw MAC table: **uplink/trunk ports are auto-detected** (via an LLDP/MNDP topology neighbor, MACs spanning multiple VLANs, or a high MAC count) and show an "uplink" explainer instead of every MAC reachable through the port — with a one-click disclosure to view the full MAC table when you need it
- **Copy VLANs from another switch** — 3-step wizard that copies VLAN IDs and names from any other managed switch onto the current device, with manual per-VLAN port assignment (tagged/untagged) using a click-to-cycle interface chip grid, conflict detection with per-VLAN skip/overwrite control, and a review summary before any changes are applied

### Wireless
- Per-AP SSID management — create, edit, enable/disable, delete wireless interfaces
- **Bulk SSID deployment** — push an SSID configuration to all managed APs simultaneously
- Security profile management (WPA2/WPA3, PSK, EAP)
- Hardware radio information and band filtering (RouterOS 7 wifi package + legacy wlan package)
- Scheduled and on-demand **spectral scans** per radio
- Scheduled and on-demand **AP scans** (nearby access point discovery)
- Real-time radio monitoring
- Wireless client tracking with vendor lookup
- **Device fingerprinting** — every client is classified into a device category (server/NAS, computer, phone, TV, camera, printer, game console, voice assistant, smart-home, IoT, network gear…) from its OUI vendor and hostname, shown as an icon on the Clients list. The fingerprint is fully **overridable per client** on the client detail page, and the override persists across re-polls
- **RF Health** (fleet-wide on the Wireless page and per-AP on the Radios tab):
  - **Channel usage map** across 2.4 / 5 / 6 GHz, computed from each radio's operating channel (live-resolved from `monitor` on the wifi package when channels are auto), highlighting in-use channels and **co-channel overlap**
  - **AP deployment density** — connected clients plotted across the −90…−30 dBm signal scale, with a coverage-gap warning when too many clients connect at weak RSSI
  - **AP radio TX retries** histogram (0%→35%+) with a band selector, derived from per-client CCQ (legacy `wireless` driver)
  - **WiFi connectivity success** funnel (Association / Authentication / DHCP) derived from device logs
- **Rogue & neighbor AP detection** — cross-references stored AP-scan results against your own SSIDs and radio MACs. A foreign BSSID broadcasting one of *your* SSIDs is flagged as a **rogue / evil-twin** (and raised in Operations → Things to handle); everything else is a ranked neighbor-network inventory

### CAPsMAN
Access points provisioned centrally by CAPsMAN hold none of their own wireless configuration — the
controller owns it — so reading an AP directly returns blank SSID, security and band. The platform
now recognises that instead of showing an access point that looks broken:

- **Role detection** — each device is classified as standalone, CAP, controller, or controller-with-
  local-radios (a supported MikroTik arrangement) from `/interface/wifi/capsman` and `/interface/wifi/cap`
- **Provisioned interfaces are labelled** — a CAPsMAN badge on the Radios tab, and an explanation that
  the blank fields live on the controller, with the controller's MAC. SSID, mode and channel are
  recovered from RouterOS's status line where present
- **CAPsMAN panel on the Wireless page** — every controller with the access points it provisions,
  grouped per AP: radios, hardware type, live channel, provisioned SSIDs with client counts, named
  configurations, and the provisioning rules that bind them
- **CAPs are matched to managed devices by radio MAC**, taken from the controller's own
  `/interface/wifi/radio` list. A MAC is hardware identity and globally unique, so unlike an IP it
  cannot mean two devices on two segments. A CAP that is *not* in the fleet is surfaced rather than
  hidden, since that is usually why an AP appears to be missing
- **Controllers are no longer excluded** — the wireless section previously required
  `device_type = 'wireless_ap'`, which hid a dedicated controller (normally classified as a router)

**Read-only for now.** Editing a CAPsMAN configuration applies it to every access point bound to it
at once, so provisioning and config edits are deliberately not exposed until they carry the same
prediction-and-revert protection that device changes do. Legacy `/caps-man` (the pre-RouterOS 7
controller) is a separate API tree and is not covered yet.

### Guest WiFi (Hotspot)
A one-click captive-portal guest network on RouterOS Hotspot, under **Wireless → Guest WiFi**:
- **Guided setup wizard** — creates the whole guest network in one pass: a new **guest SSID** (a virtual AP on every physical radio), **VLAN segregation** (guest SSIDs tagged onto the bridge with an L3 VLAN interface for the portal — or a dedicated guest bridge when no VLAN is given), IP pool, DHCP, hotspot profile, portal server, a bandwidth-limited guest user profile, and an optional masquerade NAT rule. Idempotent, with honest warnings (e.g. bridge VLAN-filtering disabled). Can also target an existing interface.
- **Vouchers** — batch-generate access codes (`XXXX-XXXX`, no ambiguous characters) with validity hours, data caps, and a speed profile; **printable voucher sheets** (3-up cards with code, limits, and connection instructions) and a used/unused status table
- **Guests online** — live session table (code, IP, MAC, session time, down/up bytes) with one-click disconnect
- **Walled garden** — sites reachable before login, managed inline; per-server enable/disable

### Network Services
Each service supports multi-device management with conflict detection:

| Service | Capabilities |
|---|---|
| **DHCP** | IPv4 & IPv6 servers, address pools, static leases, live lease table |
| **DNS** | Upstream servers, static records (A/AAAA/CNAME/MX/NS/PTR/TXT/SRV), cache flush, DoH |
| **NTP** | Server (broadcast/manycast), client (unicast/multicast), sync status |
| **WireGuard** | Interface management, peer configuration, public key display, RX/TX stats |
| **Logging** | Syslog actions (remote/memory/disk/echo) and routing rules; single-device or push-to-all with per-entry coverage; enable/disable rules |
| **NetFlow** | One-toggle Traffic Flow (NetFlow v9/IPFIX) export per device, pointed at the built-in collector; live export status per device |
| **Discovery & SNMP** | Fleet-wide LLDP enable/disable and SNMP v1/v2c/v3 configuration with per-device status tables, scoped to all devices, routers only, or switches only |

### Traffic Analytics (NetFlow)
- **Built-in NetFlow/IPFIX collector** — receives Traffic Flow exports from your routers on UDP 2055 (no external tools needed); decoder supports both NetFlow v9 and IPFIX
- **Per-client usage accounting** — flows are attributed to known clients (IP → MAC) so every client shows real upload/download totals; "Data (today)" column on the Clients page and an App Traffic card on each client's detail page
- **Application breakdown** — flows are classified by protocol and port into readable categories (HTTPS, QUIC, DNS, SSH, Email, WireGuard, …) with fleet-wide and per-client views
- **Top talkers** — ranked client bandwidth usage over 1h/24h/7d/30d ranges on the dedicated Traffic page
- **Automatic deduplication** — a flow crossing two managed routers is exported twice; the collector keeps only the best exporter per client each window so totals are never double-counted
- **NAT-tolerant ingest** — when routers export from behind NAT or a VPN/Tailscale subnet router, packets arrive from an address that matches no managed device; the collector accepts these as per-source "unidentified" exporters (configurable) so flows are still attributed to clients instead of silently dropped, and the NetFlow page shows a banner naming the NAT'd source. Per-device export status/flow counters require un-NAT'd sources — exempt `udp/2055` from masquerade on the gateway to restore device identity (and exact cross-device dedup)
- **Fully UI-configurable** — enable the collector, set its address/port/version in the NetFlow page, then toggle export per device; the platform pushes `/ip traffic-flow` configuration to each router via the RouterOS API
- Configurable retention for detailed time-series (default 30 days) and daily rollups (default 365 days)

### Network Topology
- **LLDP-authoritative** — LLDP links are treated as ground truth; CDP/MNDP links to the same neighbor are automatically suppressed, eliminating spurious "Shared Segment" nodes
- Bidirectional LLDP pairs merged into a single canonical edge with both port names labeled
- Auto-discovered network map using LLDP, CDP, and MNDP neighbor data
- Interactive node graph with device type icons and protocol-priority link deduplication
- **Manual link drawing** — Connect Mode lets you drag between any two devices to draw a persistent connection for devices with no auto-discovered neighbors; connections are stored in the database and survive page reloads
- **Orphan node detection** — devices with no known connections are grouped in a dedicated row with an orange warning banner prompting Connect Mode usage
- Manual links render as purple dashed edges with a midpoint delete button

### Device Network Tools
Per-device diagnostic and testing tools accessible from the device detail Tools tab:

| Tool | Description |
|---|---|
| **Ping** | ICMP reachability test with RTT and loss metrics |
| **Traceroute** | Hop-by-hop path trace to any destination |
| **IP Scan** | ARP sweep of a subnet to discover live hosts |
| **Wake-on-LAN** | Send a magic packet from the MikroTik device to wake a host |
| **Packet Capture** | Start the RouterOS sniffer, capture for 5–60 seconds, download a `.pcap` file directly to your browser (opens in Wireshark). Requires SSH credentials on the device. |
| **Bandwidth Test** | Measure throughput between two devices. Select any managed device as the target — the bandwidth-test server is automatically enabled on the target before the test and disabled afterward. Manual IP mode available for non-managed targets. |

### Firmware Orchestration
Staged fleet-wide RouterOS upgrades, under the top-level **Firmware** section:
- **Fleet versions** — current RouterOS, latest-known version, and pending RouterBOOT upgrades per device; **Check all for updates** queries every online device live
- **Release notes in-app** — when an update is available, a "What's new" link on the device's firmware section (and the version on the Firmware page) opens MikroTik's official changelog for that exact version in a modal, with a link out to mikrotik.com
- **Staged rollouts in waves** — select updatable devices and assign each to a wave (wave 1 = **canary**); the orchestrator runs one rollout at a time, devices sequentially, through a verified pipeline: **pre-upgrade backup → install → ride out the reboot → verify it returned healthy on the new version → next device**
- **Halt on failure** stops the entire remaining rollout if any device fails, so a bad build never reaches the fleet; a reboot that comes back on the *old* version counts as a failure
- **Schedule** rollouts for a future time (pair with a maintenance window); live wave-grouped progress with animated per-device status, `from → to` versions, error detail, and **Cancel** (never interrupts an in-flight flash)

### Backups
- Trigger RouterOS backups on demand via SSH
- **Scheduled automatic backups** — pick a daily, weekly, or monthly schedule and time in Settings (no cron knowledge required); runs for all online devices
- Download and manage backup files from the UI

### Platform & Automation
Make the platform scriptable and integrable, under **Settings → Automation**:
- **Scoped API tokens** — issue `mtm_…` tokens with **read** or **write** scope and optional expiry for scripting and IaC; the token is shown once (only a SHA-256 hash is stored) and maps onto the role model — no token can perform admin actions or manage other tokens. Use with `Authorization: Bearer mtm_…` against the full REST API
- **Outbound webhooks** — subscribe URLs to any of 12 events (device up/down, log errors, high CPU/memory, cert expiry, device discovered, firmware update, config drift, firmware rollout completed/failed); deliveries are JSON POSTs **HMAC-SHA256 signed** (`X-MTM-Signature`) when a secret is set, with last-status tracking and a Send-test button. Fired through the same alert pipeline (respecting alert rules, cooldowns, and maintenance windows)
- **Scheduled email reports** — daily/weekly/monthly HTML fleet summaries (devices online, outages + downtime, error/warning counts, updates pending, backups taken, top clients by traffic) to any recipient list, using your Alerting SMTP settings; Send-now for instant delivery

### Configuration History
- Per-device config snapshots based on the device's full RouterOS `/export` — config-only, so counters and operational state never create noise — captured automatically whenever the configuration changes (deduplicated by content hash, so a snapshot is only stored on a real change)
- **Config History** tab on each device with a timeline of snapshots and a one-line summary of what changed (e.g. `+8 / −3 lines`)
- Side-by-side **line diff** between any two snapshots, rendered as readable RouterOS commands
- **Capture snapshot** button for an on-demand checkpoint, with honest feedback when nothing has changed since the last one
- **One-click rollback** — each snapshot links a restorable `.rsc` backup, so rolling back reuses the proven restore path
- The snapshot and its backup are one artifact: snapshot backups are clearly badged **Config Snapshot** on the Backups page, and deleting one (from either place) removes the other so they never drift apart
- Fires a `config_drift` alert (off by default) when a device's configuration changes
- Snapshot cadence and retention configurable via `config_snapshot_interval_min` / `config_snapshot_retention`

### Alerts
Configurable alert rules with cooldown periods:
- Device online / offline
- High CPU or memory usage (configurable threshold)
- SSL certificate expiry warning
- Firmware update available
- RouterOS log errors and warnings
- New device discovered
- Configuration changed (drift detection)

Alert delivery channels: **Email**, **Slack**, **Discord**, **Telegram**, **ntfy**

**ntfy** (`https://ntfy.sh` or your own instance) is configured with a topic and, optionally, an
access token or username/password — a publicly-writable topic lets anyone spoof your alerts, so
protecting it is worth the extra field. Alert severity maps onto ntfy's priority scale so the
notifications that mean something is *down* (device offline, log errors, CPU/memory pressure) arrive
at priority 4 and break through a phone's do-not-disturb, recoveries and discoveries arrive quietly
at 2, and everything else sits at the default 3. Each notification is tagged with its event type, so
a client can be filtered to wake only for the events you care about. Set the optional **Manager URL**
and notifications become tappable, opening the device they refer to.

### Maintenance Windows
- Schedule planned downtime windows per device or group of devices to suppress alerts automatically
- One-time or recurring windows (cron-based)
- Active window management with activate/deactivate controls
- Managed from Settings → Maintenance

### Audit Log
- Every write operation (create, update, delete, push) performed by an authenticated user is recorded automatically
- Log includes: user, timestamp, HTTP method, API path, entity type/ID, summary, IP address, and HTTP response status
- Filterable and paginated view in Settings → Audit Log
- Useful for multi-operator environments to track who changed what and when

### Configuration Templates
- Define reusable configuration sets (DNS servers, NTP servers, syslog host) and push them to one or more managed devices in a single operation
- Per-device result reporting (success / error per device)
- Managed from Settings → Config Templates

### Global Search
Instant search across devices, clients, and events from the top navigation bar.

### User Management & Access Control
- Role-based access: **Admin**, **Operator** (read/write), **Viewer** (read-only)
- Admin-only user creation and role assignment
- JWT authentication with secure session handling
- **Two-factor authentication (TOTP)** — per-user 2FA setup via QR code (compatible with Google Authenticator, Authy, etc.); login requires a 6-digit code after password when enabled; disable with password confirmation
- **Single sign-on (OIDC/SSO)** — authenticate against any standards-compliant OpenID Connect provider (Microsoft Entra ID, Okta, Google Workspace, Keycloak, Authentik, …). Auto-provisions or links users on first sign-in, maps IdP groups to platform roles, and coexists with local login as a break-glass fallback. Configured entirely in the UI — see [Single sign-on (OIDC)](#single-sign-on-oidc) below
- **Credential preset access control** — presets can be restricted to admins only (`allow_operator_use`); operators only see presets they are permitted to use when adding or updating devices

### TLS / HTTPS
- Automatic self-signed certificate generation on first run
- Upload a custom certificate and private key via the Settings UI
- nginx handles TLS termination and HTTP→HTTPS redirect

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **State / Data** | TanStack Query v5, React Router v6, Zustand |
| **Charts** | Recharts |
| **Topology** | @xyflow/react |
| **Maps** | Leaflet |
| **Terminal** | xterm.js |
| **Backend** | Node.js, Express, TypeScript |
| **Primary DB** | PostgreSQL 15 |
| **Time-series DB** | InfluxDB 2.7 |
| **Cache / Queue** | Redis 7, BullMQ |
| **Real-time** | Socket.IO |
| **Device comms** | RouterOS API (port 8728), SSH2 |
| **Proxy** | nginx (TLS termination, static file serving) |
| **Container** | Docker Compose |

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (v2+)
- MikroTik devices running **RouterOS 6.x or 7.x** with the API service enabled
- Network access from the host running this application to your MikroTik devices on port **8728** (or your configured API port)

---

## Quick Deploy (Pre-built Images)

No source code or build toolchain required — just Docker and Docker Compose.

### 1. Download the compose file

```bash
curl -O https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/docker-compose.ghcr.yml
```

### 2. Create your environment file

```bash
curl -O https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/.env.example
mv .env.example .env
```

Edit `.env` and set at minimum:

```env
JWT_SECRET=your_long_random_jwt_secret_here
ENCRYPTION_KEY=your_32_character_encryption_key_
CORS_ORIGIN=https://your-domain.example.com
```

### 3. Start the application

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

Docker pulls the pre-built images from GitHub Container Registry and starts the stack. No compilation, no cloning.

### 4. Open the app

Navigate to **https://localhost** (or your server's IP/hostname) and log in with `admin` / `admin`.

> To update to the latest release: `docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d`

---

## Quick Start (Build from Source)

For contributors or anyone who wants to build the images locally.

### 1. Clone the repository

```bash
git clone https://github.com/2GT-Media-Group-LLC/mikrotik-manager.git
cd mikrotik-manager
```

### 2. Configure environment variables

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

At minimum, change these values in `.env`:

```env
# Required — use long, random strings
JWT_SECRET=your_long_random_jwt_secret_here
ENCRYPTION_KEY=your_32_character_encryption_key_

# Required for production deployments (set to your domain)
# CORS_ORIGIN=https://manager.example.com

# Optional — defaults work for a local install
DB_PASSWORD=mikrotik_secure_pw
INFLUXDB_TOKEN=mytoken123456789
```

> **Security note:** Never commit your `.env` file to version control. The `.gitignore` already excludes it.

### 3. Start the application

```bash
docker compose up -d
```

The first run will:
- Build the frontend (React → static files)
- Build the backend (TypeScript → Node.js)
- Initialize PostgreSQL with the database schema
- Initialize InfluxDB
- Generate a self-signed TLS certificate

### 4. Open the app

Navigate to **https://localhost** (or your server's IP/hostname).

Accept the browser's self-signed certificate warning, or upload a real certificate in **Settings → TLS Certificate**.

### 5. Log in

Default credentials on first run:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | Admin |

**Change the default password immediately** in Settings → Users.

---

## Enabling the RouterOS API

Typically, API access is enabled on MikroTik devices. However if you can't connect via API, ensure the API service is enabled:

```
/ip service enable api
```

For API over SSL (port 8729):
```
/ip service enable api-ssl
```

The default API port is `8728`. You can configure a different port per device in the MikroTik Manager interface.

---

## Configuration Reference

All configuration is done via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *(auto-generated & persisted if unset)* | Secret for signing JWT tokens. Leave unset to have a strong one generated on first boot; set it to pin your own value. |
| `ENCRYPTION_KEY` | *(auto-generated & persisted if unset)* | Key for encrypting device passwords at rest. Leave unset to auto-generate; set it to pin your own value. |
| `CORS_ORIGIN` | *(localhost defaults set by Docker Compose)* | Comma-separated list of browser origins allowed to call the API (e.g. `https://manager.example.com`). **Required in production** — set this to your domain. |
| `DB_PASSWORD` | `mikrotik_secure_pw` | PostgreSQL password |
| `INFLUXDB_TOKEN` | `mytoken123456789` | InfluxDB admin token |
| `INFLUXDB_ORG` | `mikrotik-manager` | InfluxDB organization name |
| `INFLUXDB_BUCKET` | `metrics` | InfluxDB bucket for time-series data |
| `INFLUXDB_ADMIN_PASSWORD` | `admin_password_123` | InfluxDB admin UI password |
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |

### Change Guard & Config Health settings

These live in `app_settings` (Settings UI), not `.env`, so they can be changed without a restart:

| Setting | Default | Description |
|---|---|---|
| `change_guard_enabled` | `true` | Master switch. When off, guarded changes still apply but with no safety net and no lockout refusal. |
| `change_guard_mode` | `binary` | `binary` = `/system backup` restore; recovers deletions exactly, **reboots the device**. `script` = `/export` + `/import`; no reboot, but additive, so it cannot undo a deletion. |
| `change_guard_timeout_sec` | `120` | How long the device waits before rescuing itself. Must exceed the time the manager needs to verify reachability (~40s), with margin for a slow device. |
| `config_health_enabled` | `true` | Runs the standing configuration audit. |
| `config_health_interval_min` | `60` | Audit cadence per device. Each pass is a read-only snapshot over the API. |

Overriding a predicted lockout is a deliberate act: the API requires `confirm_lockout: true` in the
request body, and the UI requires typing the device name. The change then runs under Change Guard
regardless, so an override is a decision to rely on auto-revert rather than to bypass protection.

### Secret management (self-healing)

`JWT_SECRET` (session signing) and `ENCRYPTION_KEY` (AES-256-GCM credential encryption, `backend/src/utils/crypto.ts`) are managed automatically:

- **If set to a strong value in the environment**, that value is used — you stay in control.
- **If unset or left at an old default**, the backend generates a strong secret **once**, persists it to the `app_data` volume (`SECRETS_DIR`, default `/app/data`), and reuses it on every boot. Secrets live outside the database so a DB dump alone can't reveal the key protecting the credentials in it.

Upgrades are non-breaking: on startup, existing ciphertext is decrypted via a **legacy-key fallback** (including previous defaults) and transparently **re-encrypted under the current key** by a background sweep. When rotating the JWT secret off a public default, sessions signed with that default are no longer accepted — users simply log in again once.

**Key rotation:** set a new `ENCRYPTION_KEY` (or delete the persisted secret to force regeneration) and restart. Old rows keep decrypting via the legacy fallback and are re-encrypted forward automatically. **If the persisted secret and any prior key are both lost**, ciphertext under that key cannot be recovered — re-enter device credentials or restore a backup.

### Single sign-on (OIDC)

Sign in against any standards-compliant OpenID Connect provider (Microsoft Entra ID, Okta, Google Workspace, Keycloak, Authentik, and others). It uses the Authorization Code flow with PKCE; the server validates the ID token (signature via JWKS, plus `iss`/`aud`/`exp`/`nonce`) and then issues the platform's normal session — so SSO users get the same experience as local users. **No environment variables or redeploy are required** — everything is configured in the UI and stored (with the client secret encrypted at rest) in the database.

**1. Register the app with your identity provider.** Create an OIDC/OAuth "web application" and note its **Issuer URL** (the base that serves `/.well-known/openid-configuration`), **Client ID**, and **Client Secret** (public clients with no secret are also supported via PKCE). For the **redirect / callback URI**, use the value shown in the settings panel:

```
https://<your-host>/api/auth/oidc/callback
```

**2. Configure it in the app.** As an admin, go to **Settings → SSO / OIDC** and fill in:

| Field | Purpose |
|---|---|
| **Issuer URL** | Your provider's base URL; **Test discovery** verifies it's reachable. |
| **Client ID / Client Secret** | From step 1. The secret is write-only and encrypted at rest; leave blank to keep the existing one. |
| **Scopes** | Default `openid profile email`. Add a groups scope if your IdP needs one to emit group membership. |
| **Username / Email / Groups claim** | Which ID-token claims to read. Defaults: `preferred_username`, `email`, `groups`. |
| **Group → role mapping** | Map IdP groups to **admin / operator / viewer** (e.g. `net-admins → admin`). Highest-privilege match wins. |
| **Default role** | Role for users whose groups don't match any mapping (default **viewer**). |
| **Auto-provision** | Create a local user automatically on first sign-in. |
| **Link by verified email** | Attach an SSO identity to an existing local account when the IdP's `email_verified` matches. |
| **Allowed email domains** | Optional allowlist restricting who may sign in. |
| **Button label** | Text on the login button (e.g. "Sign in with Okta"). |

Enable it and **Save**. A **Sign in with SSO** button appears on the login page.

**Behavior and safety:**
- **Provisioning / linking** — first sign-in creates a user (auto-provision) or, if `email_verified` matches an existing local account, links to it (no duplicate). SSO users have no local password.
- **Roles** are always resolved server-side from your group mapping; existing users are never silently demoted when a login carries no matching group.
- **Break-glass** — local username/password login stays available, so the seeded local admin can always get in even if the IdP is misconfigured or unreachable.
- **Behind a proxy / custom domain** — the redirect URI is derived from the request host; set **Public base URL** in the panel to pin it if your external URL differs from what the backend sees.
- SSO users are labeled with an **SSO** badge in **Users & Roles**.

---

## Updating

Pull the latest changes and rebuild:

```bash
git pull
docker compose up -d --build backend nginx
```

Database migrations run automatically on backend startup.

---

## Project Structure

```
mikrotik-manager/
├── frontend/               # React + TypeScript (Vite)
│   └── src/
│       ├── pages/          # Page components (one per route)
│       ├── components/     # Shared UI components
│       ├── services/       # API client (Axios)
│       ├── hooks/          # Custom React hooks
│       └── types/          # TypeScript type definitions
│
├── backend/                # Node.js + Express + TypeScript
│   └── src/
│       ├── routes/         # REST API route handlers
│       ├── services/       # Business logic (polling, alerts, backups)
│       │   └── mikrotik/   # RouterOS API client and device collector
│       ├── db/             # Database migrations
│       ├── config/         # DB, InfluxDB, Redis connections
│       ├── middleware/      # Auth, audit logging, error handling
│       └── utils/          # Helpers (crypto, OUI lookup, etc.)
│
├── nginx/                  # Reverse proxy config and Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Contributing

Contributions are welcome! Please open an issue before submitting a pull request so we can discuss the approach.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "Add your feature"`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a pull request

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)** — see the [LICENSE](LICENSE) file for the full text.

### What this means

- You are free to use, modify, and distribute this software.
- If you run a modified version of this software as a network service (e.g., as a hosted web app), you **must** make your modified source code available to users of that service under the same AGPLv3 license.
- Any distributed copies or derivatives must also carry the AGPLv3 license.

This license was chosen to ensure that improvements made to this project — including those deployed as a service — remain open and available to the community.

---

## AI Assistance

This project was designed and built with the help of [Claude](https://claude.ai) by Anthropic. AI assistance was used throughout development — including architecture decisions, backend services, frontend components, the CI/CD pipeline, security configuration, and unit tests.

We believe in being transparent about how software is made. The code has also been reviewed and tested using AI and is maintained by the project authors.

---

## Disclaimer

This project is not affiliated with or endorsed by MikroTik. MikroTik and RouterOS are trademarks of SIA MikroTīkls. Use this software at your own risk. Always test configuration changes in a non-production environment first.
