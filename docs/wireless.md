# Wireless

Outdoor PTP/PtMP bridges and CPE can use the **Wireless Systems** device category.
The [antenna aligner](antenna-aligner.md) is available only on Wireless Systems devices;
these radios also remain visible in the shared Wireless management pages.

Radios, SSIDs, RF health and guest access. Both the RouterOS 7 `wifi` package and the legacy
`wlan` package are supported; the platform detects which a device uses.

**Which devices count.** The wireless pages cover any device with radios of its own,
whatever type it was added as. All-in-one routers such as the hAP ac² (RBD52G) are
usually added as routers, and they get their **Radios** tab, a place on the wireless
pages, and live radio stats like any access point. CAPsMAN controllers are covered too. The
manager checks once whether a device has radios. It looks in both places: radios under the
legacy package's `/interface/wireless`, or under `/interface/wifi`, which every RouterOS 7.13+
device has because CAPsMAN is built in. A device counts only if one of those lists
interfaces. Many RouterOS 6 routers have the legacy package and no radios, and a hAP ac² on the
legacy package lists nothing under `/interface/wifi`.

## Radios and SSIDs

**Wireless → Radios & SSIDs** manages wireless interfaces and security profiles: create, edit,
enable, disable and remove SSIDs, with WPA2 and WPA3 profiles. An SSID can be deployed across
many access points in one action rather than configured per device.

A device's own **Radios** tab shows the same interfaces with live channel, connected client
count and signal distribution for that device alone.

Disabling a wireless interface, with the power button or by ticking **Disabled** when editing
it, asks first, naming the SSID: its clients will be disconnected, and if the device is managed
over that wireless link the manager may lose contact (#294). Enabling one doesn't ask.

## RF Health

**Wireless → Overview** aggregates the fleet:

- **Channel usage** across 2.4, 5 and 6 GHz, with co-channel overlap highlighted.
- **AP deployment density** — client count plotted against signal, so an AP serving many
  clients at poor signal is visible as a cluster in the wrong corner.
- **TX-retry histogram**, derived from per-client CCQ. This is only available on the legacy
  `wireless` driver; on an all-RouterOS-7 fleet the panel says so rather than showing an empty
  chart forever.
- **DHCP pool usage**: how full each address pool is (see
  [DHCP](network-services.md#dhcp)). It replaced the log-derived "WiFi Connectivity Success"
  funnel, which counted ordinary disconnects as failures (#156). An exhausted pool is the
  quiet failure worth watching: clients connect and get no address.

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

With the newer **wifi** package a network's security shows its authentication types (for example
`wpa2-psk,wpa3-psk`). The older **wireless** package only says whether a network is encrypted,
so its networks show **secured** or **open**.

Some routers on the older package leave that flag out of the scan's API reply: a hAP ac² returns
address, channel, SSID, signal, noise and SNR, and nothing about privacy (#295), though the same
scan in the terminal has it. On those, MikroTik Manager runs the scan as a script, as the
terminal would, and reads the flag from its output; once a router is known to need this, later
scans go straight to the script. The first scan of such a router after the manager starts runs
twice, and a scan briefly takes the radio off its clients, as any scan on the older package does.

Where even that doesn't work (RouterOS 6, which can't return a script's output over the API, or
an API user without permission to run scripts), networks show **unknown**, with an explanation
on hover, rather than being guessed open or protected; betas before 0.73.0 showed them as open,
which was wrong.

The backend log notes, for every scan, which path it took and which fields came back, names
only (`[ap-scan] <device> <radio> (legacy wireless…): 179 rows, fields: …`), so a report like
this can be settled from one line.

A scan takes the radio off its channel: its clients drop for a few seconds, and so does the
radio's own link if it is itself connected to another access point (a wireless link, say). Avoid
scanning a radio the manager reaches the device through.

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
