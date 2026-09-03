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

Enqueue rate is not connect rate. Workers process jobs with limited concurrency, so what
matters is whether they drain faster than the schedule fills.

## Is it keeping up?

**Settings → Polling**, or `GET /api/system/poller`.

The number to read is **headroom** — service capacity divided by demand:

```
arrival   devices / poll interval
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
| `POLLER_INTERVAL_MS` | 30000 | Scheduler tick. Lengthening reduces demand |
| `POLLER_JOB_TIMEOUT_MS` | 45000 | Ceiling on one poll, so a dead device cannot hold a worker |
| `POLLER_JOB_RETENTION_SEC` | 3600 | How long finished jobs are kept |
| `POLLER_JOB_RETENTION_COUNT` | 5000 | How many finished jobs are kept |
| `REDIS_MAXMEMORY` | 512mb | Ceiling on Redis |

Raise concurrency first. Lengthen the interval second — it reduces freshness, which is the
thing you are paying for.

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
