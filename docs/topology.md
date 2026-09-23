# Topology

An automatically discovered map of how the fleet is connected.

## How links are found

Neighbours are read on the slow poll from LLDP, CDP and MNDP. LLDP is treated as ground truth;
where two protocols report the same neighbour, the lower-priority one is suppressed so a single
link does not appear twice.

Neighbours are matched to managed devices **by MAC before IP**, because a MAC is unique across
the fleet and an address is not. Bidirectional pairs — where each device reports the other —
are merged into one edge showing both port names.

!!! note "This can be switched off"
    Neighbour discovery is one round trip per device per cycle. **Settings → Polling →
    Collectors** can disable it, after which the map stops updating and new devices are no
    longer discovered automatically.

## Spanning tree

LLDP frequently reports several neighbours on one port, and cannot say which is upstream.
Where the devices run STP they have already computed that answer, so the root port, STP domain
and path cost are used to resolve the real upstream link.

Where STP says the root belongs to equipment outside the fleet, the platform declines to guess
rather than naming the wrong switch.

[Config Health](change-guard.md) separately flags bridges with spanning tree switched off and
bridges still running classic STP rather than RSTP.

## Manual links

Discovery cannot see everything — an unmanaged switch in the middle of a run, or a link across
equipment from another vendor. **Draw** a connection between any two managed devices to record
it; manual links are stored persistently and drawn as dashed edges so they are distinguishable
from discovered ones.

Manual links join two *managed devices*. Placing unmanaged equipment on the map — an ISP
router, a server, a printer — is not currently possible and is tracked in issue #147.

## Orphans

Devices with no known connections are grouped separately with a prompt to link them. An orphan
usually means one of three things: discovery is disabled on it, it is connected through
equipment the platform does not manage, or it genuinely has no neighbours.

## Known limitation

On wide, flat networks — one core with many access switches — the layout still produces a very
wide tree. This is tracked as issue #115 and is not fixed; the current layout only folds
*leaf* devices into blocks, so a switch with anything hanging off it still takes a full column.
