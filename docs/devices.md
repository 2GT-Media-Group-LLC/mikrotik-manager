# Devices

The device list is the front door to everything else. This page covers getting devices in,
what each tab of a device does, and the parts that write to hardware.

## Adding devices

**Devices → Discover** finds MikroTik hardware your managed devices can already see, over
LLDP, CDP and MNDP. Each discovered device offers one button, **Adopt Device**, and the
platform decides what that means — a factory-default unit is configured first, an already
configured one is simply registered. See [Adopting devices](adoption.md).

**+ Add Device** is the manual route when discovery cannot see it: address, credentials, and
optionally a [credential preset](configuration.md) so the same username and password are not
retyped per device.

**Try All** runs a bulk add across every discovered device as a server-side job. It survives a
closed browser tab and reports progress and failures per device.

### Importing from CSV

**Import CSV** on the Devices page adds up to 500 devices from a spreadsheet. Download the
template from the dialog, or write your own. Only `ip` is required:

```csv
ip,name,type,preset,username,password,port,notes
10.0.10.1,core-rtr,router,Default,,,,
10.0.20.5,sw-floor2,switch,,admin,secret,8728,rack B
```

| Column | Accepts |
|---|---|
| `ip` (or `address`, `host`) | IPv4 address or hostname |
| `name` (or `identity`, `hostname`) | Optional. Defaults to the address |
| `type` | `router`, `switch`, `ap` / `wireless`, `other`. Defaults to `router` |
| `preset` | Name of a [credential preset](configuration.md). Use this, or `username` and `password` |
| `port` | API port. Defaults to 8728 |

The file is checked before anything is sent. Each line shows as ready, skipped or a problem,
with the reason. Addresses that are already managed are skipped. Duplicate addresses inside
the file are flagged. Unknown columns are listed and ignored. Blank lines and lines starting
with `#` are ignored.

The import runs as the same server-side job as **Try All**, so the tab can be closed.

!!! note "Credentials are stored encrypted"
    API passwords are encrypted at rest with the key from `ENCRYPTION_KEY`. Losing that key
    means re-entering every device password; see [Configuration](configuration.md).

## The device list

Filter by status, type, tag, rack or location, and sort by any column. The search box matches
name, address, serial and MAC.

Tags appear beside the device name. They are assigned on the device page and are the only
grouping that crosses both sites and device types — see [Bulk commands](commands.md) for
selecting a fleet by tag.

## Device tabs

| Tab | What it is for |
|---|---|
| **Overview** | Status, uptime, model, firmware, resource graphs, location |
| **Ports** | The switch faceplate, per-port configuration, bonds, VLAN membership |
| **VLANs** | The bridge VLAN table, and copying VLANs between switches |
| **Radios** | Wireless interfaces, SSIDs, channels, connected clients |
| **Firewall** | Filter, NAT and mangle rules, with reordering and counters |
| **Routing** | Routes, OSPF, BGP, routing tables and filters |
| **Queues** | Traffic shaping |
| **Connections** | The live connection tracking table |
| **Hardware** | Health sensors, PoE, SFP module detail |
| **LTE** | Signal, carrier, bands and the data cap — see [Cellular](cellular.md) |
| **Security** | Baseline hardening checks and the posture score |
| **Config** | System settings, certificates, SSH keys, clock |
| **Config History** | Snapshots of `/export`, diffs, and one-click rollback |
| **Tools** | Ping, traceroute, IP scan, Wake-on-LAN, packet capture, bandwidth test |

Tabs appear only where they apply: a switch has no Radios tab, a device without a modem has no
LTE tab.

## Ports and the faceplate

The faceplate mirrors the physical front panel — copper staggered odd above even as the
hardware is, SFP cages and QSFP breakout lanes grouped separately, bridges and bonds alongside.

Ports are identified by RouterOS's **factory name**, not their display name, so renaming a port
to something useful does not move it into the wrong group or cost it its label or position.
Where a port has been renamed, the factory name is shown beneath it.

Negotiated link rate and SFP module details — type, connector, vendor part number — are read
from the device rather than guessed from the port's name, which also distinguishes an empty
cage from a copper port.

Use **ports per row** in the faceplate header if the default does not suit your hardware;
the setting is remembered.

### Changing a port's VLAN

Selecting a port and setting it to **access** or **trunk** writes three things: the PVID, the
bridge VLAN membership, and frame admission (`frame-types` and `ingress-filtering`).

For a trunk, tick the tagged VLANs. The native VLAN (PVID) is greyed out because it is carried
untagged. The text box below the checkboxes holds the same list, for copying between switches,
and accepts ranges such as `10,20,100-110`. A VLAN typed there that the switch does not have
yet is created on the bridge when you save.

Unticking a VLAN removes the port from it. One exception: if the switch holds several VLANs
in one bridge VLAN entry (for example `vlan-ids=100-110`) and the port keeps some of them,
that entry is left alone and the editor tells you which VLANs are still tagged. Split the
entry on the VLANs tab to remove them.

!!! warning "This is a guarded change"
    Moving the port that carries management traffic is the most common way to lock a MikroTik
    out of itself. Every VLAN change runs through [Change Guard](change-guard.md), which
    predicts lockout before applying and lets the device restore itself if contact is lost.

## Tools

All of these run **on the device**, not from the manager, so they see the network from where
the device sits.

| Tool | Notes |
|---|---|
| Ping | Reachability with RTT and loss |
| Traceroute | Hop-by-hop path |
| IP Scan | ARP sweep of a subnet |
| Wake-on-LAN | Magic packet sent from the device |
| Packet capture | 5–60s sniff, downloaded as `.pcap`. Requires SSH |
| Bandwidth test | Between two managed devices; the target's test server is enabled and disabled for you |

## Syncing and polling

Devices are polled on three cadences — see [Polling and scaling](scaling.md) for the model and
for switching individual collectors off.

**Sync** forces a full collection immediately rather than waiting for the next cycle. It
honours the collector settings, so a collector you have switched off stays off.
