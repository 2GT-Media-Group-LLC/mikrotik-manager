# Network services

DHCP, DNS, NTP, WireGuard, routing, tunnels and PPP, MLAG, logging, NetFlow and discovery, viewed across the fleet rather than
one device at a time. **Network Services → Overview** is a table of which devices run what:
search it, sort by any service, and click a row to open the device.

The Overview and the NetFlow fleet view show what was last read from each device and when,
refreshing anything older than ten minutes in the background; **Refresh** reads every device
again. On a large fleet the page fills in over a few seconds rather than contacting every device
at once (see [Scaling](scaling.md#pages-that-show-something-from-every-device)).

Most of it writes to the device (Routing, Tunnels & PPP and MLAG only read). Changes go through [Change Guard](change-guard.md) where
they could affect reachability.

## DHCP

Servers, address pools and leases, per device. A lease list shows the first 100; **Show all**
lists the rest.

- **IPv4 Static Leases** lists a device's reservations: add one with **Static**, remove one with
  its delete button. Dynamic leases are on the [Clients](clients.md) page, which knows far more
  about each client.
- **Pools** and **servers** can be created, edited and removed.
- A static **IPv6 binding** is matched by the client's DUID, not its MAC address, and assigns
  a prefix. Before 0.24.51 the form asked for a MAC address, which RouterOS refused.

A DHCP server bound to an interface that later changes VLAN is a common way to hand out
addresses on the wrong segment; the lease list is the quickest way to notice.

**DHCP pool usage**, at the top of the page (and on Wireless → Overview), shows how full every
IPv4 address pool across the fleet is, read on each slow poll (#156): yellow from 80%, red from
95%. A pool that runs out is a quiet failure, since clients connect but get no address, so
a nearly full pool is also listed on the dashboard. Widen the range or shorten the lease
time.

## DNS

The resolver configuration on each device, plus static entries.

- **Static DNS** entries are managed per device, including regexp entries. The record types
  are RouterOS's own: A, AAAA, CNAME, MX (with a preference), NS, TXT, SRV (with port,
  priority and weight) and FWD (forward that name to another DNS server). RouterOS has no
  static PTR record. Before 0.24.51 MX, NS and SRV targets went into the wrong field and the
  record wasn't created.
- **Flush cache** clears the resolver cache on a device, which is worth doing after changing
  an upstream server or a static entry.
- **Upstream DNS servers** are edited one entry at a time (#207): type an address and press
  Enter, or paste a list; × removes one. Only IP addresses are accepted. A device's own DNS
  servers, under its **Config** tab, work the same way.

## NTP

Client and server configuration. Worth more attention than it usually gets: a device with the
wrong clock produces logs that cannot be correlated, certificates that appear
invalid — see [Alerting](alerting.md#certificate-expiry) — and scheduled work that fires at
the wrong time.

**NTP servers** are edited one entry at a time, like the DNS servers; addresses and host names
(`pool.ntp.org`) are both accepted.

[Configuration templates](devices.md) can push the same NTP servers to many devices at once.

On RouterOS 6 the NTP server comes with the optional ntp package, so a stock device shows the
client only. Its client takes up to two IP addresses plus any number of names, and its mode
follows from the servers: unicast when some are set, broadcast when none are. Before 0.24.51
saving NTP settings on such a device failed with an error 500.

## WireGuard

Interfaces and peers per device: create, edit, enable, disable and remove. Peer public keys and
allowed addresses are shown so a tunnel can be checked against the far end without leaving the
platform.

Every device in the site that has WireGuard gets its own card. Devices without it are listed
underneath; **Show / add interface** opens a card for one so an interface can be added.

A peer's persistent keepalive is in seconds; leave it empty to turn keepalive off.

## Routing

**Network Services → Routing** lists every BGP peer and OSPF neighbour across the fleet, or the
selected site (#279): the device, the peer's address, AS or router ID, whether it's up, how long
for, and when it last changed. Down peers are listed first. They're read with each device's slow
poll, so a change shows up within that interval. Configure BGP and OSPF on a device's **Routing**
tab, and turn on the **Routing peer down** alert ([Alerting](alerting.md)) to be told when a
session drops.

- **BGP:** one row per configured connection (a `peer` on RouterOS 6). It's up when its session
  is established; a connection with no session is *idle*, one still trying is *connecting*, and a
  disabled one is *disabled*.
Adding a BGP connection on a device's Routing tab asks for the name, remote address, remote AS,
role and local AS. On RouterOS 7.20 and later a connection belongs to a BGP instance, which
carries the local AS: the device's instance is used (you choose when it has several), and on a
device with none, one called `default` is created with the local AS you enter. On 7.0 to 7.19 the
local AS goes on the connection itself, and on RouterOS 6 a peer is added. Before 0.59.1 adding a
connection failed on 7.20 and later with *missing =instance=*.

- **OSPF:** one row per neighbour. RouterOS forgets a neighbour once it stops hearing it, so the
  manager keeps the last row and marks it *down*. A neighbour gone for a week is dropped from the
  list. *2-Way* counts as up: on a LAN, two routers that are neither DR nor BDR stop there by
  design.

## Tunnels and PPP

**Network Services → Tunnels & PPP** lists, across the fleet or the selected site (#310), every
IPsec peer, PPPoE server, PPPoE client, active PPP session, and EoIP, GRE and IPIP tunnel. It
shows each one's local and remote address, its state, how long it's been up and when it last
changed. Problems are listed first. Everything is read with each device's slow poll, in one
batched request, so a change shows within that interval; **Refresh** asks for a fresh poll.
Apart from PPP (below), set these up on the device.

| Type | One row per | Up when |
|---|---|---|
| IPsec | configured peer, including the dynamic ones an EoIP or GRE tunnel with an IPsec secret creates | a peer that matches it is *established*. A passive peer with nobody connected is *waiting*, not down |
| PPPoE server | server (service name on an interface) | it has sessions; with none it's *waiting* |
| PPP session | active session in `/ppp active` (PPPoE, L2TP, SSTP, OpenVPN...) | always: an ended session is removed |
| PPPoE client | client interface | it's connected |
| EoIP, GRE, IPIP | tunnel interface | it's running |

An active IPsec peer is matched to the configured peer whose address is the most specific match,
as RouterOS does; a peer that takes many clients (`0.0.0.0/0`) shows how many are connected.
RouterOS doesn't say which PPPoE server a session is on, so with more than one server the count
covers all of them. Secrets (the IPsec secret on an EoIP or GRE tunnel) are never stored or
shown, and PPP passwords aren't read at all. Up to 5,000 sessions are kept per device, and the page shows the first 500
that match the filters.

### PPP users and sessions

**PPP users and sessions**, at the top of the page, reads one router live: its PPPoE servers,
who is connected, and its PPP users (`/ppp secret`). Choose the router, or press **manage** on
a PPPoE server or PPP session row. Operators and admins can:

- **Disconnect** a session. Its client usually dials straight back in; turn the user off first
  to keep it out. A session whose address is a managed device asks again, since ending it cuts
  the manager off from that device until it reconnects.
- **Turn a user off or on.** Off stops it logging in; a session it already has stays up until
  you disconnect it. Each user shows whether it is connected, its last caller and when it last
  logged out.
- **Turn a PPPoE server off or on.** Off ends every PPPoE session on the router, so it asks
  first.

User and server changes run under [Change Guard](change-guard.md) and can be reviewed first;
every action is in the audit log. Passwords aren't read.

## MLAG

**Network Services → MLAG** shows each MLAG pair (#376), and is in the sidebar only once a device
in view has a bridge with an MLAG peer port. For each pair: both peers' state, role, priority and
settings, the peer link and how many of its members are up, and the MLAG bonds side by side by
`mlag-id`, with the downstream device each one's LACP partner is. The two peers are found from
neighbour discovery on the peer link, and the primary is shown on the left. It's read with the slow
poll, and only on devices with MLAG.

Between the two peers, the **peer link** has a block of its own, since it's the first thing to
check when MLAG goes wrong:

- **Members side by side:** each physical port of the peer link on both switches, up or down (and
  "not active" when the link is up but LACP hasn't taken it), with the speed, RouterOS's link-downs
  count and the errors in the last 24 hours. The two ends of each cable are paired from neighbour
  discovery, or by name when discovery doesn't say.
- **VLANs carried**, with VLAN 1 called out, since host sync needs it, and any VLAN that's on an
  MLAG bond but missing from the peer link.
- **LACP partner:** each side's partner should be the other peer. One that's something else means
  the peer link is cabled to another device, which is a critical finding.
- **Last flap:** the last time a member went down that the manager saw (it keeps 7 days), marked
  **(reboot)** when one of the peers restarted around then, so a real flap stands out from a
  maintenance window.

A pair is **critical** when it has a critical finding, **warning** when it has only warnings, and
**healthy** otherwise. A bond down on both peers that has never been seen up, for example one set up
for a switch that isn't cabled yet, shows as grey **unused** and isn't a problem. A bond that has
been up and is now down on both peers stays red, with a warning.

It checks, worst first:

| Check | Severity |
|---|---|
| A peer isn't *connected* | critical |
| Both peers primary (split brain), or both secondary | critical |
| The peer link is down / some of its members aren't active | critical / warning |
| One `mlag-id` with different LACP partners on the two peers (cabled to two devices) | critical |
| The peer link's LACP partner isn't the other peer | critical |
| An `mlag-id` up on one peer only (single-homed) | warning |
| An `mlag-id` that was up, now down on both peers | warning |
| A VLAN on an MLAG bond that isn't tagged on the peer link, VLAN 1 included. Hosts in it can't sync between the peers: the "peer failed to sync" storm | warning |
| `mlag-heartbeat`, `mlag-init-delay`, `mlag-lacp-fallback` or the RouterOS version differ | warning |
| State or role changed in the last 24 hours (the first value the manager reads doesn't count) | warning |
| Heartbeat timeouts in the last hour (critical over 30), host sync failures in the last hour, peer link down in the last 24 hours, from the devices' logs | warning |

The **MLAG degraded** alert ([Alerting](alerting.md)) reports critical findings. It's on by
default, and does nothing on a fleet without MLAG.

## Netinstall

**Network Services → Netinstall** reinstalls RouterOS on a device from a router running
MikroTik's netinstall package (#310), instead of from a PC with the Netinstall tool. The package
needs RouterOS 7.24 or later, and isn't made for SMIPS devices. The device being installed must be
on the same layer 2 segment as that router, and etherboot to it. **An install reformats that
device**: what's kept depends on the entry (below).

The page lists the devices in view in three groups:

- **Netinstall servers**: devices with the package installed. Each one is read live: its entries,
  the devices that have etherbooted to it, and its cache.
- **Can run Netinstall**: **Install package** installs it. The device reboots to do it, and
  shows as a server once it's back and polled. Installing the package changes nothing else:
  the device doesn't answer etherboot until an entry is added. **Remove package** on a server
  takes it off again, also with a reboot. Either is refused while another package change is
  waiting on the device, or when its flash is too full. When the device's last update check
  found a newer RouterOS, RouterOS may install that too while it applies the change (a test
  switch went from 7.25 to 7.25.1 this way), so the manager asks first. Tick **Also upgrade
  RouterOS** to go ahead, or upgrade it from [Firmware](firmware.md) first.
- **Can't run Netinstall**: older than 7.24, SMIPS, or not polled yet.

### Entries

An entry makes the server answer etherboot on one interface. **Every entry has to name the MAC
address of the device it installs, or have Wait on**, so each install is started from this page.
Without either, any device on that segment that etherboots would be reformatted, so the manager
refuses to save or enable one, and flags one made outside it in red. A new entry has Wait on and
FlashFig off.

| Setting | What it does |
|---|---|
| MAC address | Install only this device. RouterOS can't clear it later: delete the entry and add a new one |
| Address range | The addresses handed out while installing, at most 256 |
| RouterOS version | Empty installs the latest in the server's update channel |
| Extra packages | Installed with RouterOS, which is always installed |
| After installing | Reboot, shut down, or do nothing |
| Keep the old configuration | Puts the device's configuration and users back after the install (files and containers aren't kept). Off with **Apply the default configuration** for a clean device |
| Install each device only once | Ignore a device again after it's been installed, until the server restarts |
| Wait | Hold each device that etherboots until its install is started here |
| Answer etherboot / FlashFig | What the entry responds to |

Entries are written under [Change Guard](change-guard.md), and **Review changes** shows the
commands first. Script and mode files aren't offered yet.

### Installing a device

A device that etherboots to a server is listed under **Devices seen**, with its model,
architecture and progress. The list refreshes every five seconds while it has devices in it.
When the MAC address is one a managed device has, the device is named.
**Reinstall…** starts the install. You can choose a version and packages, and it asks you to
type the device's MAC address back first.

### Cache

Install files download from MikroTik when an install needs them. **Download files** fetches them
first, so installs don't wait and work without internet access. The header shows where the
cache is. On a device with a `flash` folder (a CRS309, say) the root folder is RAM, so files there
use RAM and are gone after a reboot. On other devices they use flash. **Cache folder** points
it at a disk instead, a USB drive or a RAM disk (`/disk add type=tmpfs`).

Flash and RAM are never filled. Before an entry is enabled, files are downloaded or an install is
started, the manager estimates the download (about 20 MB for RouterOS, plus the extra
packages) and refuses when it wouldn't fit. It keeps 5% of flash free, and at least 32 MB of RAM.

## Logging (syslog)

Where each device sends its logs — remote actions and the rules that select which topics go to
them. Rules can be toggled without deleting them.

On current RouterOS 7, a remote action with a facility and severity is sent in syslog format
(`remote-log-format=syslog`), and **BSD syslog** picks the BSD timestamp style over ISO 8601.
Older RouterOS takes the same settings in its own form. The built-in actions (memory, disk,
echo, remote) can be edited but not renamed or changed to another kind. Before 0.24.51 adding
an action failed on every device.

This is separate from the events the platform collects itself. The platform reads
`/log/print` on its own cadence regardless of whether you forward logs anywhere.

## NetFlow

Configuration of the exporters on each device, and the collector built into the platform. See
[Traffic analytics](traffic.md) for what is done with the data.

The **Sessions** switch on each device keeps one row per connection from its flows, on
**Security → [Sessions](sessions.md)**. It is MikroTik Manager's own setting; nothing is written
to the device.

## Discovery and SNMP

Neighbour discovery protocol settings (LLDP, CDP, MNDP) per device, and SNMP configuration.

Discovery is what populates the topology map and finds devices to adopt. Turning it off on a
device makes that device invisible to its neighbours — and this platform.

The LLDP section covers every online device in the current site: routers, switches, wireless
APs and anything else running RouterOS. Use the tabs to narrow it to one type. **Enable** and
**Disable** only touch the devices listed.

The API is `GET /api/network-services/lldp` and `PUT /api/network-services/lldp` with
`{"enabled": true, "device_types": ["wireless_ap"]}`. Leave out `device_types` to target
every type. The older `/api/routers/lldp` and `/api/switches/lldp` still work.

### Applying SNMP settings

The SNMP section covers every online device in the current site: routers, switches, wireless
APs and anything else running RouterOS (it used to cover routers and switches only). Use the
tabs to narrow the list to one type.

Choose where a change goes with **Choose devices** (one or several, with Select all), then
**Apply to selected**, or use **Apply to all**. Nothing is pushed automatically, and Apply
asks you to confirm the exact changes and the devices they go to first.

**The form shows what the chosen devices have now**, or, with none chosen, what every listed
device has. A setting they don't all share shows as *differs* (the slider sits in the middle)
instead of a made-up default.

**Only what you change is sent.** The form remembers which fields you edited and
highlights them; everything else is left as it is on each device, so setting a trap
destination doesn't also rewrite each device's community or turn SNMP on or off. **Reset**
discards your edits. A community name a device doesn't have is **added** next to its existing
ones; nothing is renamed or removed. Before 0.24.37 the form was filled in from one device and every field was sent, so
Apply copied that device's community, version and on/off state to the whole fleet, renaming
each device's first community.

For SNMPv3, leaving the privacy password blank keeps the current one and keeps the user
encrypted. It used to drop the user to authentication only.

The API is `GET /api/network-services/snmp` (every device type) and
`PUT /api/network-services/snmp`, which needs `device_ids`: a list of device ids, or `"all"`
(optionally with `device_types`). Only the settings in the body are changed, for example
`{"device_ids": [8, 12], "trap_target": "10.0.0.5"}`. The older `/api/routers/snmp` and
`/api/switches/snmp` still work.

### SNMP contact and location per device

Contact, location and trap target can use variables, filled in per device:

| Variable | Value |
|---|---|
| `{identity}` | RouterOS identity (`/system identity`). `{$systemidentity}` also works |
| `{name}` | Device name in the manager |
| `{ip}` | Management address |
| `{model}`, `{serial}` | From the device |
| `{site}` | Site name |
| `{location}` | The device's location, or its site's address if it has none |

For example, contact `{identity}@example.com` or location `{site} / {location}`. An unknown
variable is rejected before anything is written.

The form remembers the last contact, location and trap destination you applied, variables
and all, and shows them when you come back (the table shows each device's filled-in value).
A remembered value isn't sent unless you change it or press **Send it** under the field,
which is how you apply the same template to devices added later.

A blank field keeps each device's current value. Before 0.24.26 a blank field overwrote it
with nothing.
