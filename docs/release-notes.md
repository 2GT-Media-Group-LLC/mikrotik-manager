# MikroTik Manager 1.0

Released on Sunday 1 November 2026, after a week of release candidates (1.0.0-rc.1 to rc.9)
tested on real fleets.

1.0 is the first stable release: a version to run in production, where updates on the 1.0.x
line only fix things. It's the result of more than 130 beta releases since April 2026, many of them
shaped by people running MikroTik Manager on their own fleets.

## 1.0.15

Released on Wednesday 11 November 2026.

- **Switching to API-SSL or HTTPS explains "not enough permissions"**
  ([#417](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/417)): which step the
  router refused, and that the user the manager logs in as needs the `full` group or the missing
  policies.

## 1.0.14

Released on Monday 9 November 2026.

- **Switching a device to API-SSL or WebFig to HTTPS failed behind Cloudflare**
  ([#417](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/417)). On an older
  router, creating and signing the certificate can take a few minutes, and Cloudflare gives up on a
  request after 100 seconds and shows its own 502, while the switch carried on unseen. Now a switch
  that takes longer than about 25 seconds carries on in the background, the page checks back
  every few seconds and shows the outcome when it's ready, and no other change can reach the device
  until it's done. See [Behind a reverse proxy](configuration.md#behind-a-reverse-proxy).

## 1.0.13

Released on Monday 9 November 2026. Updates are safer for the databases.

**This update restarts Postgres, Redis and InfluxDB once**, because their settings changed. Your
data stays as it is.

- **Redis repairs a damaged data file instead of refusing to start.** If Redis's append-only
  file is damaged, for example because the disk lost a write in a power cut or a hard reset,
  Redis wouldn't start, and the whole manager waited for it. This happened on a production
  install: the damage sat unnoticed for a day, because Redis reads the file only when it starts,
  until an update restarted it. The file is now checked before Redis starts and, if it's
  damaged, repaired with Redis's own tool, which cuts it at the last good record. Redis holds
  only the job queue, which refills itself, so nothing else is lost. A copy of the damaged files
  is kept, and Redis's log says what happened. See
  [The databases during an update](configuration.md#the-databases-during-an-update).
- **Postgres, Redis and InfluxDB get 60 seconds to stop cleanly** when an update or a restart
  stops them, instead of Docker's 10, so none is cut off mid-write.
- **A Redis password with quotes or `$` in it broke Redis's health check.** The password now
  reaches Redis and the check through the container's environment instead of being pasted into
  a shell command.

## 1.0.12

Released on Monday 9 November 2026. Clients that stayed online, mirror rollouts on small
switches, and the CRS354's QSFP+ ports.

- **Clients stayed online long after they'd left**
  ([#363](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/363)). RouterOS keeps
  `stale` and `failed` ARP entries, MAC and all, for days on a quiet VLAN, and any that wasn't
  `failed` counted as the client being there, so phones stayed online all weekend. Only entries
  the router is in touch with count now (`reachable`, `delay`, `probe`, or static). A `stale` one
  keeps a client that's already online for 15 minutes, so a quiet printer doesn't flicker, but
  never brings one online. Thanks to aziz for tracking down the cause. See
  [Clients](clients.md#where-the-data-comes-from).
- **Mirror rollouts refused switches with 16 MB of flash.** A device such as a CRS309 or hAP ac²
  runs from RAM and downloads packages into RAM, but the rollout measured them against its free
  flash, about 3 MB, and stopped with "Not enough space". It checks free memory on those devices
  now, keeping a margin for the device itself. Reported by Manuel in
  [Discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85).
- **The CRS354's QSFP+ ports drew as eight separate cages.** The CRS3xx names its QSFP+ lanes
  `qsfpplus1-1` to `qsfpplus2-4`, which didn't fit the lane naming the faceplate knew, so each lane
  was a cage of its own (Q1, Q1, Q2, Q2 and so on). They're two cages of four lanes now. Also
  reported by Manuel.

## 1.0.11

Released on Sunday 8 November 2026. Trunk ports and their native VLAN.

- **A trunk port dropped untagged traffic.** Setting a port to trunk wrote
  `frame-types=admit-only-vlan-tagged`, so the native VLAN the port editor offered never
  applied: a laptop, printer or unmanaged switch plugged into a trunk port couldn't talk at all.
  A trunk now accepts both kinds of frame. Tagged frames go to its tagged VLANs, and untagged
  frames join the native VLAN, which the port carries untagged. Tick **Tagged only** for a trunk
  that should drop untagged frames, as before. Saving a trunk also takes the port out of any
  untagged VLAN other than its native one. Trunks saved by older versions open with
  **Tagged only** ticked and keep working as they did until you untick it and save. See
  [Changing a port's VLAN](devices.md#changing-a-ports-vlan).

## 1.0.10

Released on Sunday 8 November 2026. Switching a device to API-SSL.

- **Switch to API-SSL: a failure now says why**
  ([#417](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/417)). When the
  manager's reply never reached the browser, for example because a reverse proxy in front of
  MikroTik Manager gave up while a router signed its certificate, the page said only "Could not
  enable API-SSL". It now says what happened, such as a lost reply with its HTTP status or no
  answer in time, and that the switch may still finish, and the device list refreshes to show it.
  Failures are also written to the backend log. Tested on RouterOS 6.49.21.
- **Switch to API-SSL could refuse its own check.** When a device that had been on API-SSL
  before was switched again and kept the certificate already on api-ssl, the certificate pinned
  the first time no longer matched, so the login that decides the switch was refused. The old pin
  is now cleared when a switch starts.

## 1.0.9

Released on Sunday 8 November 2026. Who can open a shell or run commands, and the site switcher.

- **The web terminal is for admins only**
  ([#411](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/411)). A shell signs in
  as the router's admin account and skips Change Guard and Review changes, so operators no longer
  get one; a site admin still gets one on devices in their sites. For the same reason, running
  **bulk commands** is admin-only too. Operators keep every guarded edit on the device tabs, and
  can still cancel a bulk command run.
- **Switching sites left you on another site's device**
  ([#414](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/414)). Picking a site in
  the selector while a device page was open kept showing that device, even when it belonged to
  another site. The page now goes back to the device list when the new site doesn't include the
  device; picking the device's own site keeps it open.

## 1.0.8

Released on Saturday 7 November 2026. Fixes for the device page's update check and for RouterBOOT
upgrades.

- **The update check forgot the update channel.** On a device's **Config** tab (the **Firmware** tab
  in 1.1), the channel showed after **Check for Updates** until the page was reloaded, then went back
  to *not checked yet*. The manager saves the channel each device reports, but the device page
  didn't load it. It does now
  ([#413](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/413)).
- **A RouterBOOT upgrade could be reported as failed when only its reboot hadn't happened.** In a
  rollout, a CRS310 took the new RouterBOOT but not the reboot after it, and stayed up. The rollout
  waited 12 minutes and reported *device did not come back*, although the device was reachable the
  whole time, and it showed as up to date after its next reboot. Now, if a device is still up two
  minutes after the reboot was sent, the manager sends it again. If it still doesn't restart, the
  rollout says so: the RouterBOOT was written, the device is running, and a reboot finishes it.

## 1.0.7

Released on Saturday 7 November 2026. Housekeeping: restore points left on devices, Postgres's
shared memory, and two development-only dependency alerts.

- **Old Change Guard restore points are cleared from devices.** Each guarded change saves a
  restore point (`mtm-rp-….backup`) that only its revert scheduler reads. They were left behind
  when a revert fired, when the manager restarted mid-change, or when the clean-up couldn't reach
  the device, and piled up in the device's files. After each change, Change Guard now removes any
  restore point whose revert scheduler is gone, in binary and script mode, and keeps one that's
  still armed ([Change Guard](change-guard.md)).
- **Postgres gets 256 MB of shared memory** (`shm_size` in both compose files). Docker's default
  is 64 MB, and on a large events table Postgres's parallel queries and parallel `VACUUM` could
  fail with *could not resize shared memory segment … No space left on device*. If you keep your
  own copy of the compose file, add `shm_size: 256m` to the `postgres` service.
- `minimatch` in the build and test tooling is updated to 11, clearing two Dependabot alerts.
  Neither it nor `deepmerge` (an alert with no fix yet) is in the images.

## 1.0.6

Released on Thursday 5 November 2026. A fix for Change Guard on bridges whose VLAN table names
an interface list.

- **Change Guard warned about the wrong port.** On a bridge where a VLAN's row tags an interface
  list, such as `tagged=all`, editing one port's VLANs could be blocked with a warning that a
  different port, the one management arrives on, "would not be a member of VLAN 1 at all". The
  change didn't touch that port. Change Guard's prediction didn't expand the list into the ports
  it covers, so it lost track of them. It now expands `all`, `none` and named lists as RouterOS
  does ([Change Guard](change-guard.md)).

## 1.0.5

Released on Tuesday 3 November 2026. A fix reported by [@ronchan44](https://github.com/ronchan44).

- **Backup all didn't say which devices failed.** It showed a count, such as "Backed up 2/5
  devices", but not which devices failed or why, though the server knew. The dashboard now
  lists each one with its reason, and its name opens the device. Sync config does the same
  ([Backing up every device](backups.md#backing-up-every-device)).

## 1.0.4

Released on Monday 2 November 2026. A fix for switching a port from trunk to access.

- **A port set to access stayed tagged on its old VLANs.** Saving a trunk port as access set its
  PVID and made it admit only untagged frames, but left it a tagged member of every VLAN it had
  carried, so the switch kept sending those VLANs out of it tagged. Opening the port again showed
  it as a trunk, as if the change hadn't happened. An access port now leaves every VLAN but its
  PVID's, and Change Guard predicts that, so taking the port that carries tagged management to
  access is caught as a lockout. The port editor now shows a port in the mode its frame
  admission says. A port left half-changed by the old save opens as access; save it again to
  finish the change ([Changing a port's VLAN](devices.md#changing-a-ports-vlan)).

## 1.0.3

Released on Monday 2 November 2026. Two dashboard warnings that showed when nothing was wrong,
both reported by [@azizfayziev](https://github.com/azizfayziev).

- **"No recent backup" for devices that hadn't changed.** A configuration snapshot is only
  stored when the configuration changes, so a device unchanged for a week was flagged even
  though its newest backup was current. The hourly check that finds the configuration unchanged
  now counts as a fresh backup ([Backups](backups.md#finding-one),
  [#377](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/377)).
- **"Co-channel overlap" counted radios that don't overlap.** It counted a CAPsMAN controller's
  copies of its CAPs' radios as extra radios, and compared radios across the whole fleet. It
  now uses the Channel Usage analysis, which compares radios per controller and per site. In
  Channel Usage, standalone APs are now grouped by site too ([Wireless](wireless.md#rf-health),
  [#365](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/365)).

## 1.0.2

Released on Sunday 1 November 2026.

- **Log collection uses much less CPU.** Turning device log times into real times built a new
  time zone formatter for every line; it now reuses one per zone, which makes a large log poll
  around 7 to 15 times cheaper. Times come out exactly as before. Thanks to
  [@KevinGinger](https://github.com/KevinGinger)
  ([#374](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/374)).
- **Building from a checkout no longer picks up its local packages.** The backend image copied
  the checkout's own `node_modules` into the build, so a checkout last used on another branch
  could build a broken image. Only matters if you build the images yourself.

## 1.0.1

Released on Sunday 1 November 2026, the same day as 1.0.0. Security fixes, reported by
[@pimlie](https://github.com/pimlie); update as soon as you can.

- **Site-scoped accounts could reach other sites' devices**
  ([GHSA-j9x4-qwcj-p8v8](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-j9x4-qwcj-p8v8)).
  An id written in an unusual way (`"20"` in a list, `0x14`, `+5`, `5x`) passed the site check
  but still reached the device, backup or rollout, so an operator limited to one site could run
  commands on any device. Ids are now read one way everywhere, a second site check can't raise
  the role the first one set, and security-check mutes are limited to the account's sites.
  Installs without site-scoped accounts weren't affected.
- **Device passwords could be sent unencrypted, or to another address**
  ([GHSA-63v6-w7qf-349f](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-63v6-w7qf-349f)).
    - Adding a device with no port tried API-SSL and the plain API at the same time, so the
      password crossed the network unencrypted even when API-SSL worked. The plain API is now
      tried only when API-SSL isn't available ([Devices](devices.md#adding-devices)).
    - Moving a device to another address sent its saved SSH password there. Now only the
      passwords entered with the move are used ([Devices](devices.md#device-credentials)).
    - Alert email didn't check the mail server's certificate. It does now, and requires STARTTLS
      before sending a login; untick **Check the server's certificate** on the channel for a
      server with a self-signed certificate ([Alerting](alerting.md#email)).
    - Two-factor codes are limited per account as well as per address, and each code signs in
      once.
- **RouterBOOT upgrades stayed pending after they were done**, and after a RouterOS downgrade an
  older RouterBOOT was offered as an upgrade
  ([#372](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/372)).

**Check after updating:** if alert email stops arriving, open the channel and use **Send test**.
A mail server with a self-signed certificate, or one that doesn't offer STARTTLS, now needs
**Check the server's certificate** unticked.

## What it does

MikroTik Manager is a self-hosted manager for fleets of MikroTik routers, switches and access
points on RouterOS 6 and 7.

- **Inventory and health.** Devices grouped into sites and site groups, live status, resources,
  availability and reboots, hardware sensors, optics and PoE. Adoption of configured and
  factory-default devices. [Devices](devices.md), [Sites](sites.md), [Adopting devices](adoption.md)
- **Configuration from one place.** Ports, bridges, VLANs (bridge, switch-chip and VLAN interfaces),
  IPv4 and IPv6 routes with routing tables, firewall and NAT, queues, wireless, DHCP, DNS, NTP,
  WireGuard, logging, SNMP and LLDP, bulk commands, templates and firmware rollouts in waves.
- **Change Guard.** Every change that could cut the manager off is checked against the device's
  real management path first, and protected by an automatic revert if the device stops answering.
  [Change Guard](change-guard.md)
- **Security.** A posture check for every device (management services, firewall input rules,
  IPv6, RoMON, certificates), known RouterOS vulnerabilities in the fleet, device certificates
  from the manager's own CA, SSH keys, and fixes you can apply in one click.
  [Security page](security.md)
- **Clients, wireless and traffic.** Client history and identification, roaming, Wi-Fi radios,
  RF health, rogue APs, guest Wi-Fi, CAPsMAN, NetFlow traffic analytics, firewall logs, LTE.
  [Clients](clients.md), [Wireless](wireless.md), [Traffic analytics](traffic.md)
- **Operations.** Topology from LLDP and spanning tree, configuration backups and diffs, alerting
  with webhooks and reports, maintenance windows, platform backup and restore, single sign-on,
  per-site roles, scoped API tokens and an audit log. [Alerting](alerting.md),
  [Backups](backups.md), [API and automation](api.md)
- **Scale.** A poller built for large fleets: batched reads, optional persistent sessions,
  separate worker processes, and a health view that says when it's falling behind.
  [Polling and scaling](scaling.md)

## Upgrading from a beta

No settings need changing. Database migrations run automatically on startup.

1. Take a [platform backup](platform-backup.md) first (**Settings → Backup & Restore**). It's
   cheap insurance.
2. Update as you always have, including the compose file, not only the images
   ([Updating and image versions](configuration.md#updating-and-image-versions)):
    - from a git checkout: `git pull`, then `docker compose pull && docker compose up -d`
      (or `docker compose up -d --build backend nginx` if you build locally);
    - with the GHCR compose file: download `docker-compose.ghcr.yml` again, keep your `.env`,
      then pull and start.

### Release channels

From 1.0 there are two channels ([details](configuration.md#release-channels)):

- **Stable**, the default: `main` and the `:latest` images. 1.0.x, fixes only.
- **Beta**: `dev` and the `:beta` images. New features as betas of the next minor version.

If you update from `main` or run `:latest` today, you're on stable and don't need to do
anything. The update notice in the app now understands release candidates and follows your
channel.

## Known issues

- On access points using the legacy wireless driver with RouterOS 6, the security of
  neighbouring networks in AP scans shows as *unknown*: their scan doesn't report encryption
  over the API, and RouterOS 6 can't return a script's output the way RouterOS 7 can. On
  RouterOS 7, MikroTik Manager reads it from the scan run as a script
  ([#295](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/295),
  [Wireless](wireless.md)).

## After 1.0

Planned for the next minor version, on the beta channel: finer user roles and permissions,
editing the IPv6 firewall, adding and editing VLAN interfaces, quick firewall presets, IPsec,
PPPoE, EoIP and Netinstall views, resizable client list columns, a read-only MCP connector for
AI-assisted reviews, and major dependency upgrades. Issues labelled
[post-stable](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/labels/post-stable) are
the running list.

## Thank you

To everyone who reported a bug, asked for a feature, tested a build or sent a pull request.
Code contributors: @davidcoulson, @thanhtrung5763, @tomk1s and @denis-ev. Security reports:
@otuva and Artur Chlebicki. And the many people whose reports and ideas shaped it, among them
@Orhideous, @azizfayziev, @henkb-gh, @ronchan44, @cybr4nx, @dlemery, @trackersoft, @rvanderwouw,
@kraken-XIV, @thadrumr, @devaux, @gbil, @Bigben83 and many more.
