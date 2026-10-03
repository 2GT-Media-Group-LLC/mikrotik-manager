# Network services

DHCP, DNS, NTP, WireGuard, logging, NetFlow and discovery, viewed across the fleet rather than
one device at a time. **Network Services → Overview** is a table of which devices run what:
search it, sort by any service, and click a row to open the device.

Everything here writes to the device. Changes go through [Change Guard](change-guard.md) where
they could affect reachability.

## DHCP

Servers, address pools and leases, per device. A device's lease list shows the first 100;
**Show all** lists the rest.

- **Leases** lists every current lease across the fleet, with the client it belongs to. A
  dynamic lease can be converted to static in place, which is the usual way to pin an address
  to a device you care about.
- **Pools** and **servers** can be created, edited and removed.
- A static **IPv6 binding** is matched by the client's DUID, not its MAC address, and assigns
  a prefix. Before 0.24.51 the form asked for a MAC address, which RouterOS refused.

A DHCP server bound to an interface that later changes VLAN is a common way to hand out
addresses on the wrong segment; the lease list is the quickest way to notice.

## DNS

The resolver configuration on each device, plus static entries.

- **Static DNS** entries are managed per device, including regexp entries. The record types
  are RouterOS's own: A, AAAA, CNAME, MX (with a preference), NS, TXT, SRV (with port,
  priority and weight) and FWD (forward that name to another DNS server). RouterOS has no
  static PTR record. Before 0.24.51 MX, NS and SRV targets went into the wrong field and the
  record wasn't created.
- **Flush cache** clears the resolver cache on a device, which is worth doing after changing
  an upstream server or a static entry.

## NTP

Client and server configuration. Worth more attention than it usually gets: a device with the
wrong clock produces logs that cannot be correlated, certificates that appear
invalid — see [Alerting](alerting.md#certificate-expiry) — and scheduled work that fires at
the wrong time.

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
