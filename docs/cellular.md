# Cellular (LTE)

[← Documentation index](README.md)

Everything here is read from the modem your device already has. Nothing needs enabling
on the device for the monitoring half; the data-cap SMS at the end is the only part that
writes anything.

## What a modem reports depends on the modem

This is the single most important thing to know before reading the rest. RouterOS is not
the source of these fields — the cellular module is, and modules disagree.

The platform was built against a **Quectel EG18-EA** (MikroTik ATL 18), which reports
`data-class` where the documentation says `access-technology`, `iccid` where WinBox shows
`UICC`, `status: running` rather than `connected`, and does not report
`registration-status`, `pin-status` or tracking area at all.

Every field is therefore treated as optional. A panel showing "—" for something is
usually your modem not reporting it, not a fault.

## Signal quality

Four measurements are collected on the fast poll and kept as a time series:

| Field | Unit | Meaning |
|---|---|---|
| RSRP | dBm | Power of the reference signal — how loud the tower is |
| RSRQ | dB | Quality of that signal |
| SINR | dB | Signal against noise — how *usable* it is |
| RSSI | dBm | Wideband received power |

The panel grades the link rather than only printing numbers, and **SINR leads that
grade**. RSRP alone misleads: the reference device reports −97 dBm — nominally "fair" —
on a link running 256QAM at maximum reported channel quality with two spatial streams.
That is the modem at its ceiling. RSRP moderates the grade but cannot define it.

Values that cannot be real are discarded rather than plotted. A positive dBm reading
appears in real logs and means the modem is reporting something other than a measurement.

## Carriers and aggregation

`primary-band` and `ca-band` arrive as composite strings — `B1@20Mhz earfcn: 500
phy-cellid: 190` — and are parsed into band, bandwidth, EARFCN and physical cell id.

A Cat-18 modem reports **one `ca-band` per aggregated carrier**. Because an API sentence
flattened into an object holds one value per key, repeated attributes are preserved
explicitly; without that, a device aggregating four carriers reports only the last, and
the last is often the narrowest. The panel shows every carrier and the aggregate
bandwidth.

### Uplink anchor

Uplink rides the **primary carrier alone**. Left on automatic, a modem anchors to
whichever band it hears loudest — frequently a narrow one — and aggregates wider bands for
downlink only, which caps upload no matter how much downlink is stacked on top.

When the primary is narrower than a carrier being aggregated, the panel says so. This is
the actual reason operators lock bands, and it is invisible in RouterOS.

## Observed bands

Bands seen serving the device accumulate from polling, and are shown beside the bands
your configuration permits.

This exists because scanning is not a dependable answer to "is this band available here?"
— it costs service to run and returns nothing at a site with a single base station. A band
the modem has actually used demonstrably works there; one never observed is a candidate
for stranding a device on a mast.

## Tower and band movement

Handovers, re-registrations and band changes are reconstructed by comparing consecutive
polls. A session uptime that runs *backwards* means the modem re-registered; a changed
cell id means it handed over.

This is deliberately not log-based. The modem this was built for may log nothing at all,
so polling is the vantage point that always exists.

## Data-cap reset SMS

Several European carriers sell "unlimited" data that is throttled past a daily allowance,
and lift the throttle when the subscriber texts a short code.

Configure per interface: **number**, **allowance**, **reset time and timezone**,
**cooldown**, and how far **early** to send.

### Why it sends early

Interface byte counters do not survive a reboot, so there is no running total to read —
usage is accumulated poll to poll. That makes the figure a permanent **undercount**:
traffic during a reboot, a missed poll, or before the device was adopted is invisible.

Undercounting fires *late*, and late means already throttled. So the trigger fires below
the configured allowance, 5% by default. Firing early costs one message; firing late costs
the evening.

The saving grace is that the carrier resets daily too, so the error cannot accumulate past
a single period.

### Calibrating the margin

If you are throttled while the bar still reads under the trigger point, the gap **is** the
correction. Throttled at 8.7 GB against a 10 GB allowance means roughly a 13% undercount;
set "send early by" to 15–20%.

Device reboots and manager downtime both widen the gap and are visible to you but not to
us.

### Sending manually

The **Send now** button is independent of everything else — not gated on the rule being
enabled, on a threshold, or on the usage estimate. It is the trustworthy half: one known
action for a reason you already have. The automatic trigger is a convenience layer on top.

The automatic side carries a cooldown, because usage sits *at* the cap once reached rather
than above it. Without one, a link parked on its limit would text the carrier on every
poll.

### Requirements and a trap

The modem needs SMS enabled — `/tool/sms/print` should report `receive-enabled: yes` and
the port your interface uses.

If that output also shows `sms-storage: sim` with `remove-sent-sms-after-send: no`, sent
messages accumulate on the SIM. A SIM holds twenty or thirty, and **a full store makes
sending fail silently** — the worst possible failure here. Setting
`remove-sent-sms-after-send=yes` removes the risk.

Every send is recorded with the counter reading at the time, so a misfire is explainable
rather than mysterious.
