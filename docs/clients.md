# Clients

Every device seen on the network, where it is connected, and what it has been doing.

## Where the data comes from

Clients are assembled on the fast poll from several sources on each managed device: DHCP
leases, the ARP table, the bridge host table, and wireless registrations. A single client
usually appears in more than one of these, and they are merged by MAC address.

That merge is why a client shows a switch port *and* an access point: the MAC is known to both.

When several devices know a client, it's shown where it's connected: the access point it's
registered to, or else the switch that sees it on an edge port. Every switch between the client
and the router learns its MAC, most of them on an uplink, so a sighting on a port facing another
managed device (an uplink, bond or peer link) comes last (#363).

A sighting from the last day counts for where a client is, even if it has gone quiet: overnight
a switch forgets an idle PC while the router's ARP table still lists it, and the PC stays on its
switch port rather than moving to the router. Whether a client is online, and when it was last
seen, come from all of its sightings: online if any device sees it now.

On the client's page, **Connection Path** shows that device and its way up: the spanning-tree
root port where there is one, otherwise a link on a bridge port (or a member of a bonded one)
rather than an out-of-band management port, and among those a neighbour heard over LLDP. Bridges
pass MNDP and CDP on but not LLDP, so an access point behind a switch also hears the router
through it, and only the LLDP neighbour, the switch, is at the other end of the cable. When links
still tie, a router comes before a switch, and a switch before anything else, and a neighbour whose
own way up is this device comes last. That covers the spanning-tree root bridge, which has no root
port, and two switches that would otherwise each go up to the other (#365).

The top of a site has no way up. When the best neighbour goes up through this device, and is a
switch or access point under a router (or an access point under a switch), the device is the
top, and Connection Path stops there rather than going back down into the LAN. A neighbour the
manager doesn't manage is the way up only when there's no managed one, and only if it was heard
over LLDP, so it's at the other end of the cable: an access point behind an unmanaged switch
shows that switch, marked **not managed**. Names wrap in full and link to the device.

!!! note "This can be switched off"
    Client tracking is the heaviest collector on most fleets. **Settings → Polling →
    Collectors** can disable it, at the cost of this page and everything fed by it. See
    [Polling and scaling](scaling.md).

## The list

Filter by status (online, or all including inactive clients), type (wired or wireless), the
device a client is connected to, VLAN, or signal range, in the same filter bar as the device
list. Search matches hostname, MAC, IP address and vendor. **Refresh**, the automatic refresh
interval and **Purge stale** sit beside the page title.
**Refresh** asks the devices in view for a fresh poll and reloads the list as their answers
arrive over the next few seconds; the Wireless and Routing pages' Refresh works the same way.

Every column sorts. With **Wireless** selected, SSID, Signal and Rate replace the Type column and
sort too; Signal sorts strongest first on the first click. **Rate** is the client's current link
rate, seen from the access point: TX is towards the client, RX from it. It's also on the client's
page, and comes from the newer Wi-Fi package, the legacy wireless driver and legacy CAPsMAN alike.

The list has a minimum width, so in a narrow window it scrolls sideways rather than cutting off
IP addresses (#336). Hover a shortened name, vendor, SSID, interface or device to see all of it.

**Active** means the client was present at the most recent poll of the device it is attached
to. Clients that disappear are kept and marked inactive rather than deleted, so history
survives a laptop closing its lid; `retention_clients_days` (default 7) decides how long an
inactive client is kept.

## Identification

Each client is classified into a category — network gear, server, computer, phone, TV, camera,
printer, game console, voice assistant, smart home, IoT — derived from its MAC vendor prefix
and hostname.

This is a guess, and it is sometimes wrong. Both the category and the display name can be
overridden per client, and an override persists across polls rather than being re-derived. Use
**custom name** for the label you actually recognise the device by; the hostname it advertises
is kept alongside.

## Client detail

Selecting a client opens its own page:

| Section | Shows |
|---|---|
| **Connectivity** | Where it is attached now, and on which port or radio |
| **Presence** | When it has been seen, as a timeline |
| **Traffic** | Per-client throughput history |
| **Signal** | For wireless clients, RSSI over time |
| **Roaming** | Movement between access points, with the signal at each |

Roaming and signal history are the two that answer questions nothing else can: a client that
keeps dropping is usually either roaming between two APs that both hear it weakly, or sitting
at the edge of one.

Signal quality bands are −70 / −55 / −45 dBm. A phone typically drops off a network around
−75 dBm, so anything in the Poor band is at or past the edge of usable. Dedicated
point-to-point radios are an exception and will read Poor while working perfectly.

## Per-port clients

The **Ports** tab of a switch shows who is physically on each port. Uplink and trunk ports are
detected automatically — by an LLDP neighbour, by MACs spanning several VLANs, or by a high MAC
count — and show an explanation rather than listing every MAC reachable through them. The full
table is one click away if you want it.

## Actions

- **Address lists** (#145), on a client's page next to its IP address, or the list icon on its
  row: the router's firewall address lists, ticked where the client's address is already a
  member. Tick or untick, or type a new list name, then **Apply**. An address can be in several
  lists at once.
    - Entries a firewall rule added (dynamic) are shown but can't be changed here.
    - Lists a firewall rule matches on are marked *used by rules*. Every change runs through
      Change Guard, which asks before anything it predicts would lock the manager out.
    - If the address is a **dynamic** DHCP lease, a warning says so: the lists follow the
      address, not the device. Make the lease static to keep them together.
- **Disconnect** (#338), on a wireless client's page or the Wi-Fi-off icon on its row, removes it
  from its access point's registration table, as **Remove** does in WinBox, so it reassociates,
  normally within seconds. It works with the Wi-Fi package, the legacy wireless driver and legacy
  CAPsMAN, and is for operators and admins in the client's site. If the client is one of your
  managed devices (a wireless backhaul in station mode, say), it asks again first, since that
  drops the device and everything reached through it until it reconnects. Each disconnect is in
  the audit log.
- **Wake-on-LAN** sends a magic packet from the MikroTik nearest the client, not from the
  manager, so it reaches devices the manager cannot route to.
- **Notes** are free text kept against the MAC.
