# Clients

Every device seen on the network, where it is connected, and what it has been doing.

## Where the data comes from

Clients are assembled on the fast poll from several sources on each managed device: DHCP
leases, the ARP table, the bridge host table, and wireless registrations. A single client
usually appears in more than one of these, and they are merged by MAC address.

That merge is why a client shows a switch port *and* an access point: the MAC is known to both.

!!! note "This can be switched off"
    Client tracking is the heaviest collector on most fleets. **Settings → Polling →
    Collectors** can disable it, at the cost of this page and everything fed by it. See
    [Polling and scaling](scaling.md).

## The list

Filter by type (wired or wireless), category, device, VLAN, or signal range. Search matches
hostname, MAC, IP address and vendor.

Every column sorts. With **Wireless** selected, SSID and Signal replace the Type column and
sort too; Signal sorts strongest first on the first click.

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

- **Wake-on-LAN** sends a magic packet from the MikroTik nearest the client, not from the
  manager, so it reaches devices the manager cannot route to.
- **Notes** are free text kept against the MAC.
