# Network services

DHCP, DNS, NTP, WireGuard, logging, NetFlow and discovery, viewed across the fleet rather than
one device at a time. **Network Services → Overview** summarises which devices run what.

Everything here writes to the device. Changes go through [Change Guard](change-guard.md) where
they could affect reachability.

## DHCP

Servers, address pools and leases, per device.

- **Leases** lists every current lease across the fleet, with the client it belongs to. A
  dynamic lease can be converted to static in place, which is the usual way to pin an address
  to a device you care about.
- **Pools** and **servers** can be created, edited and removed.

A DHCP server bound to an interface that later changes VLAN is a common way to hand out
addresses on the wrong segment; the lease list is the quickest way to notice.

## DNS

The resolver configuration on each device, plus static entries.

- **Static DNS** entries are managed per device, including regexp entries.
- **Flush cache** clears the resolver cache on a device, which is worth doing after changing
  an upstream server or a static entry.

## NTP

Client and server configuration. Worth more attention than it usually gets: a device with the
wrong clock produces logs that cannot be correlated, certificates that appear
invalid — see [Alerting](alerting.md#certificate-expiry) — and scheduled work that fires at
the wrong time.

[Configuration templates](devices.md) can push the same NTP servers to many devices at once.

## WireGuard

Interfaces and peers per device: create, edit, enable, disable and remove. Peer public keys and
allowed addresses are shown so a tunnel can be checked against the far end without leaving the
platform.

## Logging (syslog)

Where each device sends its logs — remote actions and the rules that select which topics go to
them. Rules can be toggled without deleting them.

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

### SNMP contact and location per device

SNMP settings are applied when you press **Apply**, to every online switch (or router) in
the current site. They are never pushed automatically. Contact, location and trap target can
use variables, filled in per device:

| Variable | Value |
|---|---|
| `{identity}` | RouterOS identity (`/system identity`). `{$systemidentity}` also works |
| `{name}` | Device name in the manager |
| `{ip}` | Management address |
| `{model}`, `{serial}` | From the device |
| `{site}` | Site name |
| `{location}` | The device's location address in the manager |

For example, contact `{identity}@example.com` or location `{site} / {location}`. An unknown
variable is rejected before anything is written.

A blank field keeps each device's current value. Before 0.24.26 a blank field overwrote it
with nothing.
