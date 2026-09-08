# Firmware rollouts

[← Documentation index](README.md)

Upgrade RouterOS across a fleet in waves, with a verified pipeline per device and
a stopping point before a bad build reaches everything.

## The pipeline

Each device goes through the same sequence:

1. **Pre-upgrade backup** (optional, on by default)
2. **Check for updates** — a device already on the target version is *skipped*, not failed
3. **Download the image, and confirm it landed**
4. **Reboot**
5. **Prove the reboot happened** — uptime must have gone *backwards*
6. **Verify the version moved**
7. **RouterBOOT** (optional) — a second flash and a second reboot

Steps 3 and 5 exist because of a specific failure. `/system/package/update/install`
bundles download and reboot into one call whose progress cannot be observed, and a
CCR2216 was seen to accept it, do neither, and report nothing. That surfaced as
"rebooted but still reports 7.24.1", because nothing could tell a device that never
restarted from one that restarted unchanged.

Downloading first makes success verifiable *before* anything reboots, so a device is
never restarted for an image it does not have.

!!! note "Downloads are slow, and that is normal"
    `/system/package/update/download` blocks until the image has landed — a minute or
    more on an ordinary link. It is given a ten-minute budget. If the command does not
    return cleanly the device is asked again on a fresh connection what actually
    happened, rather than being declared failed: a slow download is not a broken one.

## Waves

Waves are the point. Devices are assigned to wave 1, 2 or 3, and **waves run strictly
in sequence**. Wave 1 is your canary: put one device in it, let it finish, and the
rest of the fleet is still untouched if it goes wrong.

**Halt on failure** stops the rollout rather than continuing into the next wave.
Devices never reached are marked `skipped`, not `failed` — they did not run.

A device that comes back on the *old* version counts as a failure.

## Upgrading several devices at once

By default the devices inside a wave upgrade **one at a time**. That is safe and slow:
a CRS switch can take five minutes to reboot, so ten of them is most of an hour spent
waiting.

The **At once** control raises how many devices in the same wave may upgrade
simultaneously. Waves remain sequential either way, so the canary still gates
everything after it.

There are two costs, and both are worth understanding before you raise it.

**Halting becomes less precise.** A failure stops any further device from *starting*,
immediately — but devices already running finish, because interrupting one mid-write is
how you brick it. So with **At once** set to five, up to five devices can carry a bad
build before anything stops. At the default of 1 nothing else has started, so a failure
stops the rollout exactly as it always has.

**Devices reboot together.** That is fine for independent routers. It is not fine for
a switch that the others are reached *through*: rebooting it alongside them cuts the
path to devices that are mid-upgrade. Change Guard does not cover this — it protects
configuration, and a device that is unreachable because its uplink rebooted has no
configuration change to revert.

The rollout builder warns when it can see that one selected device carries another's
traffic. That warning is deliberately conservative: it fires only when a link is the
device's spanning-tree root port *and* that port resolves to exactly one neighbour.
Discovered topology is often ambiguous — a trunk port can resolve to several
neighbours at once — and naming the wrong switch would be worse than saying nothing.
**Absence of a warning is not proof that it is safe to reboot everything together.**

A reasonable pattern for a large fleet on a well-known patch release:

| Wave | Devices | At once |
|---|---|---|
| 1 | one representative device | 1 |
| 2 | the access layer | 5–10 |
| 3 | anything upstream of wave 2 | 1 |

## Scheduling and cancelling

A rollout can be scheduled; pair it with a maintenance window by scheduling inside
one. One rollout runs at a time.

Devices already belonging to an unfinished rollout are refused by name when you try
to create another for them, before anything is written.

**Cancelling never interrupts an in-flight flash.** It stops before the *next* device,
because interrupting a device mid-write is how you brick it. The UI says so when you
press the button — the currently upgrading device will finish first.

## If the manager restarts mid-rollout

The active rollout is tracked in memory, so a manager restart — a crash, an OOM kill,
or pulling a new image — ends it. Nothing resumes automatically: a device may have been
mid-reboot, and continuing an upgrade from an unknown state is how hardware gets
bricked.

On startup any rollout still marked running is closed out and reported honestly:

- devices it never reached are **skipped** — "not reached"
- a device that was mid-upgrade is **failed**, saying its real state is unknown and to
  check it before re-running
- devices that already finished keep their result

This matters beyond tidiness. An unfinished rollout blocks its devices from joining a
new one, which is right while it is genuinely running and wrong for one that can never
finish — without this, an interrupted rollout left its devices permanently unable to be
upgraded.

## When it fails

Failure messages name the mechanism rather than the symptom. "Device did not finish
downloading within ten minutes. Nothing was rebooted. The device reports 91.6 MB free"
tells you where to look; "upgrade failed" does not.

If a rollout reports a device stuck at the old version, check the device's own
`/system/package/update` state before re-running — it may have the image already.
