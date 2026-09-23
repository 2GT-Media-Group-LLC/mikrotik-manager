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
