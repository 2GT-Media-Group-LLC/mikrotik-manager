# MikroTik Manager 1.0

Released on Sunday 1 November 2026, after a week of release candidates (1.0.0-rc.1 to rc.9)
tested on real fleets.

1.0 is the first stable release: a version to run in production, where updates on the 1.0.x
line only fix things. It's the result of more than 130 beta releases since April 2026, many of them
shaped by people running MikroTik Manager on their own fleets.

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
