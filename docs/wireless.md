# Wireless

Radios, SSIDs, RF health and guest access. Both the RouterOS 7 `wifi` package and the legacy
`wlan` package are supported; the platform detects which a device uses.

## Radios and SSIDs

**Wireless → Radios & SSIDs** manages wireless interfaces and security profiles: create, edit,
enable, disable and remove SSIDs, with WPA2 and WPA3 profiles. An SSID can be deployed across
many access points in one action rather than configured per device.

A device's own **Radios** tab shows the same interfaces with live channel, connected client
count and signal distribution for that device alone.

## RF Health

**Wireless → Overview** aggregates the fleet:

- **Channel usage** across 2.4, 5 and 6 GHz, with co-channel overlap highlighted.
- **AP deployment density** — client count plotted against signal, so an AP serving many
  clients at poor signal is visible as a cluster in the wrong corner.
- **TX-retry histogram**, derived from per-client CCQ. This is only available on the legacy
  `wireless` driver; on an all-RouterOS-7 fleet the panel says so rather than showing an empty
  chart forever.
- **Connectivity funnel** — association, authentication and DHCP success, derived from device
  log lines.

!!! warning "The connectivity funnel is approximate"
    It is regex matching over RouterOS log messages, and it counts a disassociation as an
    association failure. Clients leave healthy networks constantly, so a low association
    percentage frequently means nothing at all. The DHCP stage is the most trustworthy of the
    three. This panel's usefulness is under review (issue #156).

## Signal quality

Bands are **−70 / −55 / −45 dBm**:

| Band | Range |
|---|---|
| Poor | below −70 |
| Fair | −70 to −55 |
| Good | −55 to −45 |
| Excellent | above −45 |

An average phone drops off a network around −75 dBm and −85 is effectively the noise floor, so
the Poor band is genuinely poor rather than merely unimpressive.

Dedicated point-to-point radios — SXTsq, GrooveA and similar — run normally at around −80 dBm
and will read Poor here. One scale cannot serve both jobs.

## Rogue and neighbour APs

Scan results are stored and cross-referenced against your own SSIDs and radio MACs. A foreign
BSSID broadcasting one of your SSIDs is flagged as an evil twin.

Scans run on demand or on a schedule; spectral scans are configured per radio.

## CAPsMAN

Centrally provisioned access points are modelled separately — see [CAPsMAN](capsman.md),
including the current read-only limitation.

## Guest WiFi

**Wireless → Guest WiFi** builds a captive portal in one pass: a guest SSID on every radio,
VLAN segregation, an address pool, DHCP, a hotspot profile, a bandwidth-limited user profile
and optionally NAT.

It also provides batch vouchers with printable sheets, a live guests-online table, and a walled
garden editor.

Because it writes across several subsystems at once, review the summary step before applying.
