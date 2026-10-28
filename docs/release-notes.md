# MikroTik Manager 1.0

> **Release candidate.** 1.0.0-rc.1 came out on Sunday 25 October 2026; rc.2 to rc.7, with the
> fixes from testing, followed during the week. Stable 1.0.0 is planned
> for Sunday 1 November if testing turns up nothing serious. Please report anything odd as a
> [GitHub issue](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues).

1.0 is the first stable release: a version to run in production, where updates on the 1.0.x
line only fix things. It's the result of more than 130 beta releases since April 2026, many of them
shaped by people running MikroTik Manager on their own fleets.

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
  RouterOS 7, from rc.4, MikroTik Manager reads it from the scan run as a script
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
@Orhideous, @henkb-gh, @ronchan44, @cybr4nx, @dlemery, @trackersoft, @rvanderwouw,
@kraken-XIV, @thadrumr, @devaux, @gbil, @Bigben83 and many more.
