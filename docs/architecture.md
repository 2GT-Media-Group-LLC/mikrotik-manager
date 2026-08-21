# Architecture

[← Documentation index](README.md)

For contributors, and for anyone wanting to know what happens between the UI and a device.

## The shape of it

```
Browser ──► nginx ──► Express API ──► RouterOS API / SSH ──► devices
                          │
                          ├──► PostgreSQL   current state, config, users, audit
                          ├──► InfluxDB     time-series metrics
                          └──► Redis        job queue and locks
```

Three data stores, because they answer different questions:

| Store | Holds | Why not the others |
|---|---|---|
| **PostgreSQL** | Devices, interfaces, VLANs, clients, users, audit log, findings | Relational, needs joins and constraints |
| **InfluxDB** | CPU, memory, traffic, client counts, RF quality | Time-series at poll cadence; would bloat Postgres |
| **Redis** | BullMQ job queues, per-device locks, poll gating | Ephemeral, needs atomic operations |

## Polling

A scheduler enqueues work per device on separate cadences, so a slow operation never
delays a fast one:

| Cycle | Default | Collects |
|---|---|---|
| Fast | 30s | Reachability, CPU, memory, traffic counters, clients |
| Slow | 5min | Interfaces, VLANs, addresses, neighbours, STP, wireless, CAPsMAN |
| Logs | 60s | Device log entries, feeding log alerts |
| Config snapshot | 60min | `/export`, deduplicated by content hash |
| Config health | 60min | Read-only configuration audit |
| MAC / spectral / AP scan | configurable | Switch MAC tables, RF surveys |

Devices are probed once for wireless capability and the result recorded, so non-wireless
devices are skipped cheaply on every later poll.

## Device communication

`RouterOSClient` speaks the RouterOS **binary API** (8728, or 8729 with TLS). It is used
for essentially everything, including the safety machinery, because many deployments never
configure SSH.

SSH is used only where RouterOS offers no API equivalent — `/export` for config snapshots,
binary backup retrieval, packet capture download, and the in-browser terminal.

## Where the interesting logic lives

```
backend/src/services/
├── mikrotik/
│   ├── RouterOSClient.ts     binary protocol client
│   ├── DeviceCollector.ts    all collection and device mutation
│   └── capsman.ts            role detection, radio matching  (pure)
├── changeGuard/
│   ├── ChangeGuard.ts        restore point, scheduler, verify, commit
│   ├── pathModel.ts          live snapshot, management-path resolution  (pure)
│   ├── invariants.ts         what must hold for management to survive  (pure)
│   ├── analyzeChange.ts      simulate a change, diff the invariants  (pure)
│   └── configHealth.ts       standing audit rules  (pure)
├── topology/
│   └── buildTopology.ts      neighbour graph construction  (pure)
├── netflow/                  NetFlow v9 / IPFIX collector and aggregator
└── PollerService.ts          scheduling and workers
```

Anything marked *pure* is a function over a snapshot with no I/O. That is deliberate: this
logic is subtle, its failure mode is a plausible-looking wrong answer rather than a crash,
and it must be testable without the hardware it reasons about. Those modules carry the bulk
of the test suite.

## Repository layout

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
│       ├── services/       # See above
│       ├── db/             # Schema and migrations
│       ├── config/         # Database, InfluxDB, Redis connections
│       ├── middleware/     # Auth, audit logging, error handling
│       └── utils/          # Crypto, OUI lookup, VLAN parsing
│
├── docs/                   # This documentation
├── nginx/                  # Reverse proxy config and Dockerfile
├── scripts/                # CI preflight and tooling
├── docker-compose.yml      # Build from source
├── docker-compose.ghcr.yml # Pre-built images
└── .env.example
```

## Database migrations

A single idempotent SQL script in `backend/src/db/migrate.ts` runs on every backend start.
Statements are written to be safe to re-run — `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, and guarded constraint swaps — so upgrading is just starting
the new image.

## Before you push

`scripts/ci-preflight.sh` runs the same gates as CI — lint, type-check, build, tests and
production audits for both packages — in about 35 seconds. Running it locally is faster
than finding out from a red badge.
