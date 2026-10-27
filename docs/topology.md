# Topology

An automatically discovered map of how the fleet is connected.

## One site, or one device, at a time

The site switcher narrows the map to one site. With **All sites** chosen on a fleet of more than
40 devices spread over several sites, the page asks which site to map rather than draw everything
at once; **Draw all devices anyway** is still there (#305).

**Topology** on a device's page opens the map at that device: it and what's within one hop,
with **2 hops** and **3 hops** to widen it. Hops count through neighbours discovery found and
nodes you added, since an unmanaged switch between two of yours is still the path between them.
Clients come along with what they connect to and don't count as a hop. The links table under the
map shows only the links in view. **Whole map** goes back to the full map. The arrangement is the
same map's, so a card moved here stays moved there.

## How links are found

Neighbours are read on the slow poll from LLDP, CDP and MNDP. LLDP is treated as ground truth;
where two protocols report the same neighbour, the lower-priority one is suppressed so a single
link does not appear twice.

Neighbours are matched to managed devices **by MAC before IP**, because a MAC is unique across
the fleet and an address is not. Bidirectional pairs — where each device reports the other —
are merged into one edge showing both port names.

The match is also stored with the link for the rest of the app (a client's upstream, firmware
rollout waves), within the device's site: by address, then by MAC, then by identity, each only
where exactly one device fits. A core switch managed out of band has no address on its fabric
ports, so its links are matched by MAC or name (#363). A MAC two devices share, such as a VRRP
virtual MAC, matches neither.

Device names wrap onto a second line rather than being cut off, and show in full on hover.

CDP and MNDP are broadcasts, so a port can hear many neighbours at once: everything in the same
broadcast domain, not only what's cabled to it. A port with a single such neighbour is drawn as
a link. A port that hears several draws nothing, because the protocol can't say which of them
is actually plugged in. Link those by hand if you want them on the map.

LLDP isn't always point to point either: RouterOS bridges forward it, so a device can hear an
unmanaged switch through the rest of the network as if it were cabled to it. A switch says which
of its own ports each announcement left from. When two managed devices report the *same* port of
the same unmanaged switch, only one can be the cable: the report from a port that faces no other
managed device is kept, and the one heard on an uplink is dropped (discussion #85). Reports that
name different ports can both be real cables and are left alone, as are ones where it can't
tell. A link that's still wrong can be [hidden](#hiding-a-discovered-link).

!!! note "This can be switched off"
    Neighbour discovery is one round trip per device per cycle. **Settings → Polling →
    Collectors** can disable it, after which the map stops updating and new devices are no
    longer discovered automatically.

## Spanning tree

LLDP frequently reports several neighbours on one port, and cannot say which is upstream.
Where the devices run STP they have already computed that answer. For each bridge's root port,
spanning tree names the **designated bridge**, the switch at the other end, and that is used
as the upstream (#260):

- a managed switch: the device hangs under it;
- a switch the manager doesn't manage (a third-party switch that runs STP): the device hangs
  under that neighbour, named from discovery where it was seen. Two switches on the same
  unmanaged switch show as siblings, not one below the other.

Data from before the designated bridge was read falls back to the older rule: the neighbour on
the root port that is in the same STP domain and closer to the root, used only when exactly one
qualifies. Where spanning tree proves a cable that discovery left out (a switch seen only by CDP
or MNDP on a busy port), it's drawn as an **stp** link.

Where STP says the root belongs to equipment outside the fleet, the top device of that part of
the map says so, with the root's bridge id, and with a name ("probably 2GT-NW-CORE") when a
neighbour discovery saw has a MAC address that fits it.

When several bridges claim to be root (an access point running a bridge of its own, say), the one
the other switches point at wins, and it is marked with a ★.

Each cable is drawn once, with the more telling role of its two ends. **Blocked** cables (a
redundant path spanning tree has switched off) are drawn red and dashed, and a second cable
between the same two switches gets its own edge. A redundant path you would otherwise never see
is exactly what you want to know about before unplugging something.

[Config Health](change-guard.md) separately flags:

- bridges with spanning tree switched off: a warning, or **critical** when discovery sees
  switches on two or more of the bridge's ports, where one stray cable makes a loop;
- bridges still running classic STP rather than RSTP;
- a tree whose root kept the default priority (0x8000), so it won on lowest MAC address rather
  than by anyone's choice; reported on the root, or on its members when the root isn't managed;
- an access point as root of a tree of several switches.

## Layout

The map is drawn as a tree from the root down. Siblings stay in one row as long as they fit
within a sensible width. A wider family wraps onto a few **even rows**, like text, rather than
running thousands of pixels across, and each switch keeps its own devices under it. A group of
end devices with nothing below them (access points, clients) is packed into a compact grid.
Separate parts of the network and unconnected devices are packed the same way, so the whole map
stays roughly the shape of the window (#115, #147).

**Hover** a device to light up its links and fade the rest; double-click it to open its page.

### Arranging the map

The automatic layout is a starting point. Drag cards wherever they describe your network best.
The arrangement is saved as soon as you change anything (moving a card, drawing a link, adding
a node), and it's shared: everyone sees the same drawing. Viewers can move cards to look around,
but their changes aren't saved.

Once arranged, the map holds still. A new link, a new node or a refresh doesn't move anything,
and the view isn't refitted. A new device, or a client list you open, appears next to what it
connects to. **Reset layout** forgets the arrangement of everything in view and lays it out
automatically again.

Any link, discovered or drawn, can be given a colour from its menu, to pick out trunks, say
(#260); **Default** goes back to the colour its kind gives it. Colours are kept when the layout
is reset.

Links run straight between the edges of the two cards and follow them as they move. Click a link
to choose where each end attaches: **Top**, **Bottom**, **Left**, **Right** or **Automatic**. A
pinned end leaves its side at a right angle and the link routes around, as in a wiring diagram.
A second cable between the same two cards is drawn alongside the first.

## Client devices

**Show clients** adds a chip under each switch, access point or unmanaged neighbour with the
number of clients connected through it (and how many are on Wi-Fi). Click a chip to show each
client; click it again to fold them back. Click a client to open it.

Tick **By VLAN** to open a chip into one chip per VLAN first, each with its count, and open those
to see their clients (#296). A guest VLAN with hundreds of phones then stays folded while the few
clients on management or camera VLANs are a click away. A VLAN is named after the VLAN interface
the client was seen on, or shown as "VLAN 1212" with the device's name for that VLAN when it has
one. A device whose clients are all in one VLAN opens straight to them. The setting is remembered
in your browser.

A client is usually seen by several devices at once: the router in ARP, every switch on the way
to it, and the access point it's associated with. It is drawn where it actually connects:

1. the access point whose registration table lists it, for Wi-Fi;
2. a switch port with no other device behind it (an access port);
3. behind an unmanaged neighbour, when it's learned on a port facing a switch the platform
   doesn't manage (one seen over LLDP);
4. otherwise the device that saw it, marked *port not known*.

Only active clients are shown. The setting is remembered in your browser.

## Neighbours discovery found

A device the manager doesn't manage, seen over LLDP, CDP or MNDP, is drawn with a dashed border
and labelled from what it advertises: a switch, router, access point, phone or computer. A
computer running a software bridge (Hyper-V, a Linux bridge) advertises "bridge" too; from 0.50.0
it's labelled a computer, not a switch (#260).

Click a neighbour to give it a better name or set its type by hand; **Back to what discovery
says** undoes that. Discovery keeps finding it as before; only how it's shown changes.

## Your own nodes

Discovery cannot see everything. **Add node** puts something the platform doesn't manage on the
map: the ISP modem or ONT, the internet, a router or firewall from another vendor, an unmanaged
switch, a server, a NAS, a printer, a camera or NVR, a phone system, a computer. Give it a name,
a type and optionally an address and notes; click it later to edit or delete it.

Connect it with **Connect Mode**. A modem or internet node connected to the top device of the
map is drawn above it. Nodes belong to the site they were added in.

## Links drawn by hand

Discovery can't see everything: an unmanaged switch in the middle of a run, or a cable to
equipment from another vendor. Turn on **Connect Mode** and drag from any blue handle to another
node to draw a link. Either end can be a managed device, one of your own nodes, or a neighbour
discovery found but the platform doesn't manage. Handles work from any side.

Hand-drawn links are purple and dashed so they can't be mistaken for discovered ones. Click one
to type the port at each end and a label, shown on the link as `ether5 ↔ sfp1 · trunk` (#260). To remove
one, use the × on its label or click it and choose **Remove**. All of them are also listed under
**Links drawn by hand** below the map, each with a **Remove** button.

A neighbour you linked stays on the map, marked *no longer seen by discovery*, if discovery stops
seeing it, so the link can still be removed. Links drawn before this release were carried over.

## Hiding a discovered link

Discovery can be wrong, and you know your cabling. Click a discovered link and choose **Hide
this link**. It disappears from the map for everyone, and stays hidden as discovery runs again; a
neighbour that only hidden links reached goes with them. Hidden links are listed under **Links
hidden by hand** below the map, with who hid them and when, and **Show again** brings one back.

A hidden link is matched by its two ends and their ports, so if the same two devices are later
cabled on different ports, the new link shows.

## Orphans

Devices with no known connections are grouped separately with a prompt to link them. An orphan
usually means one of three things: discovery is disabled on it, it is connected through
equipment the platform does not manage, or it genuinely has no neighbours.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/topology` | The map: devices, links, spanning tree, your nodes, hand-drawn links (`handLinks`), the saved arrangement (`layout`) and hidden links (`hiddenLinks`). Add `?clients=1` for client devices |
| `POST` | `/api/topology/nodes` | Add a node: `name`, `kind`, optional `address` and `notes` |
| `PUT` / `DELETE` | `/api/topology/nodes/:id` | Edit or delete a node (its links go with it) |
| `POST` | `/api/topology/hand-links` | Draw a link: `{"a": {"kind": "device", "ref": 1}, "b": {"kind": "node", "ref": 4}, "label": "WAN"}`. `kind` is `device`, `node` or `external` (a neighbour's map id, `ext-…`, with an optional `name`) |
| `PUT` | `/api/topology/hand-links/:id` | Ports at each end and the label of a hand-drawn link: `a_port`, `b_port`, `label` (null clears) |
| `DELETE` | `/api/topology/hand-links/:id` | Remove a hand-drawn link |
| `PUT` | `/api/topology/neighbours/:id` | Name and type for a neighbour discovery found: `{"name": "…", "kind": "computer"}`; both null go back to discovery's |
| `POST` / `DELETE` | `/api/topology/manual-links` | The older form, for scripts: a link between two managed devices (`from_device_id`, `to_device_id`) |
| `POST` | `/api/topology/hidden-links` | Hide a discovered link: `{"key": "cable:…", "label": "…"}`, the link's id from the map |
| `DELETE` | `/api/topology/hidden-links?key=…` | Show a hidden link again |
| `PUT` | `/api/topology/layout` | Save card positions (`positions: {id: {x, y}}`), link attachment sides (`anchors: {linkId: {sourceHandle, targetHandle}}`, `t`/`b`/`l`/`r`, or `null` for automatic) and link colours (`colors: {linkId: "#rrggbb" or null}`); merged into what's saved |
| `POST` | `/api/topology/layout/reset` | Forget the arrangement of the given cards (`keys`) and links (`edges`) |
