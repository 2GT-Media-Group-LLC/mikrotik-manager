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

The address can be a LAN IP, a public IP, an IPv6 address, or a hostname (a local DNS name, or
a router's own `/ip cloud` DDNS name). Pasting a full URL like `https://203.0.113.5:8729/`
works too — the port is pulled out into the API Port field automatically. Reaching a device
over the internet on the plaintext API port (8728) sends the login unencrypted, so the form
warns and suggests api-ssl (port 8729) or a VPN instead.

!!! note "Reachable over a VPN but not over its public IP?"
    RouterOS's own `IP → Services` list restricts each service (`api`, `api-ssl`) by an
    **"Available From"** address list. It accepts the TCP connection from anywhere, then
    silently drops it mid-login if the source isn't on that list — which shows up here as
    "The device closed the connection during login," not a normal refused/timed-out error.
    If a device connects fine over WireGuard (or another VPN) but not from its public IP,
    check that field: either add the reachable range, or leave it restricted and keep using
    the VPN, which is the safer choice for internet-facing management anyway.

**Try All** runs a bulk add across every discovered device as a server-side job. It survives a
closed browser tab and reports progress and failures per device.

### Importing from CSV

**Import CSV** on the Devices page adds up to 500 devices from a spreadsheet.

1. In the import dialog, click **Download template**.
2. Open it in Excel or Google Sheets. It has one column per field and a few example rows.
3. Replace the example rows with your devices, one per row, and save as CSV.
4. Choose the file in the same dialog.

| Column | Needed | What to put in it |
|---|---|---|
| `ip_address` | Required | The device's IP address or hostname |
| `name` | Optional | What to call it. Blank uses the address |
| `type` | Optional | `router`, `switch`, `ap` or `other`. Blank means router |
| `preset` | Login | The name of a saved [credential preset](configuration.md) |
| `username`, `password` | Login | The RouterOS login, if not using a preset |
| `ssh_username`, `ssh_password` | Optional | Only if SSH uses a different login. Blank uses the one above |
| `tags` | Optional | Existing tags. Create them under Settings → Tags first |
| `notes` | Optional | Anything you like |

For several tags on one device, separate them with a vertical bar: `branch|lab`.

Each device needs a login: a preset, or a username and password. `port` and `ssh_port` can
be added as extra columns if yours aren't the defaults (8728 and 22).

The file is checked before anything is sent. Each row shows as ready, skipped or a problem,
with the reason. Skipped rows are:

- devices that are already managed
- the template's example rows, if they were left in (they use `192.0.2.x`, an address range
  reserved for examples)

Columns can be separated by commas, semicolons (which Excel uses in many countries) or tabs.
Unknown columns are listed and ignored.

The import runs as the same server-side job as **Try All**, so the tab can be closed.

!!! note "Credentials are stored encrypted"
    API passwords are encrypted at rest with the key from `ENCRYPTION_KEY`. Losing that key
    means re-entering every device password; see [Configuration](configuration.md).

## The device list

Filter by status, type, tag, rack or location, and sort by any column. The search box matches
name, address, serial and MAC.

Tags appear beside the device name. They are the only grouping that crosses both sites and
device types — see [Bulk commands](commands.md) for selecting a fleet by tag.

To tag many devices at once, tick them in the list (the box in the header selects every device
the current filters show), then choose **Add tag…** or **Remove tag…** in the bar that appears.
Tags can also be picked when adding a device, and set per row in a [CSV import](#importing-from-csv).
Tags themselves are created under **Settings → Tags**.

## Status colours

| Colour | Meaning |
|---|---|
| Green | Online |
| Amber | **Degraded**: online, but a power supply or fan reports a failure, or a temperature is at or over the limit |
| Red | Offline |
| Grey | Unknown, or offline when the device is marked as expected to drop out |

### Hardware health

The manager reads `/system/health` every few minutes, and on **Sync**. A device is degraded
when:

- a power supply state (`psu1-state`, `psu2-state`, …) is anything other than `ok`
- `fan-state` is anything other than `ok` (a fan speed of 0 on its own is not a failure, as
  some models stop their fans when cool)
- any temperature reaches the limit, 85 °C by default, set under **Settings → Alerting**

Voltages are not judged, since normal ranges depend on the model and power source.

The device's Overview tab lists the problem. If it is deliberate, for example a dual-supply
switch fed from one supply, click **Ignore on this device** and that reading no longer counts.
Ignored readings stay listed so they aren't forgotten.

Becoming degraded, and recovering, raise the `device_degraded` and `device_health_restored`
alerts, and are written to the device's event log.

### Devices that go offline on purpose

On a device's Overview tab, tick **Expected to go offline at times** for solar or battery
powered devices, or anything else that drops out normally. Such a device:

- shows grey rather than red when offline, and isn't counted as unreachable on the dashboard
- sends no offline alert when it drops out
- alerts once if it stays offline longer than its limit (24 hours by default; 0 means never),
  and then sends a recovery alert when it returns

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
