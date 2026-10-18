# Polling and scaling

[← Documentation index](README.md)

How the poller works, how to tell whether it is keeping up, and what to change when it is
not.

## The model

Every device is polled on three cadences, dispatched through Redis-backed queues:

| Poll | Default | Collects |
|---|---|---|
| Fast | 30 s | Interface traffic, resources, clients, status |
| Logs | 60 s | Device log events |
| Slow | 5 min | Interfaces, VLANs, system info, wireless, STP |

The intervals are set in **Settings → Polling** (the defaults above), and a site or a single
device can override them, along with MAC scan, config snapshots and whether backups include
passwords and keys (#261). The most specific wins: a device's own setting, then its site's,
then the global one. A site behind a slow or metered link can be polled gently without slowing
the rest.

- **A site:** Sites → the site's edit button → **Polling and backups**. This is the usual place:
  devices behind the same slow link are normally in the same site.
- **A device:** for the odd one out (a unit on an LTE backup link, say), **Edit Device →
  Advanced: polling and backups**, which shows each value in force and where it comes from. The
  same settings are on the device's Overview tab, in a **Polling and backups** card listing each
  value and whether it comes from this device, its site or the global setting. **Edit** there
  works like Physical Details: tick **set for this device** on the ones to change, then **Save**
  or **Cancel**.

Overrides take a fleet admin or that site's admin. Before 0.51.0 the global intervals in
Settings were saved but never used: polls ran every 30 seconds, 5 minutes and 1 minute whatever
they said.

Anything that depends on the cadence follows each device's own: a device counts as stale after
three missed fast polls (at least 3 minutes), topology links are dropped after four missed slow
polls (at least 20 minutes), and headroom adds up each device's own fast-poll rate.

Enqueue rate is not connect rate. Workers process jobs with limited concurrency, so what
matters is whether they drain faster than the schedule fills.

## Sessions kept open between polls

Opening an API session costs a TCP handshake, a TLS handshake (an RSA signature on the
router's CPU) and a login. Measured on the reference fleet that was 150 to 300 ms per poll on a
LAN, against 3 to 25 ms for the commands, and over a WAN each of those round trips adds the
link's latency (#301).

So the manager keeps sessions open: up to three per device, one each for fast, log and slow
polls (they run on separate queues and often at the same moment). A session is reused only while
it is healthy and the device's address, port, login and TLS setting are unchanged; any error or
timeout closes it rather than handing it on, and a poll that finds its session busy connects on
its own. The serial number is re-checked every ten minutes on a reused session. Sessions idle for
eleven minutes are closed. TCP keepalive keeps them alive through NAT and firewalls between polls.

Slow polls no longer wait for the manager's own ARP scan (it fills in addresses for neighbours
that advertise none). It used to expire on the slow poll's own schedule, so every device's slow
poll waited up to 12 seconds for a fresh scan; where the scan can't run (Docker Desktop, or no
NET_RAW) that was all 12. Polls now use the last finished scan while the next runs in the
background. On the reference fleet a slow poll went from 12.5 s to well under a second.

**Settings → Polling → Keep sessions open between polls** turns this off if a device or firewall
in your network misbehaves with long-lived sessions.

The same card shows **where a fast poll's time goes**: the average cost of a new session against
a reused one, the time spent collecting, and how many polls reused a session. On the reference
fleet, reusing sessions took fast polls from about 800 ms to 100 to 400 ms; what remains is the
collecting itself.

## Pages that show something from every device

Some pages show what only the device can tell (DHCP servers, traffic-flow settings, the
dashboard's security scores). They used to contact every device on every load. Now they show
what was last read from each device, with when, and refresh entries older than 10 to 15
minutes in the background, eight devices at a time. A small fleet barely notices: the page
waits a moment for those refreshes. A large one gets the last known view at once, and it fills
in as the page re-checks every few seconds while refreshes run. **Refresh** reads every device
again (still eight at a time), and a change made on the page drops that device's cached entry
so it shows straight away (#302).

Bulk actions that contact every device ("Check all for updates", "Sync all", deploying an SSID
to several access points) also run eight devices at a time.

## Pages on a large fleet

- **Choosing a device.** Every drop-down that lists devices (Events, Backups, Clients, the
  Network Services pages, the device Tools tab, Copy VLANs, Guest WiFi and others) can be typed
  into: every word typed must appear in the device's name, address, site, model or identity, so
  "amsterdam crs" narrows straight to the switches at that site. Arrow keys and Enter choose,
  Escape closes, and typing on the closed drop-down starts a search (#304).
- **Dashboard cards** list the devices needing attention first (offline, then other trouble,
  then pending updates) and stop at ten, with a link to the rest. The Fleet strip stops at two
  rows of tiles. The update banner names six devices per line and counts the rest. Lists that can
  run long (things to handle, capacity when expanded, devices not polled recently) keep a fixed
  height and scroll (#303).
- **Topology** asks for a site on a large fleet, and a device's page opens its own part of the
  map ([Topology](topology.md#one-site-or-one-device-at-a-time), #305).

## Is it keeping up?

**Settings → Polling**, or `GET /api/system/poller`.

The number to read is **headroom** — service capacity divided by demand:

```
arrival   sum over devices of 1 / that device's fast-poll interval
service   worker concurrency / mean poll duration
headroom  service / arrival
```

Below **1.0** the backlog grows every cycle and devices go stale. Comfortably above it,
the fleet is being polled on schedule.

**Headroom alone is not enough**, which is why backlog and drain estimate sit beside it. It
describes flow — whether the workers can keep up *from here* — and is blind to work already
queued. A healthy headroom next to a large backlog means capacity is fine but you are still
working through a queue.

A single `status` summarises all of it: `ok`, `draining`, or `saturated`.

## Which devices are being missed

The same page lists devices not polled recently, and distinguishes two states that look
identical from the outside:

- **not attempted recently** — the poller never reached it
- **responded with…** — it was reached and did not answer

`device_poll_stats` records attempt and success separately per device and per kind, with
duration and last error. Their difference is that distinction.

## Tuning

All of these are environment variables and need a container restart.

| Variable | Default | Effect |
|---|---|---|
| `POLLER_CONCURRENCY` | 12 | Workers per queue. The first lever when headroom is low |
| `POLLER_INTERVAL_MS` | 10000 | Scheduler tick: how often it checks what's due. Polls run at their own intervals; this only needs to be as short as the shortest of them (10 s is the shortest fast poll) |
| `POLLER_JOB_TIMEOUT_MS` | 45000 | Ceiling on one poll, so a dead device cannot hold a worker. A poll that runs past it is cancelled and its connection closed |
| `POLLER_JOB_RETENTION_SEC` | 3600 | How long finished jobs are kept |
| `POLLER_JOB_RETENTION_COUNT` | 5000 | How many finished jobs are kept |
| `REDIS_MAXMEMORY` | 512mb | Ceiling on Redis |

Raise concurrency first. Lengthen the poll intervals second (in Settings, or for the sites
that need it) — it reduces freshness, which is the thing you are paying for.

**When a poll hits the time limit.** A fast poll that runs out of time counts as a failed
poll (the device goes offline if it keeps happening). A slow poll that runs out of time is
simply cancelled; it says nothing about whether the device is up, so it never marks the
device offline. Any open outage is closed by the next successful poll. Before 0.24.37 a poll
that hit the limit kept running after it had been counted as failed, and when it finished it
marked the device online without closing the outage it had opened, so the device's uptime
kept falling while it was up.

## Reducing the work itself

Raising concurrency changes how much can be done at once. Switching off a collector changes
how much there is to do, which is the larger lever on a big fleet: every collector is a round
trip per device per cycle.

**Settings → Polling → Collectors.**

| Collector | Cadence | Cost of switching it off |
|---|---|---|
| Connected clients | fast poll | No client list, per-client traffic or fingerprinting |
| Neighbour discovery | slow poll | Topology stops updating; no automatic discovery |
| Device logs | own 60s poll | No events; log alerts go quiet. The session is skipped entirely |
| Certificates | slow poll | No certificate inventory or expiry warnings |

Measured on the reference fleet, turning off clients and logs:

```
logs   694 ms  ->    1 ms     (returns before connecting)
fast   562 ms  ->  211 ms     (-62%)
```

Each one costs the feature it feeds, and data already collected stops being refreshed rather
than disappearing — pages will show figures that quietly age. That is the trade.

## Event volume

Events are device log lines, and they are the largest table by a wide margin on most installs.

`retention_events_days` (default 30) is enforced hourly, deleting in batches so that a first
run on a long-unpruned install does not hold locks for the duration.

Until v0.24.19 that setting existed and was read by nothing, so events grew without limit. If
you are upgrading from an older build, expect a large one-off delete on the first poll cycle
after the upgrade — 109,649 rows on a five-device fleet that had been running for 36 days.

## Behaviour worth knowing

**A device already queued is not enqueued again.** Deduplication is by job id, so a
backlog cannot compound: one outstanding poll per device and kind, however long it waits.

**Periodic polls are not retried in-job.** The schedule *is* the retry — a device that did
not answer is unlikely to answer a second later, and a retry occupies a worker the rest of
the fleet needs.

**Stale queued polls are discarded**, at startup and every five minutes. A periodic poll
that has waited longer than its own cadence is worthless: running it produces a reading the
next cycle would take anyway. Discarding is safe precisely because the work is periodic —
the schedule re-enqueues within one interval.

**Job history is bounded.** Redis runs with `noeviction` rather than an LRU policy on
purpose: BullMQ's job locks and stalled-check keys carry TTLs, and evicting one causes
duplicate processing or a stalled-job storm. A memory ceiling protects the host; retention
keeps usage far below it.

## Clearing a backlog

**Settings → Polling → Clear queued**, or `POST /api/system/poller/drain`.

Nothing is lost. The scheduler re-enqueues whatever is still due on its next tick, so the
cost is at most one interval of freshness.

## Scheduled work and timezones

Scheduled tasks are evaluated in the timezone set under **Settings → General**, not the
container's. The container runs UTC, so without this a backup set for 02:00 would fire at
02:00 UTC wherever you are — and on the wrong day far enough east.
