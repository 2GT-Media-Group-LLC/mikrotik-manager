# MikroTik Manager 1.1 (beta)

1.1 is in beta on the `dev` branch and the `:beta` images
([release channels](configuration.md#release-channels)). For stable, stay on 1.0 below.

## 1.1.0-beta.4

The first new features of 1.1, both from
[@jenserling](https://github.com/jenserling):

- **12- or 24-hour time.** Times show in 24-hour format by default. Fleet admins set the
  default for everyone under **Settings → General**, and each account can choose its own
  ([Time display](configuration.md#time-display),
  [#343](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/343)).
- **Wireless Systems and the antenna aligner.** A new device type, shown as **WS**, for outdoor
  point-to-point, point-to-multipoint and CPE radios. These devices get an **Antenna aligner**
  tab with live signal from one or both ends of a link, per-chain readings, SNR, CCQ, link
  rates, a signal history and an optional tone. It only reads from the radios and never
  changes their settings. Existing radios keep their type until you change it in Edit Device
  ([Antenna aligner](antenna-aligner.md),
  [#344](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/344)).

## 1.1.0-beta.3

The fixes of [1.0.2](#102), for the beta channel: log collection uses much less CPU (thanks to
[@KevinGinger](https://github.com/KevinGinger),
[#374](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/374)), and the backend image
no longer copies a checkout's local packages into the build.

## 1.1.0-beta.2

The security fixes of [1.0.1](#101), for the beta channel. Update as soon as you can.

## 1.1.0-beta.1

No new features yet. This beta upgrades the major libraries underneath the app, so they get
tested before the 1.1 features land on top of them: Express 5, BullMQ 6 and ioredis 6,
openid-client 6 (SSO), recharts 3, zustand 5 and TypeScript 6. Pages, charts and sign-in
should look and work as they did on 1.0. If something doesn't,
[open an issue](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues) and say you're
on the beta.

One thing to check if you use SSO: the **Issuer URL** has to be the issuer your provider
names in its discovery document. A trailing slash either way is fine, but an IP address or a
different hostname for the same provider is now refused, and **Test discovery** gives the URL
to use instead ([SSO / OIDC](sso-oidc.md)). Signing in with the local admin isn't affected.

# MikroTik Manager 1.0

Released on Sunday 1 November 2026, after a week of release candidates (1.0.0-rc.1 to rc.9)
tested on real fleets.

1.0 is the first stable release: a version to run in production, where updates on the 1.0.x
line only fix things. It's the result of more than 130 beta releases since April 2026, many of them
shaped by people running MikroTik Manager on their own fleets.

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
