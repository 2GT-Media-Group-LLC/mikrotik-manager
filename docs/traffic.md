# Traffic analytics

Per-client and per-application traffic, from a NetFlow collector built into the platform.

## The collector

The platform listens for **NetFlow v9 and IPFIX on UDP 2055**. There is no external collector
to run. Point a device's exporter at the platform's address and flows start arriving.

Two behaviours worth knowing:

- **Deduplication.** A flow crossing two managed routers is exported twice. It is counted once.
- **NAT-tolerant ingest.** Exporters behind NAT or reaching the platform over a VPN arrive with
  a rewritten source address. Flows are matched to devices by exporter identity rather than by
  source IP, so this does not silently attribute traffic to the wrong device or drop it.

**Network Services → NetFlow** configures the exporters; **Settings** holds collector options,
including whether to accept flows from exporters that do not match a known device.

## What it shows

| View | Answers |
|---|---|
| **Top talkers** | Which clients are using the most, over 1h → 30d |
| **Application breakdown** | HTTPS, QUIC, DNS, SSH, email, WireGuard and others, by port and protocol |
| **Per-client history** | What one client has been doing over time |
| **Time series** | Throughput across the selected range |

Top talkers can be filtered by IP, name, MAC or vendor, and sorted. Selecting a client opens
its detail page — see [Clients](clients.md).

Application classification is by port and protocol. It identifies what a flow *looks* like, not
what it is: anything on 443 reads as HTTPS whether or not it is a browser.

## Retention

Two settings, both in **Settings**:

| Setting | Default | Covers |
|---|---|---|
| `netflow_retention_days` | 7 | Full per-flow detail |
| `netflow_daily_retention_days` | 365 | Daily per-client rollups |

Flow records are the bulky ones; the daily rollups are small and are what the longer ranges are
drawn from. Raising the first is the expensive change.

## If no data appears

1. Is the collector enabled? `netflow_enabled` in **Settings**.
2. Is UDP 2055 reachable from the device? The platform must be reachable *from* the router,
   which is not the same direction as the API connection.
3. Does the exporter match a known device? If flows arrive from an address the platform cannot
   match, they are rejected unless `netflow_accept_unknown` is on. The NetFlow page lists
   unidentified exporters so this is visible rather than silent.
