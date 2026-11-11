# MikroTik Manager 1.1 (beta)

1.1 is in beta on the `dev` branch and the `:beta` images
([release channels](configuration.md#release-channels)). For stable, stay on 1.0 below.

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
