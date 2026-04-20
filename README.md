# MikroTik Manager

A self-hosted, full-stack network management platform for MikroTik devices. Monitor, configure, and manage your entire MikroTik infrastructure — routers, switches, and wireless access points — from a single web interface.

![Version](https://img.shields.io/badge/version-0.10.2_Beta-blue)
![License](https://img.shields.io/badge/license-AGPLv3-blue)
![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)
![Built with Claude](https://img.shields.io/badge/built%20with-Claude%20AI-blueviolet?logo=anthropic&logoColor=white)

---

## Screenshots

<p align="center">
  <img src=".github/images/Login%20Page.png" alt="Login Page" width="55%" />
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
- Live KPI cards: total devices, online/offline count, connected wireless clients, active alerts
- Device type distribution chart
- Firmware update notifications with per-device details
- Historical client count graph (1h → 30d range)

### Device Management
- Add, edit, and delete MikroTik devices (routers, switches, wireless APs)
- Automatic polling: status, model, firmware version, RouterOS version
- Firmware update availability detection
- Per-device notes, rack location, and physical address with map support
- Device credential encryption at rest

### Routers
- Routing table viewer
- Interface overview with IP assignments
- Firewall rule inspection
- Router-specific settings and configuration

### Switches
- VLAN management (create, edit, delete VLANs)
- Per-port configuration and VLAN membership
- Switch overview with port status

### Wireless
- Per-AP SSID management — create, edit, enable/disable, delete wireless interfaces
- **Bulk SSID deployment** — push an SSID configuration to all managed APs simultaneously
- Security profile management (WPA2/WPA3, PSK, EAP)
- Hardware radio information and band filtering (RouterOS 7 wifi package + legacy wlan package)
- Scheduled and on-demand **spectral scans** per radio
- Scheduled and on-demand **AP scans** (nearby access point discovery)
- Real-time radio monitoring
- Wireless client tracking with vendor lookup

### Network Services
Each service supports multi-device management with conflict detection:

| Service | Capabilities |
|---|---|
| **DHCP** | IPv4 & IPv6 servers, address pools, static leases, live lease table |
| **DNS** | Upstream servers, static records (A/AAAA/CNAME/MX/NS/PTR/TXT/SRV), cache flush, DoH |
| **NTP** | Server (broadcast/manycast), client (unicast/multicast), sync status |
| **WireGuard** | Interface management, peer configuration, public key display, RX/TX stats |

### Network Topology
- Auto-discovered network map using LLDP, CDP, and MNDP neighbor data
- Interactive node graph with device type icons
- Protocol-priority link deduplication

### Client Tracking
- All connected clients across all devices in one view
- Filter by device, type, active status, or search by MAC/IP/hostname
- Client detail page with connection history and vendor identification
- Historical client count metrics

### Backups
- Trigger RouterOS backups on demand via SSH
- Download and manage backup files from the UI

### Alerts
Configurable alert rules with cooldown periods:
- Device online / offline
- High CPU or memory usage (configurable threshold)
- SSL certificate expiry warning
- Firmware update available
- RouterOS log errors and warnings
- New device discovered

### Global Search
Instant search across devices, clients, and events from the top navigation bar.

### User Management & Access Control
- Role-based access: **Admin**, **Operator** (read/write), **Viewer** (read-only)
- Admin-only user creation and role assignment
- JWT authentication with secure session handling

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
| `JWT_SECRET` | `changeme_use_a_long_random_secret_at_least_32_chars` | Secret for signing JWT tokens. **Change this.** |
| `ENCRYPTION_KEY` | `changeme32byteslongencryptionkey` | 32-character key for encrypting device passwords at rest. **Change this.** |
| `DB_PASSWORD` | `mikrotik_secure_pw` | PostgreSQL password |
| `INFLUXDB_TOKEN` | `mytoken123456789` | InfluxDB admin token |
| `INFLUXDB_ORG` | `mikrotik-manager` | InfluxDB organization name |
| `INFLUXDB_BUCKET` | `metrics` | InfluxDB bucket for time-series data |
| `INFLUXDB_ADMIN_PASSWORD` | `admin_password_123` | InfluxDB admin UI password |
| `HTTP_PORT` | `80` | Host port for HTTP (redirects to HTTPS) |
| `HTTPS_PORT` | `443` | Host port for HTTPS |

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
│       ├── middleware/      # Auth, error handling
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

We believe in being transparent about how software is made. The code has also been review and tested using AI, and is maintained by the project authors.

---

## Disclaimer

This project is not affiliated with or endorsed by MikroTik. MikroTik and RouterOS are trademarks of SIA MikroTīkls. Use this software at your own risk. Always test configuration changes in a non-production environment first.
