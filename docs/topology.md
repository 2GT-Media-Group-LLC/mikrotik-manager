# Topology

An automatically discovered map of how the fleet is connected.

## How links are found

Neighbours are read on the slow poll from LLDP, CDP and MNDP. LLDP is treated as ground truth;
where two protocols report the same neighbour, the lower-priority one is suppressed so a single
link does not appear twice.

Neighbours are matched to managed devices **by MAC before IP**, because a MAC is unique across
the fleet and an address is not. Bidirectional pairs — where each device reports the other —
are merged into one edge showing both port names.

CDP and MNDP are broadcasts, so a port can hear many neighbours at once: everything in the same
broadcast domain, not only what's cabled to it. A port with a single such neighbour is drawn as
a link. A port that hears several draws nothing, because the protocol can't say which of them
is actually plugged in. Link those by hand if you want them on the map.

!!! note "This can be switched off"
    Neighbour discovery is one round trip per device per cycle. **Settings → Polling →
    Collectors** can disable it, after which the map stops updating and new devices are no
    longer discovered automatically.

## Spanning tree

LLDP frequently reports several neighbours on one port, and cannot say which is upstream.
Where the devices run STP they have already computed that answer, so the root port, STP domain
and path cost are used to resolve the real upstream link.

Where STP says the root belongs to equipment outside the fleet, the platform declines to guess
rather than naming the wrong switch, and the top device of that part of the map says so, with the
root's bridge id.

When several bridges claim to be root (an access point running a bridge of its own, say), the one
the other switches point at wins, and it is marked with a ★.

Each cable is drawn once, with the more telling role of its two ends. **Blocked** cables (a
redundant path spanning tree has switched off) are drawn red and dashed, and a second cable
between the same two switches gets its own edge. A redundant path you would otherwise never see
is exactly what you want to know about before unplugging something.

[Config Health](change-guard.md) separately flags bridges with spanning tree switched off and
bridges still running classic STP rather than RSTP.

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

Links run straight between the edges of the two cards and follow them as they move. Click a link
to choose where each end attaches: **Top**, **Bottom**, **Left**, **Right** or **Automatic**. A
pinned end leaves its side at a right angle and the link routes around, as in a wiring diagram.
A second cable between the same two cards is drawn alongside the first.

## Client devices

**Show clients** adds a chip under each switch, access point or unmanaged neighbour with the
number of clients connected through it (and how many are on Wi-Fi). Click a chip to show each
client; click it again to fold them back. Click a client to open it.

A client is usually seen by several devices at once: the router in ARP, every switch on the way
to it, and the access point it's associated with. It is drawn where it actually connects:

1. the access point whose registration table lists it, for Wi-Fi;
2. a switch port with no other device behind it (an access port);
3. behind an unmanaged neighbour, when it's learned on a port facing a switch the platform
   doesn't manage (one seen over LLDP);
4. otherwise the device that saw it, marked *port not known*.

Only active clients are shown. The setting is remembered in your browser.

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

Hand-drawn links are purple and dashed so they can't be mistaken for discovered ones. To remove
one, use the × on its label or click it and choose **Remove**. All of them are also listed under
**Links drawn by hand** below the map, each with a **Remove** button.

A neighbour you linked stays on the map, marked *no longer seen by discovery*, if discovery stops
seeing it, so the link can still be removed. Links drawn before this release were carried over.

## Orphans

Devices with no known connections are grouped separately with a prompt to link them. An orphan
usually means one of three things: discovery is disabled on it, it is connected through
equipment the platform does not manage, or it genuinely has no neighbours.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/topology` | The map: devices, links, spanning tree, your nodes, hand-drawn links (`handLinks`) and the saved arrangement (`layout`). Add `?clients=1` for client devices |
| `POST` | `/api/topology/nodes` | Add a node: `name`, `kind`, optional `address` and `notes` |
| `PUT` / `DELETE` | `/api/topology/nodes/:id` | Edit or delete a node (its links go with it) |
| `POST` | `/api/topology/hand-links` | Draw a link: `{"a": {"kind": "device", "ref": 1}, "b": {"kind": "node", "ref": 4}, "label": "WAN"}`. `kind` is `device`, `node` or `external` (a neighbour's map id, `ext-…`, with an optional `name`) |
| `DELETE` | `/api/topology/hand-links/:id` | Remove a hand-drawn link |
| `POST` / `DELETE` | `/api/topology/manual-links` | The older form, for scripts: a link between two managed devices (`from_device_id`, `to_device_id`) |
| `PUT` | `/api/topology/layout` | Save card positions (`positions: {id: {x, y}}`) and link attachment sides (`anchors: {linkId: {sourceHandle, targetHandle}}`, `t`/`b`/`l`/`r`, or `null` for automatic); merged into what's saved |
| `POST` | `/api/topology/layout/reset` | Forget the arrangement of the given cards (`keys`) and links (`edges`) |
