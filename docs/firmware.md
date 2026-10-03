# Firmware rollouts

[← Documentation index](README.md)

Upgrade RouterOS across a fleet in waves, with a verified pipeline per device and
a stopping point before a bad build reaches everything.

## The Firmware page

**Fleet versions** lists each device's RouterOS, the latest on its channel, and RouterBOOT.
Devices with nothing to install are hidden by default; **Show up-to-date (N)** brings them
back, and the choice is remembered.

The page shows the running or latest rollout and the five before it. **All upgrade history**
opens every rollout, newest first, 25 to a page; click one to see its devices and steps.

## Timeouts

Two settings, both in minutes, changed without a restart:

| Setting | Default | Covers |
|---|---|---|
| `firmware_download_timeout_min` | 10 | Waiting for the image to land on the device |
| `firmware_reboot_timeout_min` | 12 | Waiting for the device to come back after the flash |

Both are clamped to 1–120 minutes.

Raise the reboot timeout for slow hardware. CRS switches have been reported taking a full
twelve minutes to return, which is exactly the old fixed ceiling — so a slow board could fail
at the boundary through no fault of the upgrade. Raise the download timeout if MikroTik's
servers are stalling for you; a device that fails to download is not rebooted, so this is a
delay rather than a risk.

## The pipeline

Each device goes through the same sequence:

1. **Pre-upgrade backup** (optional, on by default)
2. **Check for updates** — a device already on the target version is *skipped*, not failed.
   So is one whose channel offers an **older** version (a stable device pointed at long-term,
   say): nothing is downgraded automatically, even though RouterOS calls that release "New
   version is available". The device's **Install** button follows the same rule
3. **Download the image, and confirm it landed**
4. **Reboot**
5. **Prove the reboot happened** — uptime must have gone *backwards*
6. **Verify the version** — the device must report exactly the version that was installed
7. **RouterBOOT** (optional) — a second flash and a second reboot. It waits for the device
   to settle after the first reboot and retries its first connection, then proves the second
   reboot the same way as step 5 before reading the bootloader version

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

## Local package mirror

By default each device downloads RouterOS from MikroTik's servers itself. On a big fleet a
device or two in every dozen can fail to download, and the rollout stops at them. A local
mirror moves that download to one place: the manager keeps a router you choose stocked with
the packages, and devices pull from it instead.

It uses RouterOS's own local update feature (`/system/package/local-update`), so devices
need **RouterOS 7.17 or later**. Older devices, and devices not set up for the mirror, keep
downloading from MikroTik.

Open it from **Firmware → Package mirror**.

### Setting it up

1. **Choose the package server.** Any RouterOS 7.17+ device the manager manages. It needs
   room for every architecture and package your devices run, roughly 10–25 MB per package
   file per version, so a CHR or a router with real storage is best. A 128 MB router can't
   hold one version for a mixed fleet.
2. **Address devices reach it on.** Leave it blank to use the address the manager uses. Set
   it when devices reach the server some other way (NAT, a VPN, another interface).
3. **Versions kept** (1–5, default 3), the **release channel** (stable or long-term), and
   whether new releases are fetched automatically.

Setting it up creates a login named `mtm-mirror` on the server, with a password only the
manager knows, in a group of its own (also `mtm-mirror`). Devices use it to fetch packages
over Winbox (TCP 8291), so they need a route to the server on that port.

The group has RouterOS's built-in read permissions plus `ftp`. Local update lists packages
with read access but downloads them as files, and the built-in read group has no file access,
so with it devices see the packages and every download quietly fails. The login can't change
anything, but it can read every file on the server, so **use a package server that holds
nothing sensitive**, ideally one dedicated to the job, rather than a router with backups or
exports on it.

There's one mirror for the whole fleet, and optionally one per site, so a remote site can
pull from something local. A site's mirror serves that site's devices; the fleet mirror
serves the rest. Fleet administrators manage the fleet mirror; a site's administrators
manage its mirror.

### Syncing

**Sync now** fetches the latest release on the mirror's channel. With automatic fetching on,
the manager checks every six hours and syncs a new release by itself. A sync:

- Works out which files the devices it serves need: every installed package (routeros,
  wifi-qcom, container and so on) for every architecture in use, and nothing else.
- Downloads each file once from `download.mikrotik.com` over HTTPS, checks it against
  MikroTik's published SHA-256, and keeps it in the manager's data volume.
- Checks the server has room, then uploads what's missing over SFTP into the mirror's
  folder (`mtm-packages` by default) and confirms each file's size on the server.
- Removes versions beyond the number kept, from the server and the manager.

Packages go in a folder, never the server's top level, because RouterOS installs any
`.npk` file in its top level the next time it reboots. In a folder they're only ever served.

Nothing on the server changes unless every file has been fetched and verified first. If the
server is short of space the sync stops and says how much is needed.

Removing the mirror takes the packages, the login and its group off the server again.

### Switching devices to the mirror

The **Devices** table lists the devices a mirror serves. Select some and choose **Use this
mirror**: the manager adds the package server to each device's local update sources. **Stop
using it** removes it again. Devices older than 7.17 can't be selected.

### Rollouts from the mirror

When any selected device uses a mirror, the rollout bar offers **Packages from: Local mirror**
(the default) or **MikroTik**. With the mirror chosen, each of those devices:

1. Is upgraded to the newest version the mirror holds **every one of its packages** for.
   Upgrading routeros alone would leave, say, wifi-qcom at the old version, and RouterOS
   disables a mismatched package on reboot, so an access point would come back with no
   wireless. A device whose packages aren't all on the mirror fails before anything changes.
2. Is checked for free space against the size of those packages.
3. Asks the mirror for them and downloads them through local update.
4. Is confirmed to have every file, at the size the mirror recorded, before it reboots.
   RouterOS's download runs in the background and can fail without saying so, so the files
   themselves are the proof. If they don't all arrive, the ones that did are removed (a
   partial set would be installed by the next reboot) and nothing is rebooted.

From there the pipeline is the same: reboot, prove it, verify the version, RouterBOOT.
Devices in the same rollout that don't use a mirror download from MikroTik as before.

The **Fleet versions** table shows a mirror device's newest available version under
**Latest**, and offers it for upgrade when it's newer than what the device runs, even if the
device hasn't asked MikroTik.

## Waves

Waves are the point. Devices are assigned to waves 1 to 9, and **waves run strictly
in sequence**. Wave 1 is your canary: put one device in it, let it finish, and the
rest of the fleet is still untouched if it goes wrong.

**Halt on failure** stops the rollout rather than continuing into the next wave.
Devices never reached are marked `skipped`, not `failed` — they did not run.

A device counts as upgraded only when it comes back reporting the exact version that was
installed. Coming back on the old version, on some other version, or with a version that
can't be read is a failure. RouterBOOT is checked against its target version the same way.

### Waves from tags

[Tags](devices.md) are how devices are grouped. Next to **Select all updatable** there is a
chip for each tag in use. Clicking one adds that tag's updatable devices as the next wave. A
typical rollout is one canary device in wave 1, then `lab`, then `branch`, then `core`.

## Update channels

RouterOS checks for updates on a channel: `stable`, `long-term`, `testing` or `development`.
The **Update channel** card sets it.

- **Fleet default** applies to every device. *Leave each device on its own channel* means the manager never changes a
  device's channel.
- **Overrides** pick a tag or a single device and give it a different channel, or set it back
  to *follow fleet default*. A device override wins over the fleet default.
- Devices with an override are **listed** under the card, with the channel each one reports now.
  **Clear** removes one override, **Clear all** removes them all. With no fleet default set, a
  cleared device stays on whatever channel it is on.

The channel is written to the device (`/system/package/update/set channel=...`) the next time
the manager checks it for updates, and only if it differs. The card also shows the channel
each device last reported.

!!! note "RouterOS v6 to v7"
    Moving a v6 device to v7 is not the same as changing channel and is not supported yet.

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

A scheduled rollout only starts inside its window: from its scheduled time until **Don't
start after**, or an hour later if that's left blank. If the manager can't start it in time
(it was down, or an earlier rollout ran long) the rollout is marked **missed** and nothing is
upgraded; schedule it again when it suits. Before 0.24.39 a late rollout started whenever the
manager got to it, which could mean rebooting devices in the middle of the day.

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
