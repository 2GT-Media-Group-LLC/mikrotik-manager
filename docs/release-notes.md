# MikroTik Manager 1.1 (beta)

1.1 is in beta on the `dev` branch and the `:beta` images
([release channels](configuration.md#release-channels)). For stable, stay on 1.0 below.

## 1.1.0-beta.23

- **Reverse proxy**, a new tab on **Operations → Certificates** (now **PKI** and **Reverse proxy**),
  for [@ronchan44](https://github.com/ronchan44)
  ([#358](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/358)): RouterOS's reverse
  proxy (7.22 and later) across the fleet. Add, edit and remove host-name rules that pass HTTPS to
  web servers behind a router, with a certificate from the device or one the manager's CA issues
  and renews. When WebFig's HTTPS would clash with the proxy on port 443, you choose which moves
  ([Reverse proxy](certificates.md#reverse-proxy)).

## 1.1.0-beta.22

The fix of [1.0.6](#106): Change Guard expands interface lists such as `tagged=all` in a bridge's
VLAN table, so editing one port's VLANs no longer warns that a different port, the one management
arrives on, would leave the VLAN ([Change Guard](change-guard.md)).

## 1.1.0-beta.21

- **Netinstall**, a new page under Network Services, for
  [@ronchan44](https://github.com/ronchan44)
  ([#310](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/310)): reinstall RouterOS
  on a device from a router running the netinstall package (RouterOS 7.24 or later). Install or
  remove the package, add server entries, watch devices etherboot and start their installs, and
  download install files ahead of time. An entry always names the device it installs, or waits
  for each install to be started, and the manager won't let an install's downloads fill flash or
  RAM ([Netinstall](network-services.md#netinstall)).

## 1.1.0-beta.20

- **Tunnels & PPP**, a new page under Network Services, for
  [@ronchan44](https://github.com/ronchan44)
  ([#310](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/310)): every IPsec peer,
  PPPoE server and client, active PPP session, and EoIP, GRE and IPIP tunnel across the fleet,
  with its state, how long it's been up and when it changed. Problems are listed first.
  Read-only, from the slow poll ([Tunnels and PPP](network-services.md#tunnels-and-ppp)).
- **Known CVEs count in the hardening score.** A device whose RouterOS version has known
  vulnerabilities gets a **Known RouterOS vulnerabilities** finding, at the severity of the worst
  one, which counts against its score and the fleet's like any other finding and can be muted.
  Before, CVEs were listed on the Security page but didn't affect the score
  ([RouterOS vulnerabilities](security.md#routeros-vulnerabilities)).
- **MLAG**, a new page under Network Services, from
  [@azizfayziev](https://github.com/azizfayziev)'s proposal
  ([#376](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/376)): each MLAG pair's
  state and roles, the peer link, the MLAG bonds side by side, and checks for what goes wrong:
  split brain, a peer link down, single-homed and miswired bonds, VLANs missing from the peer
  link, settings that differ, and heartbeat and host-sync storms from the logs. An **MLAG
  degraded** alert reports the critical ones ([MLAG](network-services.md#mlag)).
- **Topology links from OSPF**, from [@pimlie](https://github.com/pimlie)
  ([#373](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/373)): routers that only
  see each other across a tunnel are joined on the map by their OSPF adjacency, an unmanaged one
  is a node named by router ID, and a lost adjacency shows as down
  ([How links are found](topology.md#how-links-are-found)).
- **Tunnel down** alert: an IPsec peer, EoIP, GRE or IPIP tunnel, or PPPoE client that was up has
  been down for the threshold ([Alerting](alerting.md)).
- **Clients** columns can be hidden and resized, as on Devices, from
  [@cybr4nx](https://github.com/cybr4nx)
  ([#336](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/336),
  [Clients](clients.md#the-list)).
- Topology port labels show the near end's bond too, from the device's own bonds, so an uplink
  between two LAGs reads `Po9·sfp9 ↔ Po1·sfp2`, from
  [@azizfayziev](https://github.com/azizfayziev)
  ([#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)).

## 1.1.0-beta.19

- **Config Health finds access ports left in other VLANs.** Before 1.0.4, setting a trunk to
  access in the port editor left it tagged in the VLANs it had carried, so the switch kept
  sending them out of it. The check names the port and the VLANs, and **Fix it** saves it as
  access again, under Change Guard
  ([Config Health](change-guard.md#what-it-checks)).
- **Backups without SSH**, for [@ronchan44](https://github.com/ronchan44)
  ([#392](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/392)). A device with
  SSH off or refusing is backed up over the API instead, on RouterOS 7.13 or later: the same
  export, written to a file on the device, read back and deleted. It only runs with plenty of
  storage free, and the result is byte for byte what SSH gives
  ([Devices with SSH off](backups.md#devices-with-ssh-off)).
- Dependency updates: React 19.3.1, TanStack Query 5.106, date-fns 4, lucide-react 1.68,
  eslint-plugin-security 4.2.1 and @types/node 26.6.6.

## 1.1.0-beta.18

- **Port labels** on the topology map, a new choice under **Display**, from
  [@azizfayziev](https://github.com/azizfayziev)
  ([#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)). Short labels in
  beta.15 dropped the bond a port is in, so a LAG looked like a plain cable. The new default,
  **Short + bond**, keeps it (`Po1·sfp1`). **Short**, **Full** (as RouterOS reports it) and
  **Off** are the others, and hovering a link shows its full port names
  ([How links are found](topology.md#how-links-are-found)).
- A device's **SSH key** card links to **Settings → SSH Keys**, which installs keys on every
  device in a site at once
  ([#393](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/393),
  [SSH keys](ssh-keys.md#fleet-wide-deployment)). Settings tabs can now be linked to and stay
  put on reload.

## 1.1.0-beta.17

**AI connections**, built on [@Bigben83](https://github.com/Bigben83)'s read-only MCP connector
([#340](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/340),
[AI connections](ai-connections.md)):

- AI tools can review what the manager has stored: sites, devices, security findings, config
  health, CVE matches, interfaces and event metadata. They can't change anything or connect to
  devices, passwords and keys are never included, and each call is in the audit log.
- Set up under **Settings → AI Connections**: switch on **MCP** (Claude, ChatGPT, LM Studio,
  Open WebUI), **OpenAPI** (Open WebUI tool servers) or both. Each lists its addresses once on.
- MCP signs in with an **AI connection token** or with **OAuth** through your identity
  provider. OpenAPI uses a token. Tokens are made on the same page, can be limited to some
  sites, and work nowhere else in the API.

## 1.1.0-beta.16

Less clutter:

- The topology page's **Cards** and **Links** settings are in one **Display** popup at the top
  of the page ([Topology](topology.md#compact-view)). What you'd chosen is kept.
- **User Manager** is in the sidebar only once a device in the selected site is found running
  it. **Sync** on a device now always checks for it, so after switching it on, Sync that device
  and the page appears ([User Manager](user-manager.md#which-devices-are-shown)).

## 1.1.0-beta.15

Follow-ups to the topology map from [@azizfayziev](https://github.com/azizfayziev)
([#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)):

- An opened **N hosts** chip puts its hosts in a row under it. Before, a host could land far
  across the map, wherever it had been saved when it had a card of its own.
- Shorter port names on links: `e17` and `sfp1`, without the `bridge/` and `bridge/bonding/`
  RouterOS puts in front in LLDP. Hover a label for the full names
  ([How links are found](topology.md#how-links-are-found)).
- A Cisco AP whose platform is only "Cisco" is recognised by its LLDP system description, which
  discovery now keeps. It shows as an access point after the next slow poll.

## 1.1.0-beta.14

**A more readable topology map, part three**, from
[@azizfayziev](https://github.com/azizfayziev)'s proposal
([Topology](topology.md#layout), [#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)):

- A tiered layout. Each device hangs under its way up, the uplink the client connection path
  already follows, so the gateway router is on top, then core, access and APs. Before, the
  spanning-tree root was on top, often a switch above its router. Two gateway routers share the
  top row; a WireGuard or other tunnel peer sits beside its router instead of among the switches;
  an unmanaged switch a device goes up through is drawn between them. Arrangements saved by hand
  are kept; **Reset layout** applies the new one.
- A **Compact** view (**Cards** at the top of the page): icons with a status dot, name and
  address, and a chip for the role (Gateway, CAPsMAN, CAP, STP root). **Detailed** stays the
  default.
- A neighbour that advertises only "bridge" but calls itself an access point (a Cisco 9120) is
  shown as an access point, not a switch.

## 1.1.0-beta.13

The fix of [1.0.5](#105), reported by [@ronchan44](https://github.com/ronchan44): after Backup
all or Sync config, the dashboard lists each device that failed and why, rather than only the
count ([Backing up every device](backups.md#backing-up-every-device)).

## 1.1.0-beta.12

**Capacity & health card, after a fleet of 152 devices**, from
[@azizfayziev](https://github.com/azizfayziev)'s testing of beta.9
([#368](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/368)):

- Memory moves a device up only when it's 75 % or more **and** at least 10 points above that
  device's own lowest in the last 7 days. Access points such as the wAP ax sit near 90 % all
  week; they no longer fill the card and push the busy routers off it, and memory that climbs
  (a leak) still comes first. High memory is still coloured, and its hover says which it is.
- The shared name prefix is worked out from the rows on show, so one differently named device
  further down the list (an out-of-band `99-SITE-MGMT`) no longer stops `01-SITE-` being hidden.
- Faster. The 14-day baselines behind the "unusual for this hour" insights were read again on
  every dashboard refresh, and were most of its time; they're now kept for the hour. The 24h
  CPU graphs and the 7-day memory low are refreshed in the background, and dashboards loading at
  the same time share one query. The response's `Server-Timing` header shows where the time went.
- In a narrow window the Capacity and Security posture cards stack instead of squeezing the
  device names to nothing, and on a phone the card drops its 24h graphs.

**A more readable topology map, part two**, from aziz's testing of part one
([Topology](topology.md#how-links-are-found),
[#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)):

- Two devices heard again over VLAN, VRRP, bridge or bond interfaces draw one line, the cable,
  with a **+N** that lists the rest on hover. Two routers with one cable and fifteen CDP
  sightings on `vlan10`...`vrrp98` drew sixteen lines.
- Computers that send LLDP with no name or capabilities become one **N hosts** chip per switch,
  opened with a click, instead of a row of "Unknown" cards.
- Links leaving the same side of a card are spread along it in the order of where they go, so
  their lines and labels no longer pile up at the middle.
- A link heard over a tunnel (WireGuard, EoIP, GRE...) is drawn dotted.

## 1.1.0-beta.11

**A more readable topology map, part one**, from
[@azizfayziev](https://github.com/azizfayziev)'s proposal. Links are curved now, leaving the
bottom of the upper card and entering the top of the lower one, so the map reads top-down.
**Links** at the top of the page switches back to straight lines. A device heard over CDP or MNDP
on a port where LLDP names a different neighbour is no longer drawn as cabled to that port: it's
behind that neighbour. Those links tied routers straight to access points behind a switch
([Topology](topology.md#arranging-the-map),
[#367](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/367)).

**Export the topology map** as a PNG or SVG with **Export** on the Topology page: the whole map
as it's shown now, not only the part on screen ([Exporting the map](topology.md#exporting-the-map)).

Also the fix of [1.0.4](#104): setting a trunk port to access now takes it out of the VLANs it
was tagged on, and the port editor shows such a port as access.

## 1.1.0-beta.10

**Jump hosts say why, in time**, from [@KevinGinger](https://github.com/KevinGinger). With
forwarding off on a RouterOS jump router, editing a device to go through it used to end in
"Timed out connecting to the device". It now gives RouterOS's reason and the command that fixes it
(`/ip ssh set forwarding-enabled=local`) within the same 10 seconds, and polls, **Test** and
SSH commands do the same within their own time. A device added over SSH only gives the jump
host's reason once instead of twice ([Jump hosts](jump-hosts.md),
[#391](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/391)).

## 1.1.0-beta.9

**A more readable Capacity & health card**, from [@azizfayziev](https://github.com/azizfayziev)'s
proposal. On the dashboard's **Operations** tab the card now lists the busiest CPU first, and
memory only moves a device up once it reaches 75 %. RouterOS memory use hardly changes, so it
used to decide the order on its own. A name prefix shared by every device (`01-SITE-`) is shown
once above the list instead of cutting off every name, and each row shows the model under the
name. Loads under 50 % are grey, so the one device running hot stands out. A small graph shows
each device's CPU over the last 24 hours, with a dashed line at 75 % and a dot at the day's
peak, and a tick on the bar marks that peak too, so a spike can be told from a steady load
([#368](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/368)).

## 1.1.0-beta.8

**The IPv6 firewall.** The **Firewall** tab has an **IPv4** / **IPv6** switch. IPv6 has the same
address lists, filter rules and NAT as IPv4 (IPv6 NAT needs RouterOS 7), with the same editing,
reordering, counters and **Review changes**. Change Guard can't predict IPv6 lockouts yet, so
IPv6 changes run with auto-revert, which is required when the manager connects to the device
over IPv6 ([Change Guard](change-guard.md#firewall-rules),
[#312](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/312)).

Also: if Change Guard is set to script mode, an IPv6 firewall change or a VLAN interface change
that has to be undone is now reverted on its own, without restoring a backup and rebooting the
device.

## 1.1.0-beta.7

**Add, edit and remove VLAN interfaces.** The **VLAN interfaces** card on a device's **VLANs**
tab used to be read-only. Now it can create a VLAN interface on a port, bond or bridge (with an
IP address if you like), change its VLAN ID, parent, name, MTU or comment, disable it, or remove
it along with its addresses. Every change runs under Change Guard and can be previewed with
**Review changes**. Changing the VLAN ID or parent of the VLAN interface the manager reaches the
device through is now predicted as a lockout, including a VLAN it's stacked on
([VLAN interfaces](devices.md#vlan-interfaces),
[#309](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/309)).

## 1.1.0-beta.6

**Jump hosts**, from [@KevinGinger](https://github.com/KevinGinger): reach devices the manager
can't connect to directly through an SSH connection to a router (or any SSH server) that can.
Add jump hosts under **Credentials**, then pick one per device, or as a site's default for new
devices. Device API and SSH connections go through it, one shared connection per jump host, with
its host key pinned. On a RouterOS jump router, allow forwarding with
`/ip ssh set forwarding-enabled=local`. While devices use a jump host, only a fleet admin can
change its address, port or host key ([Jump hosts](jump-hosts.md),
[#375](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/375)).

## 1.1.0-beta.5

The fixes of [1.0.3](#103), for the beta channel: the dashboard no longer warns about missing
backups for devices whose configuration hasn't changed, and co-channel overlap is counted per
controller and per site. Also routine dependency updates.

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
