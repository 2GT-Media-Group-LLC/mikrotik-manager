# MikroTik Manager 1.1 (release candidate)

1.1 is in release candidates on the `dev` branch and the `:beta` images
([release channels](configuration.md#release-channels)): its features are complete, and only
fixes go in from here. For stable, stay on 1.0 below.

## What's new in 1.1

Everything 1.1 adds beyond the latest 1.0.x, for anyone coming from 1.0. Fixes aren't listed
here; the beta entries below have every change, release by release.

### New

**Firewall zones** ([Zones](devices.md#zones))

- Group a router's interfaces into zones and set what may pass between each pair, in a matrix;
  the manager writes and keeps the RouterOS rules, under Change Guard with **Review changes**.
- Presets to start from: home or small office, an office with a guest network, a management
  network, or servers in a DMZ.
- Custom rules in a zone pair can name ports, addresses, hostnames, ICMP of one type, or any IP
  protocol by number. NAT rules can name the WAN interface.
- **Log drops** per zone, capped at 5 a second so logging can't overload a small router, and
  **Log** on a rule (or **Log some of it** on an allow-all pair) for what a zone accepts.
- Zones can limit what the manager itself reaches on the router to the API, API-SSL and SSH
  ports.
- With zones on, the Firewall tab reads as zones; the chains and jumps behind them are under
  **Show RouterOS rules**.
- Zones work on routers without FastTrack offload.

**Firewall** ([Devices](devices.md#quick-firewall-rules))

- **Quick rules**: common protections in one step, including
  [brute-force protection](devices.md#brute-force-protection), which bans an address after
  repeated failed logins and shows bans across the fleet on the Security page. Management access
  adds the manager's own address.
- The IPv6 firewall can be edited like IPv4: filter rules, NAT (RouterOS 7) and address lists,
  with reordering, counters and **Review changes**.
- A rule that logs gets a short tag in its log prefix, so Firewall Logs can say which rule logged
  a line; rules that would read the same show their tags.
- Known RouterOS CVEs count in a device's hardening score.

**Firewall Logs and Sessions**, now under **Security** ([Firewall logs](firewall-events.md),
[Sessions](sessions.md))

- Firewall Logs opens grouped: one line per device, rule, interfaces, protocol and port, with
  counts. **Raw** shows every line.
- It reads in zones, with zones as coloured badges, and filters **From any zone** and **To any
  zone**.
- A period (1 hour to 30 days), an **All rules** filter for one rule's lines, and **Hide rules**
  for everything but the rules you pick.
- An **Application** column naming the service behind each port, with row colours for DHCP and
  multicast. Port names, ranges and colours are set under **Settings → Firewall Logs**.
- **Resolve names** shows client hostnames and reverse DNS in place of addresses.
- The Firewall tab can show only the rules that log.
- **Sessions**: one row per connection from NetFlow, with the client, server, NAT, bytes each way
  and how it ended.
- Routers behind NAT are told apart in NetFlow, so their flows aren't lumped together.

**Traffic** ([Traffic analytics](traffic.md))

- Click an application to see the clients behind it, each with its share, and **Where it goes**:
  its destinations and Top Destinations.
- Names behind addresses, from the DNS query logs of AdGuard Home or Pi-hole
  (**Settings → DNS Query Log**), including AdGuard Home as a Home Assistant add-on.
- Port names from Settings → Firewall Logs name Traffic's applications too.
- Drag across a chart to zoom the whole page into that window.
- Graphs as rates (bits and packets per second) rather than totals, under **Settings → General →
  Appearance**.
- A new layout: Top Talkers beside Traffic by Application, with Top Destinations below.

**Network services** ([Network services](network-services.md))

- **Tunnels & PPP**: the state of every IPsec peer, PPPoE server and client, PPP session, and
  EoIP, GRE and IPIP tunnel, problems first, with a **Tunnel down** alert. **PPP Users and
  Sessions** reads a router live: disconnect a session, and turn a PPP user or a PPPoE server off
  or on.
- **Netinstall** from a router running RouterOS's netinstall package: install the package,
  entries that name the device to install, the package cache, and starting an install.
- **MLAG**: each pair's state and role, the peer link, settings that differ between peers, and
  heartbeat and host-sync storms from the logs, with an **MLAG degraded** alert.
- **Routing rules** on a device's Routing tab, in order, with what each one looks up.
- **DNS over HTTPS** on Network Services → DNS.
- **WireGuard**: a peer's client `.conf` and QR code, and **Add Peer** can generate the client's
  key pair.
- DHCP, DNS, NTP and PPP open on the device when a site has only one.
- **Reverse proxy** rules on routers, with Let's Encrypt certificates for public hostnames, on a
  new tab of **Operations → Certificates** ([Device certificates](certificates.md#reverse-proxy)).

**Switching, VLANs and bridges** ([Devices](devices.md#bridges))

- VLAN interfaces can be added, edited and removed from the VLANs tab, with addresses, and a
  change to the one the manager reaches the device through is predicted as a lockout.
- **Q-in-Q** (a bridge's VLAN tag type, and a port's tag stacking) and **MVRP**, on bridges,
  bridge VLANs (forbidden ports) and VLAN interfaces.
- A bridge's addresses can be edited from the Bridges tab, and EoIP, wireless, VLAN and other
  interfaces not on the faceplate can be added to a bridge.
- Spanning tree you can set: a **Spanning Tree** card on the topology page for every tree in
  view, and each bridge port's priority, path cost, edge, point-to-point, BPDU guard and
  restricted role and TCN.
- A bridge's MTU can be set, and a port's MTU form says the most its hardware takes.
- **802.1X** on switches and routers: ports that authenticate clients, with RADIUS from User
  Manager or your own server ([802.1X](devices.md#8021x), [User Manager](user-manager.md#8021x-with-user-manager)).
- Drawn ports on the faceplate (RJ45 jacks, SFP cages, QSFP), sized to the device with its model
  name, virtual interfaces in a box of their own, and ports per row remembered per device.
- Config Health finds access ports left tagged in other VLANs.

**Device pages** ([Device tabs](devices.md#device-tabs))

- A **Graphs** tab: history for every chart over one range (1 hour to 30 days), with a shared
  hover cursor, interfaces, connections, NAT, firewall drops and per-core CPU
  ([Device graphs](devices.md#device-graphs)).
- **Peaks and drops**: CPU and memory peaks as a band above the 5-minute average, and dropped
  packets counted.
- A **Firmware** tab for the RouterOS and RouterBOOT check and install.
- **Torch** in Tools: who is talking on an interface right now, flow by flow, narrowed by
  address, port and protocol.
- An **SMS inbox** on the LTE tab, and the data-cap rule can delete the carrier's replies to its
  reset SMS ([Cellular](cellular.md)).
- A **Wireless Systems** device type for outdoor PTP, PtMP and CPE radios, with an **Antenna
  Aligner** tab: live signal from one or both ends of a link and an optional tone
  ([Antenna aligner](antenna-aligner.md)).
- Backups over the API when SSH is off, on RouterOS 7.13 and later
  ([Backups](backups.md#devices-with-ssh-off)).
- **Force add without checking connectivity** in Add Device, for a device that isn't reachable
  yet.
- The **Configuration changed** alert says what changed, as a diff.

**Wireless and CAPsMAN** ([CAPsMAN](capsman.md#set-up-capsman))

- **Set up CAPsMAN** on the Wireless page: a controller and its access points, on both bands or
  one, with a 5 GHz SSID of its own if you want one, on wifi and legacy CAPsMAN.
- A controller with radios of its own shows as **Controller and AP**.
- AP Radio TX Retries remembers the band you picked.

**Topology** ([Topology](topology.md))

- Curved links leaving the bottom of one card and entering the top of the next, with **Links** to
  switch back to straight lines.
- A tiered layout with the gateway on top, then core, access and APs, drawn top-down or
  left-to-right, and **Arrange** to lay the cards out again.
- A **Compact** view of icons with a role chip (Gateway, CAPsMAN, CAP, STP root).
- Port labels on links, short port names, bonds shown at both ends, and parallel links over
  VLAN, VRRP or bond interfaces merged into one with a **+N**.
- Links heard over tunnels drawn dotted; links from OSPF neighbours, for routers reached only
  over tunnels.
- Hosts that send LLDP without a name collapse into one **N hosts** chip.
- Your own firewall, ISP modem or other gateway as a node on top of the map.
- **Export** the whole map as PNG or SVG.
- **Display** holds the Cards, Links, Layout and Port labels choices in one place.

**Clients and sites** ([Clients](clients.md), [Sites](sites.md))

- Client columns can be hidden and resized.
- Clients leaves out the manager's own network devices, and switches, routers and access points
  it doesn't manage.
- **Connection Path** goes from a client's device all the way to the top of the site.
- A site can be placed on the map by latitude and longitude, and has its own map zoom, used
  wherever its devices show; the sites map opens on the default site.

**Dashboard**

- A readable **Capacity & health** card: busiest devices first, shared name prefixes shown once,
  24-hour CPU graphs, and each metric opens its device graph.

**Operations and the manager itself**

- [Jump hosts](jump-hosts.md): reach devices through an SSH connection to another router, with
  RouterOS's reason when forwarding is off.
- **Scheduled bulk commands**, once or repeating ([Bulk commands](commands.md#schedules)).
- **A template from a device**: start a command template from a device's configuration
  ([Templates](commands.md#a-template-from-a-device)).
- **AI connections**: read-only fleet review for AI tools over MCP or OpenAPI, with a token or
  your identity provider ([AI connections](ai-connections.md)).
- **Let's Encrypt** certificates for the manager ([Let's Encrypt](configuration.md#lets-encrypt-acme)).
- **12- or 24-hour time**, as a fleet default and per account
  ([Time display](configuration.md#time-display)).
- **Appearance**: a System theme that follows your computer, seven accent colours or your own,
  and Midnight dark surfaces ([Appearance](configuration.md#appearance)).
- Source builds behind a network proxy (`HTTPS_PROXY`).
- Settings tabs can be linked to and stay put on reload.
- User Manager is in the sidebar only where a device runs it.

**Scale and reliability** ([Polling and scaling](scaling.md))

- Polls no longer stall on large networks: clients are written in batches.
- A device is marked offline only after a number of missed polls in a row (**Missed polls
  before offline**, 2 by default); when most of a site goes quiet at once there's one alert for
  the site; and a reboot the manager sent, a rollout step or a maintenance window doesn't alert.
- Device Logs and Firewall events open quickly on large log tables.
- New major versions underneath: Express 5, BullMQ, openid-client 6, recharts 3, zustand 5 and
  TypeScript 6, and property-based fuzz tests on code that reads outside input.

### Changes you may notice

- **Who sees Settings.** Admins change everything. Fleet operators see every Settings tab
  read-only (SSH Keys apart) and can no longer change alerting, webhooks, report schedules or
  clear the poll queue; write API tokens, which act as an operator, lose them too. Viewers and
  accounts limited to particular sites see only their own account
  ([Who sees Settings](configuration.md#who-sees-settings)).
- **Netinstall and scheduled commands need an admin.** Netinstall changes need an admin for the
  router's site, and a scheduled bulk command runs only while the account that made it is still
  an admin ([Netinstall](network-services.md#netinstall), [Bulk commands](commands.md)).
- **Menu**: Firewall Logs and Sessions moved under **Security**.
- **Zones fold their rules away.** With zones on, a device's Firewall tab reads as zones; the
  chains and jumps that carry them out are behind **Show RouterOS rules**.

### Upgrading from 1.0

1. Update to the latest 1.0.x first if you can, then take a [platform backup](platform-backup.md)
   (**Settings → Backup & Restore**).
2. Get the 1.1 compose file as well as the images, and keep your `.env`
   ([Updating and image versions](configuration.md#updating-and-image-versions)). A 1.0 compose
   file with 1.1 images also starts, so an update half done isn't stuck.
3. Start it. Database migrations run on their own. PostgreSQL and Redis restart once, because
   1.1's compose file pins newer builds of their images (still PostgreSQL 15 and Redis 7).

Going back to 1.0 means restoring that platform backup: migrations only go forwards.

Every security fix made during 1.1 also shipped on 1.0.x, so an up-to-date 1.0 install already
has them ([1.0 release notes](#mikrotik-manager-10)).

### Thank you

1.1 is mostly features people asked for. Thank you to everyone who suggested one, tested a
beta, sent a fix or reported a problem:

- [@ronchan44](https://github.com/ronchan44) (Ron): firewall zones and everything around them
  (custom rules with addresses, hostnames and protocols, logging per zone and per rule, which rule
  logged a line, presets), the Firewall Logs redesign and Sessions, Tunnels & PPP and Netinstall,
  the reverse proxy with Let's Encrypt, scheduled bulk commands, 802.1X with User Manager,
  placing sites on the map and their zoom, routing rules, backups without SSH, drawn ports, Torch,
  the CAPsMAN quick set, NAT rules naming the WAN, dashboard metrics that open their graph, Q-in-Q
  and MVRP, zooming into Traffic, the only device chosen for you, bridge addresses and interfaces
  from the Bridges tab, DNS over HTTPS, AP Radio TX Retries, and testing nearly every beta.
- [@azizfayziev](https://github.com/azizfayziev) (aziz): Traffic from an application to its
  clients, destinations and names; the more readable topology map, with its tiered layout,
  compact view, port labels and export; the Capacity & health card; MLAG monitoring and its peer
  link; the Graphs tab with peaks and drops; Clients leaving out network devices and the
  Connection Path; and code for Firewall Logs' period, **All rules** and **Hide rules** filters
  and for fewer false offline alerts.
- [@eskyuu](https://github.com/eskyuu) (Steven Wilton): Let's Encrypt for the manager, source
  builds behind a proxy, adding a device without checking it first, fewer refreshes from busy
  pages, the RouterBOOT restart check, and Config Health's check of VLAN interfaces as bridge
  ports.
- [@KevinGinger](https://github.com/KevinGinger): jump hosts, and RouterOS's reason when one
  can't forward.
- [@jenserling](https://github.com/jenserling): 12- or 24-hour time, and Wireless Systems with
  the antenna aligner.
- [@JohnDepon](https://github.com/JohnDepon): traffic graphs as rates, and performance on large
  fleets.
- [@davidcoulson](https://github.com/davidcoulson): the Firmware tab, and security reports.
- [@Bigben83](https://github.com/Bigben83): the read-only MCP connector that AI connections grew
  from.
- [@cybr4nx](https://github.com/cybr4nx): Quick firewall rules and zone presets, and resizable
  client columns.
- [@Lithiuhm](https://github.com/Lithiuhm): WireGuard client configs and QR codes.
- [@thanhtrung5763](https://github.com/thanhtrung5763): log tables that open quickly.
- [@pimlie](https://github.com/pimlie): topology links from OSPF, and security reports.
- [@dlemery](https://github.com/dlemery): editing the IPv6 firewall.
- [@rvanderwouw](https://github.com/rvanderwouw): VLAN interfaces on the VLANs tab.
- [@kraken-XIV](https://github.com/kraken-XIV): the System theme and accent colours.
- [@simonkrebsd3](https://github.com/simonkrebsd3): brute-force protection.
- [@kamils777](https://github.com/kamils777): the Configuration changed alert's diff.
- [@HectorUrrea24](https://github.com/HectorUrrea24) (Hector): PPP users and sessions.
- [@Toryius](https://github.com/Toryius) (Manuel): a template from a device.
- [@trackersoft](https://github.com/trackersoft) (Stanley): the SMS inbox and deleting the
  carrier's replies, and readable chart labels.
- [@schmitt330](https://github.com/schmitt330): device tools on RouterOS 6.
- [@orshih6](https://github.com/orshih6): a security report on the release workflow.

## 1.1.0-rc.8

The fix in 1.0.36 below.

## 1.1.0-rc.7

The fixes in 1.0.35 below. On 1.1 the address check also covers the **Bridges** tab.

## 1.1.0-rc.6

The fix in 1.0.34 below.

## 1.1.0-rc.5

The fix in 1.0.33 below, and dependency updates: nodemailer 10.6.1, openid-client 6.9.0,
cron-parser 5.10.6, bullmq 6.7.8, recharts 3.11.0, @tanstack/react-query 5.108.1,
tailwind-merge 3.7.1, and CodeQL 4.39.4 for the security scans.

## 1.1.0-rc.4

The fix in 1.0.32 below.

- **Downloads through a router with a private WAN address are counted for the right client.**
  A router behind an ISP modem or CGNAT (its WAN address 192.168.x, 10.x or 100.64.x) had nearly
  all of its downloads shown in Traffic as **Unattributed (local)**, while uploads went to the
  right clients. Downloads are recorded at the WAN, addressed to the router, and the LAN client
  was taken from the post-NAT address only when the WAN address was public. It is now taken
  whenever that address is local. Traffic already recorded stays where it is. The Traffic page
  docs now say what Unattributed (local) means (Discussion #486, from
  [@godlessmind](https://github.com/godlessmind)).

## 1.1.0-rc.3

The security fix and hardening in 1.0.31 below, from an outside review of rc.1.

- **Viewers and read-only API tokens could read command output, which can contain secrets**
  ([GHSA-rr75-cq8g-v6gq](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-rr75-cq8g-v6gq)). What
  each device printed for a command run, and the run's CSV export, needed only viewer access, and
  only `{{secret:...}}` values were masked in it. A run that printed Wi-Fi or WireGuard keys showed
  them to accounts that see `••••••••` everywhere else. Output is now for operators and admins;
  viewers see each device's status and errors, with a note saying why. If viewers or `read` tokens
  may have read such a run, consider changing those secrets.
- **Removing one device's SSH key could remove another's.** The match was on the start of the key's
  comment, so revoking device 1's key also took device 12's, which then lost SSH. It now matches
  that device's keys only.
- **Changing your password, and setting up or turning off two-factor, have a limit per account**
  (10 tries per 15 minutes), so a stolen session can't keep guessing the account password. The
  two-factor lockout counter can no longer be left without an expiry by a restart.
- **Smaller hardening**: scripts, styles and images carry the same security headers as pages; a
  negative or non-numeric `?limit=` gets the default instead of an error; only admins are told the
  admin account still has its default password; the username in the SSH key import is quoted.

## 1.1.0-rc.2

The fix in 1.0.30 below.

- **Devices that get their updates from the package mirror now show them everywhere.** The
  Firmware page knew the mirror held a newer version for a device, but the Dashboard, the device
  list, the device's Firmware tab, alerts and reports only went by the device's own check with
  MikroTik, which finds nothing on a switch with no internet. They now count the mirror too,
  within about ten minutes of a sync, in Dark Site Mode as well. **Install & Reboot** on such a
  device says to upgrade it with a mirror rollout instead of calling it up to date
  ([Local package mirror](firmware.md#switching-devices-to-the-mirror)). Thanks to
  [@ddavehauser](https://github.com/ddavehauser) for [#482](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/482).

## 1.1.0-rc.1

The first release candidate for 1.1. Nothing new goes in from here, only fixes: please run it as
you would a stable release and [open an issue](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues)
for anything that's wrong. What 1.1 adds is [above](#whats-new-in-11). Since beta.75:

- **An RC install is told about the next RC.** The update notice compared release candidates with
  stable, as it did for 1.0's, so a 1.1 RC wouldn't have heard about rc.2. RCs now compare with
  `dev`, and their images get a version tag (`:1.1.0-rc.1`) as betas do
  ([Release channels](configuration.md#release-channels)).
- **The docs, checked against 1.1**: the device tabs as they are now (802.1X, Bandwidth, Firmware,
  Antenna Aligner, and Torch in Tools), Settings paths that had drifted, who can change alerting,
  DNS query logs and platform backups, and the adoption sweep, which has no button: it's
  `POST /api/adoption/cleanup`.

## 1.1.0-beta.75

The fixes in 1.0.29 below, two of them security fixes, and more hardening from the 1.1
security review.

- **A long version string from a device could stall the manager**
  ([GHSA-vf5h-hmmw-67wq](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-vf5h-hmmw-67wq)),
  **site-limited operators could rename neighbours on other sites' maps**
  ([GHSA-3cq7-qcrg-vqj5](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-3cq7-qcrg-vqj5)), and **RouterBOOT upgrades said a
  device didn't restart when it had**, from Steven Wilton ([@eskyuu](https://github.com/eskyuu))
  on [#481](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/481): see 1.0.29.
- **More hardening**: URLs and paths lose their trailing slashes without a regex that slowed on
  long runs of them; firewall zone names such as `constructor` are only ever names; and three
  more log lines can't be given extra lines by what they quote.

## 1.1.0-beta.74

A security fix, also in 1.0.28, and tighter roles, both from the 1.1 security review.

- **Accounts limited to some sites saw, and could rearrange, other sites' parts of the map**
  ([GHSA-97cq-mgp7-9p5f](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-97cq-mgp7-9p5f)): the fix in 1.0.28 below.
- **Settings by role.** Admins change settings. Fleet operators now see every Settings tab,
  read-only, apart from SSH Keys. They can no longer change alerting rules and channels,
  webhooks or report schedules, or clear the poll queue: those are admin-only now, for write
  API tokens too, since they act as an operator. Viewers, and accounts limited to particular
  sites, see only their own account in Settings: time format and password.
- **Netinstall changes need an admin.** An install wipes whatever netboots on that network,
  so installing or removing the package, entries, the cache and starting an install need an
  admin for the router's site. Operators and viewers see the page read-only.

## 1.1.0-beta.73

- **AP Radio TX Retries says why it's empty under legacy CAPsMAN**: the fix in 1.0.27 below,
  from Ron on [#470](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/470).

## 1.1.0-beta.72

- **Performance on large fleets**, from [@JohnDepon](https://github.com/JohnDepon): the
  changes in 1.0.26 below (no JIT for the app's queries, pages that refresh on their own
  timers, client counts every 15 seconds, no repeated vendor lookups, cheaper log times, and
  a clients table that stays small), plus the wider site list. 1.1 already stored a device's
  clients in batches.
- **Traffic graphs as rates.** **Settings → General → Appearance → Traffic graphs** shows the
  Traffic page and a client's usage and app charts as bits and packets per second (Mbps,
  Kpps) instead of bytes and packets per point, the way links are rated. The newest point is
  divided by the time it has covered so far, so the chart doesn't dip at the end. Also from
  JohnDepon ([#479](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/479)). See
  [Configuration](configuration.md#appearance).

## 1.1.0-beta.71

- **DNS over HTTPS.** **Network Services → DNS** takes a DoH server URL, such as
  `https://cloudflare-dns.com/dns-query`, and the router sends its lookups there over HTTPS.
  **Verify the server's certificate** says whether the router can check it with RouterOS's
  built-in trusted roots, and the page warns when the router would have no way to look up the
  DoH server's own name. See [DNS](network-services.md#dns). Thanks to Ron
  ([@ronchan44](https://github.com/ronchan44)) for
  [#468](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/468).
- **EoIP, wireless and other interfaces into a bridge.** Under a bridge's ports on the
  **Bridges** tab, **+ Add EoIP, wireless, VLAN…** adds interfaces that aren't on the Ports
  tab's faceplate: EoIP, VXLAN, VPLS, veth, VLAN, wifi and wlan. Click a port for **Remove from
  bridge**. Routed interfaces such as WireGuard and GRE are refused with the reason. See
  [Bridges](devices.md#bridges). Also from Ron, on
  [#466](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/466).
- **Log what a zone rule accepts.** A custom rule in a zone pair has a **Log** box, and a pair
  that allows everything can **Log some of it**: the connections that match are logged (up to
  20 a second) and show in Firewall Logs as accepted. See [Zones](devices.md#zones). From Ron
  on [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369).
- **Firewall Logs shows rules in your own chains.** RouterOS logs a rule in a jump chain under
  that chain's name, and those lines were left off the page. They show now, with the chain's
  name, and the zone columns and filters place them correctly.
- **Two zone rule fixes, found by the new fuzz tests.** A custom rule set to **Protocol #** 6
  or 17 with no ports or addresses was dropped on save as if blank; it's now kept as all of TCP
  or UDP, as the form showed. A **Protocol #** 1 rule could be refused for an ICMP type left in
  the hidden ICMP field; that field is now ignored for it. The form also reads spaces inside
  an address the way the server does.
- **Fuzz testing.** Code that reads outside input has property-based fuzz tests in every CI
  run, and a weekly **Fuzz** workflow runs them at far greater length along with
  coverage-guided fuzzing of the NetFlow decoder and the firewall log parser. See
  [CONTRIBUTING.md](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/dev/CONTRIBUTING.md).

## 1.1.0-beta.70

A security fix, also in 1.0.24, reported by [@davidcoulson](https://github.com/davidcoulson);
update as soon as you can.

- **Replacing a device by its serial kept its saved SSH password at the new address**
  ([GHSA-p885-qw7f-rgx2](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-p885-qw7f-rgx2)).
  An operator could point a device at a host that answered with its serial and have the next
  backup log in there with that password. As when a device is edited, the saved SSH login now
  stays only when the address and route are unchanged, or for a fleet admin. Replacing a device
  also needs operator or admin on its site, in single and bulk adds alike.
- **Your firewall or modem on top of the map.** Where the network meets the outside through
  something the manager doesn't manage, add it as a node (Internet, ISP modem, Firewall or
  another vendor's router) and the map hangs everything below it, through the unmanaged
  switches too. A device only goes under one it has a link to: CDP heard through an unmanaged
  switch had put devices under switches they aren't cabled to, and a router off an access
  switch on top. Every detailed card is now the same width, so a device sits centred over the
  ones below it. See [Layout](topology.md#layout).
- **Top down or left to right.** **Display → Layout** draws the map growing down (the default)
  or to the right. **Arrange** lays the cards out again and keeps the sides links attach at;
  **Reset layout** still forgets both.
- **Top Talkers names on the Dashboard** use the row's width instead of stopping at 20
  characters, and **the Dashboard on a phone** stacks its cards instead of squeezing them side
  by side. Also in 1.0.24.

## 1.1.0-beta.69

- **Filter Firewall Logs by zone.** With zones on a device in the selected site or group,
  **From any zone** and **To any zone** narrow the page to traffic from one zone, to one, or one
  direction such as WAN to LAN. **Router** is traffic from or to the router itself. See
  [Zones](firewall-events.md#zones). Thanks to Ron
  ([#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415)).

## 1.1.0-beta.68

- **Less load from the Devices page and Dashboard.** Every device poll told an open Devices page
  or Dashboard to fetch the whole device list again, which on a large fleet meant several times a
  second. They now wait a second and fetch once for everything that changed in it. Also in
  1.0.23. Thanks to eskyuu
  ([#467](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/467)).

## 1.1.0-beta.67

- **Add a device without checking it first.** **Force add without checking connectivity** in
  Add Device saves a device straight away with an unknown status, for one that isn't reachable
  yet. Its first poll connects (finding the API port when none was given) and checks its serial:
  a duplicate of a device in the same site is removed if that device is online, or merged into it
  if not. Until that first poll succeeds it isn't marked offline and can't be synced. See
  [Adding devices](devices.md#adding-devices). Thanks to eskyuu
  ([#441](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/441)).

## 1.1.0-beta.66

- **A bridge's addresses from the Bridges tab.** **Edit** next to a bridge's addresses opens
  them under it: add, change or remove one, through Change Guard as on **Config**, **IP
  Addresses**. See [Bridges](devices.md#bridges). Thanks to Ron
  ([#466](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/466)).
- **The only router is chosen for PPP too.** **PPP Users and Sessions** on Tunnels & PPP opens on
  the router when the selected site or group has just one, as DHCP, DNS and NTP do since
  beta.64. Thanks to Ron
  ([#464](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/464)).

## 1.1.0-beta.65

- **Chart text you couldn't read.** A client's Signal Strength chart drew its Excellent, Good
  and Fair names over bars of the same colour; they sit beside the chart now. Every chart was
  then checked in light, dark and Midnight: axis text is the theme's muted ink throughout,
  tooltips follow the theme, a client's traffic tooltips say Download and Upload again, RF Health
  numbers are dark where white didn't read, and the roaming timeline shows signal as a coloured
  dot. Also in 1.0.22. Thanks to Stanley
  ([Discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85)).

## 1.1.0-beta.64

- **Port ranges in port names.** Under **Settings → Firewall Logs**, a port name can cover a
  range such as `5000-5100`, for TCP, UDP or both. It names every port in it in the Firewall Logs
  Application column and in Traffic; a single port listed too keeps its own name. See
  [Firewall Logs](firewall-events.md#application-and-row-colours). Thanks to Ron
  ([#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415)).
- **The only device is chosen for you.** On DHCP, DNS and NTP under Network Services, a site or
  group with one device opens on that device rather than asking you to choose it. Thanks to Ron
  ([#464](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/464)).

## 1.1.0-beta.63

- **Zoom in on a time in Traffic.** Drag across the Network Traffic or Inbound Packets chart and
  the whole page covers just that window: the totals, the charts in steps down to a minute, Top
  Talkers, Traffic by Application, Top Destinations and the names looked up. **Back to** returns
  to the range you were on. See [Traffic](traffic.md#zooming-in-on-a-time). Thanks to Ron
  ([#463](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/463)).
- **MVRP on VLAN interfaces.** A VLAN interface can declare its VLAN to MVRP neighbours on its
  parent: tick **MVRP** in the VLAN Interfaces card (RouterOS 7.15 and later). See
  [Devices](devices.md#vlan-interfaces)
  ([#449](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/449)).

## 1.1.0-beta.62

- **MVRP forbidden ports.** Adding or editing a VLAN on a bridge running MVRP can name ports
  that never register or declare it, so MVRP can't carry that VLAN over those links (RouterOS
  7.15 and later). The VLANs table lists them when any VLAN has some. See
  [Devices](devices.md#q-in-q-and-mvrp)
  ([#449](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/449)).
- **Editing a bridge VLAN dropped its name.** An edit removes the entry and adds it back, and
  the new one lost the entry's comment, which the manager shows as the VLAN's name, along with
  whether it was disabled and its forbidden ports. All of them carry over now.

## 1.1.0-beta.61

- **Your port names name Traffic's applications too.** A name added under **Settings → Firewall
  Logs** now also names traffic on that port where Traffic would count it as Other TCP or Other
  UDP, so a VPN on UDP 1198 becomes an application of its own in the chart, Where it goes and
  Sessions. Built-in names stay as they are, and traffic already recorded keeps its name. See
  [Traffic](traffic.md#names-for-addresses). Thanks to aziz
  ([#366](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/366)).
- **Top Destinations says when recording began**, so right after the upgrade that added it a
  24-hour view doesn't read as missing traffic.
- **AdGuard Home as a Home Assistant add-on**: how to set its port, and why its **ssl** option
  without certificates stops the add-on, DNS included. See
  [Traffic](traffic.md#names-looked-up-adguard-home-and-pi-hole).

## 1.1.0-beta.60

- **Spanning tree you can set, site by site.** A **Spanning Tree** card under the topology map
  lists every tree in view: its root, and each bridge's priority, root port and cost to the root,
  with the priority editable in place. It warns when one network has split into several trees
  (a link dropping BPDUs, so neither protects the other from a loop), when a root won only by
  having the lowest MAC, and when a root isn't managed. See
  [Topology](topology.md#the-spanning-tree-card).
- **A bridge port's spanning tree.** Click a port on the **Bridges** tab to set its priority and
  path cost, edge, point-to-point, BPDU guard, restricted role and restricted TCN, under Change
  Guard. BPDU guard warns first on a port that's hearing a switch. See
  [Devices](devices.md#a-ports-spanning-tree).
- **Connection Path goes all the way up.** A client's page shows each step from its device to
  the top of the site, with the ports, following spanning tree where it says and neighbour
  discovery where it doesn't. A managed device's own address starts at the device rather than
  leading back to it, a client seen only on uplinks is placed where it really is, and a path
  follows a cable into another site when the neighbour proves which device it is. See
  [Clients](clients.md).
- **The spanning-tree role fix in 1.0.20 below.**
- **Layout.** Traffic: Top Talkers shows five rows and scrolls, beside Traffic by Application at
  the same height, with Top Destinations below it. Dashboard: Devices shows five and scrolls, and
  on Operations so do Capacity & Health (every device, not eight), Security Posture (every
  device, not the worst three) and Recent Activity. A healthy fleet's status dot is a pulsing
  green. Headings across the app are in title case.

## 1.1.0-beta.59

- **Device tools work on RouterOS 6, and Traceroute shows its hops on every version**, as in
  1.0.19 below ([#460](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/460)).

## 1.1.0-beta.58

- **Traffic: where it goes, and the names behind it**
  ([#366](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/366), steps 2 and 3).
  An application's card has **Where it goes**, the Traffic page has **Top destinations**, and a
  client's page lists its own. Each address is named by the organisation that owns it, with its
  country and reverse DNS name, from a list built into each release and refreshed weekly unless
  Dark Site Mode turns that off. Add your AdGuard Home and Pi-hole servers (as many as share a
  site's DNS) under **Settings → DNS Query Log** to see the names each client looked up and which
  were blocked. Destinations, Firewall Logs and Sessions show the name behind each address, from
  AdGuard Home's answers or the DNS cache of routers that answer DNS. See
  [Traffic](traffic.md#where-traffic-goes). Thanks to aziz for the request.
- **WireGuard: a peer's client config and QR code**
  ([#444](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/444), PR #445 by
  [@Lithiuhm](https://github.com/Lithiuhm)). **View** on a peer shows the `.conf` and a QR code
  when the router keeps the client's key, as WinBox's wizard does, and **Add Peer** can generate a
  key pair to do the same. See [Network services](network-services.md#client-config-and-qr-code).
- **802.1X, with User Manager**
  ([#360](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/360)). Switches and
  routers have an **802.1X** tab: ports that authenticate (802.1X and MAC, with guest, reject
  and server-down VLANs), who's authenticated now, RADIUS servers, and a supplicant for an
  uplink, all under Change Guard. User Manager can now add and edit users, with a VLAN for
  802.1X, and link a switch to itself in one step with a fresh shared secret on both ends. See
  [Devices](devices.md#8021x) and [User Manager](user-manager.md#8021x-with-user-manager).
  Thanks to Ron for the request.
- **Zone presets** ([#330](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/330)).
  Setting up zones can start from a preset: home or small office, an office with a guest
  network, a management network, or servers in a DMZ. See [Zones](devices.md#turning-zones-on).
  Thanks to Ron for the idea.
- Dependency updates (Dependabot #450 and #452 to #459).

## 1.1.0-beta.57

Security fixes, reported by [@davidcoulson](https://github.com/davidcoulson); update as soon as
you can.

- **The fixes in 1.0.18 below**: saved alert passwords and tokens stay with the server they
  were saved for, command templates and post-upgrade commands are admin-only, and site checks
  read every spelling of an address the same way.
- **Scheduled commands run only while their creator is an admin**
  ([GHSA-fv5m-vfmw-8h9v](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-fv5m-vfmw-8h9v)).
  A schedule kept running after its creator lost admin, and a tag or site in it could reach
  devices where the creator was only an operator. Those devices are now left out, and a
  schedule whose creator is no longer an admin is marked missed.
- **AI Connections settings are no longer readable by every account**
  ([GHSA-qm4w-hmcg-7rq9](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-qm4w-hmcg-7rq9)).
  The general settings list included them, with the OAuth client secret encrypted. They're now
  read only through their own admin page, like the single sign-on settings.
- **Turning the session log on or off checks the device's site for every spelling of the
  address** ([GHSA-4rjj-7mfg-vrpg](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-4rjj-7mfg-vrpg)).

## 1.1.0-beta.56

- **Firewall Logs: an Application column, and colours for DHCP and multicast**
  ([#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415)). Each line names
  the service behind its port (443 HTTPS, 587 SUBMISSION, 8291 WINBOX) from a built-in list based
  on `/etc/services`. DHCP lines and multicast/broadcast lines are tinted. Change the colours and
  add or rename ports under **Settings**, **Firewall Logs**
  ([how](firewall-events.md#application-and-row-colours)). Thanks to Ron.
- **Bridges: Q-in-Q and MVRP**
  ([#449](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/449)). A bridge's VLAN tag
  type (0x8100, the 802.1ad 0x88a8, or 0x9100) and MVRP, a port's tag stacking and MVRP applicant
  and registrar, and the 802.1ad service tag on VLAN interfaces. A bridge running MVRP lists each
  port's registered and declared VLANs ([how](devices.md#q-in-q-and-mvrp)). Thanks to Ron.

## 1.1.0-beta.55

- **Saving a site could remove its map pin**
  ([#362](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/362)). Changing only a
  site's map zoom, its name or its group cleared its position. A save now changes the pin only
  when it sends one or when the address changes. Also in 1.0.17. Thanks to Ron.

## 1.1.0-beta.54

- **CAPsMAN quick set: a 5 GHz SSID of its own now reaches radios already joined**
  ([#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438)). Legacy CAPsMAN
  applies provisioning rules only when a radio joins, so a joined 5 GHz radio kept the old SSID.
  When the rules change, the setup now provisions the joined radios again (their clients
  reconnect). On wifi CAPsMAN, joined access points take new rules when they next connect, and
  the form says so. Thanks to Ron.
- **A legacy controller's own radios count as its own**
  ([#447](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/447)). A controller
  serving its own wlans showed 0 clients on the Wireless page and a banner calling its own CAP an
  access point not in the fleet. Wireless Settings now marks wlans CAPsMAN manages and shows the
  SSID the controller puts on the air. Thanks to Ron.
- **Capacity & health metrics open their graph**
  ([#448](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/448)). On the dashboard,
  a device's CPU opens its CPU graph and its memory the Memory graph; the name still opens the
  device. Thanks to Ron.
- **The sites map opens on the default site** when it has a pin
  ([#362](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/362)), at its map zoom.
  Thanks to Ron.

## 1.1.0-beta.53

- **CAPsMAN quick set couldn't go back to both bands on legacy CAPsMAN**
  ([#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438)). After a one-band
  run, choosing 2.4 GHz and 5 GHz again stopped with "no such command": legacy `/caps-man` has no
  `unset`, so the band match is now cleared by setting it empty, and the controller's own CAP takes
  both radios again. Thanks to Ron.

## 1.1.0-beta.52

- **CAPsMAN quick set can give 5 GHz an SSID of its own**
  ([#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438)). With both bands,
  tick **A different SSID on 5 GHz**: 2.4 GHz radios take the first SSID and 5 GHz radios the
  second, with the same password. Unticking it removes the second one again. Thanks to Ron.
- **Wifi CAPsMAN is controller only in the quick set.** A wifi controller can't serve its own
  radios through its own CAP, so **Controller and AP** did nothing there, and the only way
  RouterOS offers replaces the radios' own SSIDs and virtual APs for good. Legacy CAPsMAN keeps
  the option. See [CAPsMAN](capsman.md#current-limits).
- **A site's map zoom applies wherever its devices show**
  ([#362](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/362)). The dashboard map
  no longer ignores it when some devices have no site, and centres on the site's pin; a device's
  own map opens at its site's zoom too. Thanks to Ron.

## 1.1.0-beta.51

- **Zones dropped a CAPsMAN's own CAP**
  ([#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369)). A controller that
  serves its own radios has its CAP broadcast discovery in on the loopback interface, `lo`, which
  no zone holds, so the final drop caught and logged it. On RouterOS 7 the loopback rule now
  accepts everything in on `lo`, not only traffic to 127.0.0.1. A device with zones already
  applied says so on its Zones tab: **Apply** once to update the rule. Thanks to Ron for the report.

## 1.1.0-beta.50

- **CAPsMAN quick set with one band took the other band's radio too**
  ([#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438)). On legacy CAPsMAN
  with **Controller and AP**, choosing 5 GHz only handed every wlan to the controller, so the
  2.4 GHz one matched no rule and lost its own SSID. Now only the chosen band's wlans join, and
  running the setup again takes the other band's wlan back out. Thanks to Ron for the report.
- **Known limit:** on wifi CAPsMAN, **Controller and AP** doesn't hand the device's own radios over
  yet; they keep their own settings. See [CAPsMAN](capsman.md#current-limits).

## 1.1.0-beta.49

- **Firewall Logs can hide rules**, from aziz's request and patch in
  [#446](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/446). **Hide rules** shows
  everything except the rules you pick, for example a busy drop rule you already know about. It
  hides a rule on its own device only, works in the grouped view too, and remembers your choice in
  this browser. Up to 20 rules.
- **Rules that would read the same in All rules show their tags**
  ([#443](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/443)), so two rules with
  the same comment on one device can be told apart.
- **After an update, the dashboard said the latest release was older than the one running**
  ([#443](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/443)). Also in 1.0.16.

## 1.1.0-beta.48

- **Firewall Logs can show one rule's lines**, from aziz's request and patch in
  [#443](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/443). **All rules** sits
  next to actions and protocols. It lists the log prefixes that logged in the period, busiest
  first, named by the rule's comment when a device is picked. Unlike the search box, it matches
  the whole prefix, so `PERMIT-ZT` doesn't bring in `PERMIT-ZT-ADMIN`. Picking a rule picks its
  device too. See [Firewall Logs](firewall-events.md).

## 1.1.0-beta.47

- **Fewer false "device offline" alerts**, from aziz's report and patch in
  [#442](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/442). A device is marked
  offline only after a number of missed polls in a row (**Missed polls before offline** in
  Settings → Alerting, 2 by default), and when most of a site goes quiet at once you get one
  alert for the site, and one "back online" for it, instead of one per device. See
  [When a device counts as offline](alerting.md#when-a-device-counts-as-offline).
- **Polls no longer stall on large networks** (#442). Clients were written to the database one
  at a time, and a campus switch sees every MAC on the network, so polls queued behind each other
  and some ran out of time, which made healthy devices look offline. They're now written in
  batches. Poller health also shows how long the server was busy and how many database queries
  were waiting in the last 15 seconds. See [Is it keeping up?](scaling.md#is-it-keeping-up).
- **Down on purpose doesn't alert** (#442). A reboot sent from the manager (Reboot, RouterBOOT
  upgrade, firmware rollout), a rollout step in progress, or a maintenance window holds the alert.
  If the device is still down afterwards, it alerts then. Maintenance windows used to hide the
  alert and never send one later.
- **Set up CAPsMAN on one band**, from Ron's request in
  [#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438). **Radios** picks
  2.4 GHz and 5 GHz, 2.4 GHz only or 5 GHz only, so a 5 GHz network can be tried without touching
  an existing 2.4 GHz one. See [Set up CAPsMAN](capsman.md#set-up-capsman).
- **Source builds behind a proxy**, from eskyuu in
  [#436](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/436): set `HTTPS_PROXY`
  in `.env` and `docker compose build` uses it. The GHCR images don't need it. See
  [Configuration](configuration.md).
- **The faceplate fits the device**: it's sized to the ports and centred, with the model name top
  right as on the real device, and virtual interfaces in their own box. See
  [Ports and the faceplate](devices.md#ports-and-the-faceplate).

## 1.1.0-beta.46

- **Set up CAPsMAN**, from Ron's request in
  [#438](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/438). The Wireless page
  has a **Set up CAPsMAN** button: pick a device, an SSID, a password and a bridge, and it becomes
  a CAPsMAN controller (wifi or legacy), either controller only or serving its own radios too.
  Running it again on the same device changes the same setup. It goes through Change Guard and
  Review changes. See [Set up CAPsMAN](capsman.md#set-up-capsman).
- **A controller with radios of its own shows as Controller and AP.** A wifi controller whose own
  radios are managed by it was shown as Controller only.
- **Log drops per zone**, from Ron in
  [#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415). Each zone has a
  **Log drops** checkbox, so a noisy zone such as WAN can stay out of Firewall Logs while the
  rest still logs. See [Zones](devices.md#zones).
- **Logged drops are capped at 5 a second**
  ([#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369)). Logging every
  dropped packet kept rebooting Ron's hAP ac². The final drops now log at most 5 packets a second
  and drop the rest unlogged. Zones applied before this keep logging every drop until they're
  applied again; the Zones card says so and **Apply** updates them.

## 1.1.0-beta.45

- **Firewall Logs looks more like Ron's mockup** in
  [#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415): zones show as
  coloured badges (untrust/WAN red, trust/LAN green, DMZ/guest amber, Router grey, any other zone
  its own colour), each action has an icon, and the pager has page numbers with "Showing 1–100 of
  N". See [Zones](firewall-events.md#zones).
- **NAT rules can name the WAN interface**, from Ron's request in
  [#440](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/440). The Custom pattern
  has In. Interface and Out. Interface, so a netmap can say which uplink it uses, and 1:1 NAT has
  an optional WAN in-interface. The rule summary names the interface.

## 1.1.0-beta.44

- **Firewall Logs reads in zones**, from Ron's request in
  [#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415). On a device running
  [zones](devices.md#zones), In and Out become **From zone** and **To zone**, with "Router" for
  traffic to or from the router itself, and the chain is left out. A device already on zones
  shows them within the hour, or as soon as its Zones tab is opened.
- **Resolve names** on Firewall Logs shows client hostnames and reverse DNS in place of
  addresses, with the address on hover (#415). Off by default. See
  [Resolve names](firewall-events.md#resolve-names).

## 1.1.0-beta.43

- **nginx kept restarting after updating to beta.42** with an existing compose file
  ([#439](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/439), reported by Ron).
  The Let's Encrypt support needed a directory that only the new compose file provided, and on
  the read-only container nginx stopped before starting. It now uses space every compose file
  already has, so no compose change is needed, and if it can't, Let's Encrypt turns off and nginx
  starts anyway. The `acme_challenge` volume is gone from the compose files; an existing one is
  unused and can be removed with `docker volume rm`.

## 1.1.0-beta.42

- **Let's Encrypt certificates for the manager**, contributed by eskyuu in
  [#420](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/420). With a public DNS name
  and port 80 open, **Settings → Certificate** can get and renew a certificate by itself, show the
  last Certbot attempt, and use staging or a private ACME server with its own CA. The settings can
  also come from `.env`. Nothing changes until a domain is set. See
  [Let's Encrypt](configuration.md#lets-encrypt-acme).
- The nginx image is about 100 MB larger, for Certbot.

## 1.1.0-beta.41

- **Zone rules can name a hostname**, from Ron's request in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369): trust to untrust on
  587 to `smtp.outlook.com`, say. The router keeps an address list of every address the name
  resolves to, and the rule matches the list. See [Zones](devices.md#zones).
- **Zones can limit what the manager reaches on the router** to the API, API-SSL and SSH ports,
  the only ones it uses, instead of everything (#369).
- **Each site can have a map zoom** (#362): 1 (the world) to 19 (a building), 12 being about
  street level. The dashboard map opens at it when it shows only that site's devices. See
  [Sites](sites.md).
- **Switching to API-SSL or HTTPS explains "not enough permissions"**
  ([#417](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/417)): which step the
  router refused, and that the user the manager logs in as needs the `full` group or the missing
  policies.
- **A bridge's MTU can be set**, from the bridge's **Edit** on the **Bridges** tab: a number, or
  `auto` for RouterOS's default. It's the MTU for the router's own traffic on the bridge; jumbo
  frames switched between ports only need the ports' MTU raised. A bridge can't carry more than
  the smallest L2 MTU of its ports, and RouterOS only answers "could not set mtu", so the manager
  says which ports are too small, and which can't go higher at all and have to leave the bridge.
  See [Bridges](devices.md#bridges).
- **A port's MTU stops at what its hardware takes**, and the form says what that is ("up to 10218
  on this port"). RouterOS quietly kept a lower MTU than asked when a port couldn't take it (a
  CRS510's management port stops at 2028), and the save reported success; now the manager
  refuses it, and says so if the device keeps a different value. The fixed 9216 limit is gone,
  so CRS3xx and CRS5xx ports can go to 10218. See [A port's MTU](devices.md#a-ports-mtu).
- **Saving a port no longer lowers its L2 MTU.** Every save sent the MTU, and setting it also
  set the L2 MTU to the MTU plus 8, so a comment edit on a port raised for VLAN tags or jumbo
  frames brought it back down. The MTU is now sent only when it changes, and the L2 MTU is only
  ever raised.

## 1.1.0-beta.40

- **Zone rules can be ICMP, or any IP protocol by number**, from Ron's request in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369). A custom rule can
  allow ICMP of one type (`8`) or type and code (`3:4`), or every type, and **Protocol #** takes a
  protocol number such as `89` for OSPF or `47` for GRE. Both can take a source and destination
  address. See [Zones](devices.md#zones).
- **Zones are easier to edit.** The matrix says that a cell opens what one zone can reach in
  another, and a zone that holds bridge ports says so on the zone itself. Rules can't see traffic
  through a bridge port, so the warning says what to use instead.
- **Switching to API-SSL or HTTPS works behind Cloudflare**, as in 1.0.14 below.

## 1.1.0-beta.39

**This update restarts Postgres, Redis and InfluxDB once**, because their settings changed. Your
data stays as it is.

- **Redis repairs a damaged data file instead of refusing to start, and the databases get 60
  seconds to stop cleanly**, as in 1.0.13 below. See
  [The databases during an update](configuration.md#the-databases-during-an-update).

## 1.1.0-beta.38

- **Zone rules can name addresses**, from Ron's request in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369). A custom rule in a
  zone pair now takes a source and a destination as well as ports: an address, a subnet or a range,
  with TCP, UDP or any protocol. WAN to DMZ can let one partner reach one server on 443, and LAN
  to the router can take SSH from the admin subnet only. Setups saved before keep exactly the rules
  they had. See [Zones](devices.md#zones).
- **Firewall Logs: a period, and logged rules on the Firewall tab**, contributed by aziz in
  [#437](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/437). Firewall Logs reads
  the last hour, 24 hours, 7 days or 30 days, in Grouped and Raw, and a link can open it with
  `?range=`. **Logged (N)** on the Firewall tab shows only the rules that log.
- **Clients hides more network devices**
  ([#363](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/363)): switches, routers
  and access points the manager doesn't manage, when they announce themselves over LLDP, CDP or
  MNDP as one. An IP phone that also reports itself as a bridge stays a client.
- **Clients no longer kept online by stale ARP entries, mirror rollouts on 16 MB-flash devices,
  and the CRS354's QSFP+ cages**, as in 1.0.12 below.
- **Dependencies**: vitest 5, vite 8.3.6, react-router 7.18.5, TanStack Query 5.106.1, lucide
  1.70, openid-client 6.8.9, otpauth 9.6.0, bullmq 6.7.1, and current Postgres, Redis and nginx
  images.

## 1.1.0-beta.37

- **Trunk ports carry a native VLAN**, as in 1.0.11 below: a trunk now accepts untagged frames
  into its native VLAN instead of dropping them, so a device that doesn't use VLANs works on a
  trunk port. **Tagged only** in the port editor keeps the old behaviour. See
  [Changing a port's VLAN](devices.md#changing-a-ports-vlan).

## 1.1.0-beta.36

- **PPP users and sessions**, from Hector's request in
  [Discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85):
  **Tunnels & PPP** now reads one router's PPPoE servers, sessions and PPP users live. Operators
  can disconnect a session, turn a PPP user off or on, and turn a PPPoE server off or on. User
  and server changes run under Change Guard and can be reviewed first, and everything is in the
  audit log. Passwords aren't read. See
  [PPP users and sessions](network-services.md#ppp-users-and-sessions).
- **Clients leaves out your network devices**, as promised in
  [#363](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/363): the MAC addresses
  of managed devices (any interface or radio) and VRRP's virtual MACs no longer show as clients.
  The filter bar says how many are hidden, with **show** to bring them back.
- **Place a site on the map by hand**, as promised in
  [#362](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/362): when editing a
  site, type a latitude and longitude or press **Pick on map** and click. It wins over the
  address, for sites the geocoder can't find or puts in the wrong place. See
  [Sites](sites.md).
- **A template from a device**, from Manuel's idea in
  [Discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85):
  **Templates → From a device…** reads DNS, NTP, IP services, SNMP, remote syslog and the time
  zone off a device you've set up, and writes them as the commands that set them, in a new
  template to check before saving. Nothing secret is taken. See
  [A template from a device](commands.md#a-template-from-a-device).
- **Zones hide the RouterOS rules behind them**, from Ron's request in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369). With zones on, the
  Firewall tab reads as zones and what each can reach: the chains, jumps and returns that carry
  them out are folded away. **Show RouterOS rules** opens them, with their counters, and the
  browser remembers the choice. Following a log line's link to its rule opens them too.
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

## 1.1.0-beta.35

- **Sessions**, the second part of Ron's
  [#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415): a new
  **Security → Sessions** page lists connections from NetFlow, one row each, the way a Palo Alto
  or Check Point traffic log reads. Each row has the client and server, the addresses NAT
  changed, application, bytes and packets each way, duration, and how it ended (closed, reset
  by client or server, no reply, aged out). Both directions of a connection, which RouterOS
  exports separately, become one row, through masquerade and port forwards too, and a long
  connection stays one row as it goes on. Turn it on per router with the new **Sessions**
  switch on **Network Services → NetFlow**; it is off by default and kept for 3 days. See
  [Sessions](sessions.md).
- **Menu: Firewall Logs and Sessions move under Security.** **Security** opens the security
  page as before and now unfolds to **Firewall Logs** and **Sessions** under it. **Events** is
  a single entry for device logs. Page addresses haven't changed, so bookmarks still work.
- **Routers behind NAT are recognised.** When NAT sits between the routers and MikroTik Manager,
  their flows all arrive from one address and couldn't be told apart. Now each router is
  recognised by when it booted, which every NetFlow packet carries and polling records, so its
  flows count under its own name and site on Traffic and NetFlow. Two routers that booted
  together still can't be told apart.
- **Zones on routers without FastTrack offload**, fixing Ron's failed **Turn on zones** in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369): the FastTrack rule
  was always written with `hw-offload=yes` on RouterOS 7, and some builds don't take that
  parameter, so the whole change was refused and Change Guard put the old firewall back.
  MikroTik Manager now asks the router which parameters a firewall rule takes and adds
  `hw-offload` only where it is listed. The **Forward basics** preset had the same problem and
  the same fix.

## 1.1.0-beta.34

- **Torch**, from Ron's request in
  [#416](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/416): a new card on a
  device's **Tools** tab shows the traffic on an interface live, flow by flow, refreshed every
  second, busiest first. Narrow it by source, destination, port and protocol. It stops when you
  press Stop or leave the page, and by itself after 10 minutes, and a device runs at most two at
  once ([Torch](devices.md#torch)).
- **Firewall Logs open grouped**, the first step on Ron's
  [#415](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/415): one line per device,
  rule, interfaces, protocol, source, destination and port, with a count and first and last seen,
  the way Palo Alto and Check Point show their logs. Retries and scans no longer fill the page.
  **Raw** shows every line as before, and a group's count opens its lines
  ([Grouped and raw](firewall-events.md#grouped-and-raw)). Lines on the input chain no longer show
  an output interface of "(unknown".
- **Zones**: **Review changes** works while Change Guard is holding the device after an earlier
  change. It only reads, but it was refused with "a protected change is still in progress"
  ([#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369)).
- Running and scheduling **bulk commands** is now for admins too, as in 1.0.9; operators can still
  cancel a run. Schedules an operator saved earlier keep running.
- Fixes from 1.0.9.

## 1.1.0-beta.33

- **Zones**, phase 2 of Ron's
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369): on the Firewall tab,
  group interfaces into zones and fill in a matrix of what each zone can reach, the other zones and
  the router itself: deny, everything, or chosen services and ports. MTM writes the whole IPv4
  filter table from it, one chain per open pair, and reports any change made outside MTM as drift,
  on the card and in Config Health. Applying keeps the rules that are already right and runs through
  Change Guard ([Zones](devices.md#zones)).
- **Change Guard**: Quick rules and **Tag all** now get a script-mode restore of just the firewall
  tables they touch, so with script mode on a revert no longer reboots the device.
- **Drawn ports** on the Ports tab, from Ron's mockup in
  [#412](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/412): RJ45 jacks, SFP cages,
  QSFP28 and QSFP-DD cages, and broken-out cages as their lanes in one cage outline, with link and
  activity lights. Up ports take your accent colour. **Settings → General → Appearance → Faceplate
  ports → Tiles** brings back the old squares ([Appearance](configuration.md#appearance)).
- Broken-out QSFP lanes are labelled `1/1`, `1/2` and so on again, rather than `qsfp`.
- The faceplate's ports-per-row choice is remembered for each device, in this browser. A device
  you haven't set yet uses the last choice you made.
- **AP Radio TX Retries** remembers the band you picked, in this browser
  ([#410](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/410)).
- Fixes from 1.0.8.

## 1.1.0-beta.32

- **Scheduled bulk commands**, from Ron's request in
  [#359](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/359): **Schedule…** on
  Bulk Commands runs a command once, daily, weekly or monthly, or on your own cron expression, on
  chosen devices plus every device with a tag or in a site at the time it runs. Options to run only
  inside maintenance windows and to alert when it fails or doesn't run (a new **Scheduled command
  failed** alert). A time that passes while the manager is down is marked missed, never run late
  ([Schedules](commands.md#schedules)).
- **Which rule logged it**, from Ron's request in
  [#369](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/369): a firewall or NAT rule
  that logs gets a short tag in its log prefix, so a line on Firewall Events links to its rule, and
  a rule links to its lines. **Tag all** on the Firewall tab tags rules made elsewhere
  ([Which rule logged it](firewall-events.md#which-rule-logged-it)).

## 1.1.0-beta.31

- **Appearance**: a **System** theme that follows your computer's light or dark setting, seven
  accent colours or your own, and **Midnight** dark surfaces, under Settings → General, from
  [@kraken-XIV](https://github.com/kraken-XIV)'s proposal in
  [#329](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/329)
  ([Appearance](configuration.md#appearance)). Blue on Slate looks exactly as before.
- **Routing rules** on a device's Routing tab, from Ron's request in
  [#370](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/370): in order, each
  lookup's table and routes, and flags for a rule that repeats or is covered by an earlier one, a
  missing table, or a table with no active routes; add and remove through Change Guard
  ([Routing rules](devices.md#routing-rules)).
- **Traffic**: click an application to see the clients behind it, with each one's share, from
  [@azizfayziev](https://github.com/azizfayziev)'s
  [#366](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/366) step 1
  ([Traffic](traffic.md#what-it-shows)).
- **Graphs**: VRRP interfaces are left out of the busiest pick (their traffic is already counted on
  the VLAN and bond under them), and a PPPoE client's utilisation uses its port's speed
  ([#402](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/402)).
- **Topology**: a link coloured by hand still turns red when it goes down or is blocked
  ([#403](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/403)).
- From 1.0.7: stale Change Guard restore points are cleared from devices, Postgres gets 256 MB of
  shared memory, and `minimatch` is updated in the build tooling.

## 1.1.0-beta.30

- **Device Logs and Firewall events open quickly on large log tables**, from
  [@thanhtrung5763](https://github.com/thanhtrung5763)
  ([#407](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/407)): indexes for the rows
  each page shows, built in the background after startup; pages read only the columns they show,
  keep the table on screen while the next page loads, and wait for you to stop typing before
  searching.
- **Config Health** no longer flags a VLAN interface added as a bridge port when it's an edge
  port, since an edge port sends no BPDUs, and says why the setup is a problem (the bridge's
  BPDUs go out tagged), from [@eskyuu](https://github.com/eskyuu)
  ([#404](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/404))
  ([What it checks](change-guard.md#what-it-checks)).

## 1.1.0-beta.29

- **Graphs, interfaces**, from [@azizfayziev](https://github.com/azizfayziev)'s check on beta.28
  ([#402](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/402)): the busiest pick
  no longer counts the same traffic twice (a bond rather than its members, a PPPoE client rather
  than its port); the picker lists ports in number order; a bond's utilisation uses its running
  members' speed together, and a port with no known speed is named; and a series that started
  inside the range says **Recorded since** ([Device graphs](devices.md#device-graphs)).
- **SMS inbox** on the LTE tab, and the data-cap rule can **delete the carrier's replies** to the
  reset SMS, from Stanley's request in
  [discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85)
  ([SMS inbox](cellular.md#sms-inbox)).

## 1.1.0-beta.28

- **Graphs**, a new device tab, from [@azizfayziev](https://github.com/azizfayziev)'s proposal
  ([#402](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/402), steps 2–4): CPU with
  peaks and per core, memory, connections (active, by protocol, NAT translations, new per second),
  firewall drops per chain with the top drop rules, several interfaces at once with utilisation and
  packets per second, and temperatures. One range for the tab, a shared hover cursor, section
  summaries, and sections only where the device has the data
  ([Device graphs](devices.md#device-graphs)).
- MLAG's **last flap** recognises a reboot whose RouterOS took minutes to come back (the link drops
  when the reboot starts), from [@azizfayziev](https://github.com/azizfayziev)'s check on his WAN
  pair ([#376](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/376)).
- **Brute-force protection**, a new Quick rules preset, from
  [@simonkrebsd3](https://github.com/simonkrebsd3)'s request
  ([#405](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/405)): bans an address that
  keeps opening new connections to SSH, WinBox, FTP, Telnet or a VPN server (L2TP/IPsec, PPTP,
  OpenVPN, SSTP), for an hour, a day or a week. The manager and any addresses you choose are never
  banned. Banned addresses show on the Firewall tab, with **Unban** and **Never ban**, and across
  the fleet on the Security page ([Brute-force protection](devices.md#brute-force-protection)).
- The **Configuration changed** alert says what changed, as a diff, from
  [@kamils777](https://github.com/kamils777)'s request
  ([#406](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/406)), cut to fit each
  channel ([Alerting](alerting.md)).
- Quick rules finds the manager's own address on devices without connection tracking (most
  switches), from its API session, so Management access adds it there too.

## 1.1.0-beta.27

- **Quick firewall rules**, from [@cybr4nx](https://github.com/cybr4nx)
  ([#330](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/330)): **Quick rules** on the
  Firewall tab adds presets close to MikroTik's defconf: input basics, management access (WinBox,
  SSH, the API and WebFig only from an address list, the manager's own address included), forward
  basics with optional FastTrack, and masquerade, with IPv6 versions of the input and forward
  presets. You choose the LAN and WAN, the dialog shows each rule and where it goes, rules already
  there are skipped, and Change Guard checks the whole preset against the manager's connection first.
  The Security tab's missing input firewall finding opens it
  ([Quick firewall rules](devices.md#quick-firewall-rules)).
- Follow-ups from [@azizfayziev](https://github.com/azizfayziev)'s testing of beta.26:
  - **Peaks** on the Hardware tab's CPU and memory chart are a light band from the average up to the
    peak, instead of a dashed line that zig-zagged; memory's only where it differs by more than two
    points, and the chart is taller ([#402](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/402)).
  - A port's **Errors & drops** says "0 errors · 0 drops in this range" when there were none, so it's
    clear it was checked.
  - MLAG's **last flap** is marked **(reboot)** when a peer restarted around then
    ([#376](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/376)).

## 1.1.0-beta.26

- **MLAG peer link**, from [@azizfayziev](https://github.com/azizfayziev)'s proposal
  ([#376](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/376)): a block of its own
  between the two peers, with each member side by side (state, speed, link-downs, errors in the
  last 24 hours), the VLANs it carries with VLAN 1 called out, a check that each side's LACP partner
  is the other peer, and the last flap. A peer link cabled to another device is a critical finding.
  Peers are also paired when neighbour discovery only reports the link from one end
  ([MLAG](network-services.md#mlag)).
- **Peaks and drops**, from [@azizfayziev](https://github.com/azizfayziev)
  ([#402](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/402), the first step):
  CPU and memory history on the **Hardware** tab shows the highest reading in each 5 minutes as a
  dashed line over the average, and a port's traffic panel shows its **Errors & drops** on their
  own scale. Drop counters are recorded from this release.
- **Let's Encrypt for reverse proxy rules**, for [@ronchan44](https://github.com/ronchan44)
  ([#358](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/358)): for a public host
  name, choose **Let's Encrypt** as the rule's certificate. The router requests it (RouterOS 7.22 and
  later) and renews it itself; the rule shows its progress, Let's Encrypt's reason if it fails, and
  **Try again**, **Get the real certificate** (after testing on the staging server) and **Renew now**
  ([Let's Encrypt](certificates.md#lets-encrypt)).
- **Change Guard leaves no restore points behind.** Each protected change saves a restore point
  on the device and removes it afterwards, but one could be left on its flash when a revert fired,
  the manager restarted mid-change, or the device couldn't be reached to clean up. Every protected
  change now also removes older restore points whose revert is no longer armed.

## 1.1.0-beta.24

- **Firmware tab** on the device page, from [@davidcoulson](https://github.com/davidcoulson)
  ([#400](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/400),
  [#401](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/401)): the RouterOS and
  RouterBOOT check and install moved off the Config tab into a tab of their own, between Config and
  Config History, with a link to the fleet Firmware page. The dashboard's "Updates available"
  banner opens each device's Firmware tab, and has its own link to upgrade several devices
  ([Firmware](firmware.md)).
- **MLAG** fixes from [@azizfayziev](https://github.com/azizfayziev)'s testing
  ([#376](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/376)):
  - The first poll after an upgrade no longer counts as a state or role change, which had turned
    every pair amber for a day.
  - A pair with only warnings is labelled **warning**, not **degraded**.
  - A bond set up for a switch that isn't cabled yet shows as grey **unused** rather than red.
    One that was up and went down on both peers stays red, with a warning.
  - The primary is on the left in every pair.

  ([MLAG](network-services.md#mlag))

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

## 1.0.36

Released on Wednesday 25 November 2026. A fix for static routes.

- **A route with an invalid destination is refused before you add it.** The **Routing** tab
  took a destination such as 10.100.32.256/24, Review changes didn't flag it, and only the
  router refused it at apply. The form now says why and holds **Add Route** and **Review
  changes** until it's fixed, and the server refuses the same. A gateway that reads as an
  address but isn't one (192.168.1.256) is refused too. Thanks to
  [@ronchan44](https://github.com/ronchan44) (Ron) for the report
  ([#505](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/505)).

## 1.0.35

Released on Tuesday 24 November 2026. Two fixes from Ron's reports.

- **Editing an IP address has Review changes.** Changing an address in place on the device's
  **Config** tab now has a **Review changes** button, as adding one does, so you see what the
  change does before you save it. An address that is the network or broadcast address of its
  prefix, such as 192.168.33.0/24 or 192.168.33.255/24, is refused, with a host address
  suggested. Thanks to [@ronchan44](https://github.com/ronchan44) (Ron) for the report
  ([#505](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/505)).
- **The Connected Clients tooltip shows whole clients.** It read 3.8 when the chart averaged
  samples; it now rounds to 4 ([#504](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/504)).

## 1.0.34

Released on Tuesday 24 November 2026. A fix for CAPsMAN.

- **A CAP's Connected Clients chart counts its clients.** On a CAP of the legacy CAPsMAN, the
  chart on the device's **Radios** tab read 0 all the time: the CAP's own registration table is
  empty, since its clients are listed on the controller. It now takes the controller's count for
  that radio when it's the higher one. Thanks to [@ronchan44](https://github.com/ronchan44) (Ron)
  for the report ([#504](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/504)).

## 1.0.33

Released on Monday 23 November 2026. A label fix for Traffic.

- **Traffic's data health labels say what they count.** **Attribution rate** counted packets from
  a device MTM recognised as the exporter, not packets matched to a client, so it could read 100%
  while **Unattributed (local)** was large. It's now **From known exporters**, and **Flows
  attributed** is now **Flows counted**, since it includes flows in Unattributed (local). Thanks to
  [@godlessmind](https://github.com/godlessmind) for the screenshots
  ([Discussion #486](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/486)).

## 1.0.32

Released on Sunday 22 November 2026. A fix for Traffic.

- **Downloads through a router with a private WAN address are counted for the right client.**
  A router behind an ISP modem or CGNAT (its WAN address 192.168.x, 10.x or 100.64.x) had nearly
  all of its downloads shown in Traffic as **Unattributed (local)**, while uploads went to the
  right clients. Downloads are recorded at the WAN, addressed to the router, and the LAN client
  was taken from the post-NAT address only when the WAN address was public. It is now taken
  whenever that address is local. Traffic already recorded stays where it is. The Traffic page
  docs now say what Unattributed (local) means (Discussion #486, from
  [@godlessmind](https://github.com/godlessmind)).

## 1.0.31

Released on Saturday 21 November 2026. A security fix, and hardening from an outside review of
1.1; update soon if you have viewers or `read` API tokens.

- **Viewers and read-only API tokens could read command output, which can contain secrets**
  ([GHSA-rr75-cq8g-v6gq](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-rr75-cq8g-v6gq)). What
  each device printed for a command run, and the run's CSV export, needed only viewer access, and
  only `{{secret:...}}` values were masked in it. A run that printed Wi-Fi or WireGuard keys showed
  them to accounts that see `••••••••` everywhere else. Output is now for operators and admins;
  viewers see each device's status and errors, with a note saying why. If viewers or `read` tokens
  may have read such a run, consider changing those secrets.
- **Removing one device's SSH key could remove another's.** The match was on the start of the key's
  comment, so revoking device 1's key also took device 12's, which then lost SSH. It now matches
  that device's keys only.
- **Changing your password, and setting up or turning off two-factor, have a limit per account**
  (10 tries per 15 minutes), so a stolen session can't keep guessing the account password. The
  two-factor lockout counter can no longer be left without an expiry by a restart.
- **Smaller hardening**: scripts, styles and images carry the same security headers as pages; a
  negative or non-numeric `?limit=` gets the default instead of an error; only admins are told the
  admin account still has its default password; the username in the SSH key import is quoted.

## 1.0.30

Released on Saturday 21 November 2026.

- **Devices that get their updates from the package mirror now show them everywhere.** The
  Firmware page knew the mirror held a newer version for a device, but the Dashboard, the device
  list, the device's own page, alerts and reports only went by the device's own check with
  MikroTik, which finds nothing on a switch with no internet. They now count the mirror too,
  within about ten minutes of a sync, in Dark Site Mode as well. **Install & Reboot** on such a
  device says to upgrade it with a mirror rollout instead of calling it up to date
  ([Local package mirror](firmware.md#switching-devices-to-the-mirror)). Thanks to
  [@ddavehauser](https://github.com/ddavehauser) for [#482](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/482).

## 1.0.29

Released on Friday 20 November 2026. Two security fixes from the 1.1 security review, and a
RouterBOOT fix from Steven Wilton ([@eskyuu](https://github.com/eskyuu)); update soon.

- **A long version string from a device could stall the manager**
  ([GHSA-vf5h-hmmw-67wq](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-vf5h-hmmw-67wq)). The poller compares the RouterBOOT
  versions a device reports before storing them, and the parser slowed with the square of their
  length: 200,000 characters held up the web UI, API and polling for about 19 seconds. Real
  RouterOS doesn't send such a thing, but a fake RouterOS API server added as a device could.
  Version strings are now cut to 64 characters before they're read.
- **Site-limited operators could rename neighbours on other sites' maps**
  ([GHSA-3cq7-qcrg-vqj5](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-3cq7-qcrg-vqj5)). The part of 1.0.28's fix that was
  missed: the name and type of a discovered neighbour, which show on every site's map. A
  site-limited account now names only the neighbours on its own part of the map.
- **RouterBOOT upgrades said a device "didn't restart when asked (twice)" when it had.** The
  check compared uptime with a reading taken just after the first reboot, so a device that took
  longer than that to come back from the second looked like it never went down. It now counts
  the time since that reading, and a changed bootloader version also proves the restart. Thanks to
  Steven Wilton ([@eskyuu](https://github.com/eskyuu)) for [#481](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/481).
- **Hardening from the review**: pasted certificates are read in linear time (a 10 MB field of
  BEGIN lines took a long while), and generated command secrets use every character equally
  often.

Also in 1.1.0-beta.75.

## 1.0.28

Released on Friday 20 November 2026. A security fix; update soon if you use per-site roles.

- **Accounts limited to some sites saw, and could rearrange, other sites' parts of the map**
  ([GHSA-97cq-mgp7-9p5f](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-97cq-mgp7-9p5f)). The discovered-devices list showed neighbours
  heard anywhere in the fleet, with their addresses and the names of devices managed in other
  sites, and the topology map sent every site's hidden links, positions and link colours. An
  operator in one site could also move, recolour, hide or show links on another site's map. A
  site-limited account now sees only what its own sites' devices heard and its own part of the
  saved map, and changes it only where it's an operator or admin. No device logins or settings
  were exposed. Found in the 1.1 security review.

Also in 1.1.0-beta.74.

## 1.0.27

Released on Thursday 19 November 2026.

- **AP Radio TX Retries says why it's empty under legacy CAPsMAN.** The card works from each
  client's CCQ, which a legacy `wireless` radio reports in its own registration table. Once
  CAPsMAN manages the radio, its clients show only on the controller, whose
  `/caps-man registration-table` has no CCQ, so there is nothing to chart. The card now says
  so, rather than suggesting only Wi-Fi 6/7 radios lack it. Thanks to Ron
  ([@ronchan44](https://github.com/ronchan44)) for
  [#470](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/470) and the prints that
  confirmed it.

Also in 1.1.0-beta.73.

## 1.0.26

Released on Thursday 19 November 2026. Performance on large fleets, all from
[@JohnDepon](https://github.com/JohnDepon), who measured MikroTik Manager polling 126 devices
and fixed what held it back, one cause at a time. On that install the database went from
about 365% CPU to 13%, and polls stopped timing out and marking healthy devices offline.

- **The Clients list and counts no longer spend seconds compiling.** Postgres compiled every
  client query (JIT) for about 2.7 s before running it in 0.1 s. It's off for the app's
  connections ([#471](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/471)).
- **Pages refresh on their own timers, not on every device poll.** The Dashboard, Clients,
  Events and Firewall Logs refetched their heaviest queries each time any device was polled,
  several times a second on a big fleet. They refresh every 30 to 60 seconds, as before
  ([#473](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/473)), and the
  Dashboard's wireless count asks for the total alone
  ([#478](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/478)).
- **Less work per poll:** the fleet and site client totals are counted once every 15 seconds
  in one query ([#474](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/474)); a
  device's clients are stored in one statement
  ([#475](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/475)); a client whose
  MAC has no known vendor isn't looked up again every poll
  ([#476](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/476)); and log times
  are read with far fewer time zone lookups
  ([#472](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/472)).
- **The clients table stays small.** An index nothing needed made every client update write
  to every index and leave dead rows behind. It's dropped, and the table leaves room on each
  page so updates stay in place
  ([#477](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/477)). This runs once
  when the backend starts after the update and takes well under a second.
- **The site list is as wide as its longest name**, so long site names aren't cut to a few
  letters, with the device counts lined up and the full name on hover
  ([#480](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/480)).

Also in 1.1.0-beta.72.

## 1.0.25

Released on Thursday 19 November 2026.

- **Firewall Logs shows rules in your own chains.** RouterOS logs a rule in a chain of your own
  (a jump target, such as `LAN-to-WAN`) under that chain's name rather than input, forward or
  output, and Firewall Logs left those lines off the page. They show now, with the chain's
  name, and the **Action** filter reads them from their log prefix as it does any other line.
  Also in 1.1.0-beta.71.

## 1.0.24

Released on Thursday 19 November 2026. A security fix, reported by
[@davidcoulson](https://github.com/davidcoulson); update as soon as you can.

- **Replacing a device by its serial kept its saved SSH password at the new address**
  ([GHSA-p885-qw7f-rgx2](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-p885-qw7f-rgx2)).
  Adding a device whose serial a managed device already has can replace that device, at the
  address given. It kept the device's saved SSH login, so an operator could point a device at a
  host that answered with its serial and have the next backup log in there with that password.
  As when a device is edited, the saved SSH login now stays only when the address is unchanged,
  or for a fleet admin; otherwise the device has only the logins given with the add. Replacing a
  device also needs operator or admin on its site, in single and bulk adds alike: a viewer role
  there was enough.
- **Top Talkers names on the Dashboard** stopped at 20 characters however much room the row had.
  They use the row now, shortened only where they run out of it, with the whole name on hover.
- **The Dashboard on a phone.** Its rows of cards kept two or three columns at any width, so on a
  phone Top Talkers was a narrow strip and the fleet tiles were a few pixels each. They stack
  now, and the layout from 1024 pixels up is as before.

## 1.0.23

Released on Thursday 19 November 2026.

- **Less load from the Devices page and Dashboard.** Every device poll told an open Devices page
  or Dashboard to fetch the whole device list again, which on a large fleet meant several times a
  second. They now wait a second and fetch once for everything that changed in it. Thanks to
  eskyuu ([#467](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/pull/467)).

## 1.0.22

Released on Wednesday 18 November 2026.

- **Chart text you couldn't read.** A client's Signal Strength chart drew its Excellent, Good
  and Fair names in green and amber over bars of the same colour; they now sit beside the chart.
  Thanks to Stanley ([Discussion #85](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/discussions/85)).
  Going through every chart in light and dark mode found more, also fixed:
    - Axis numbers and titles were a faint grey on the dark theme. They now use the theme's
      muted text colour everywhere.
    - Tooltips on the client page, Hardware, a port's packets and Radios were always dark, or
      had no background. They follow the theme now.
    - A client's traffic tooltips had lost the words Download and Upload.
    - RF Health on the Wireless page put white numbers on bright green, lime and amber. They're
      dark where that reads better, and empty retry tiles no longer show light grey in dark mode.
    - The roaming timeline wrote signal values in those same bright colours; the colour is a dot
      beside the value now.
    - The Dashboard's Connected Clients times fell back to a serif font.

## 1.0.21

Released on Tuesday 17 November 2026.

- **Editing a bridge VLAN dropped its name.** An edit on the VLANs tab removes the entry and
  adds it back, and the new one lost the entry's comment, which the manager shows as the VLAN's
  name, along with whether it was disabled. Both now carry over, as do MVRP forbidden ports set
  on the device.

## 1.0.20

Released on Monday 16 November 2026.

- **Spanning-tree roles were lost seconds after being read.** Each poll read the spanning tree
  and marked every link's role, then re-read neighbours, which rebuilt the links without it. The
  topology map rarely showed a blocked link for long, and a client's way up couldn't use the
  root port to tell which way is up, so on some networks two switches each named the other as
  their way up. Roles now survive the rebuild.

## 1.0.19

- **Device tools: Ping failed on RouterOS 6, and Traceroute showed no results**
  ([#460](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/460)). Ping asked for
  `/tool/ping`, which only RouterOS 7 has; it now uses `/ping`, which both have. Traceroute
  results were dropped on every version: RouterOS sends a snapshot of the whole route per round
  of probes, and the last one is now shown. Ping's summary also showed the totals after the first
  packet, and loss in red when there was none. Thanks to schmitt330 for the report.

## 1.0.18

Released on Monday 16 November 2026. Security fixes, reported by
[@davidcoulson](https://github.com/davidcoulson); update as soon as you can.

- **Saved alert passwords and tokens could be sent to another server**
  ([GHSA-qm4w-hmcg-7rq9](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-qm4w-hmcg-7rq9)).
  Changing an alert channel's server needs its password or token typed again, but a request
  that left the secret out skipped that check, so an operator could point the channel at their
  own server and press **Test**. A left-out secret is now treated like the masked one, turning
  off an email channel's TLS or certificate check counts as a new server, and a secret that
  arrives already encrypted is refused everywhere the manager would decrypt it (alert channels,
  webhook signing secrets and bulk device adds).
- **Operators could run commands as the router's admin through a firmware rollout**
  ([GHSA-fv5m-vfmw-8h9v](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-fv5m-vfmw-8h9v)).
  Running commands has been admin-only since 1.0.9, but an operator could still write a command
  template and pick it as a rollout's post-upgrade command. Templates are now written by fleet
  admins only, and a post-upgrade command needs admin access to every device in the rollout
  ([Bulk commands](commands.md#templates)).
- **Site-scoped accounts could reach other sites through a differently spelled address**
  ([GHSA-4rjj-7mfg-vrpg](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/security/advisories/GHSA-4rjj-7mfg-vrpg)).
  `/api/firmware/ROLLOUTS/…` or a trailing slash reached the same action as the usual address
  but skipped the site check, so a rollout, update channel, tag, metric or backup in another
  site could be reached. The checks now read every spelling the same way. Installs without
  site-scoped accounts weren't affected.

## 1.0.17

Released on Sunday 15 November 2026.

- **Saving a site could remove its map pin**
  ([#362](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/362)). Renaming a site
  or changing its group, without touching the address, cleared its position. A save now changes
  the pin only when it sends one or when the address changes. Thanks to Ron for the report.

## 1.0.16

Released on Friday 13 November 2026.

- **After an update, the dashboard said the latest release was older than the one running**
  ([#443](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/443)). The update check
  keeps its answer for a day, and the new version kept using the answer the old one had saved. The
  saved answer now records which version and channel asked, and the check runs again when either
  changes.

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
