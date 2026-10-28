# CAPsMAN

[← Documentation index](README.md)

An access point provisioned by CAPsMAN holds none of its own wireless configuration —
the controller owns it. Reading the AP directly returns blank SSID, security and band,
which makes a perfectly healthy access point look broken.

The platform models the controller relationship instead.

## Device roles

Every device is classified from `/interface/wifi/capsman` and `/interface/wifi/cap`, and
for legacy CAPsMAN from `/caps-man/manager` and `/interface/wireless/cap`
(see [Legacy CAPsMAN](#legacy-capsman)):

| Role | Meaning |
|---|---|
| `standalone` | Has radios, manages them itself |
| `cap` | Radios are provisioned by a controller |
| `controller` | Runs CAPsMAN; has no radios of its own |
| `controller_cap` | Runs CAPsMAN **and** its own radios under it — a supported MikroTik arrangement |
| `none` | No wireless hardware |

The role is detected, not inferred from `device_type`. That matters because a dedicated
controller is usually classified as a router, and `device_type` is a label a human typed
rather than a fact about the hardware. The Radios tab and the wireless section follow the
detected role.

A device found to have no wireless role (`none`) is checked again about once a day, and on a
manual **Sync**, so a router where CAPsMAN is switched on after it was added becomes a
controller (#365). A check where the device didn't answer, or answered with an error other than
"no such command", isn't recorded.

A recorded role only changes when two checks in a row agree. Until then the device keeps its role,
and a controller keeps its list of CAPs and radios. One bad read after a restart turned working
controllers into `none` and moved their clients back onto them (#365). A controller where CAPsMAN
really is switched off shows as `none` after the next slow poll (about 5 minutes), or a second
**Sync**.

## How CAPs are matched to devices

The controller enumerates every radio it manages — local and remote — through
`/interface/wifi/radio`, each with a `radio-mac`. Those MACs are matched against every
interface MAC in the fleet.

MAC rather than IP address, deliberately: a MAC is hardware identity and unique
fleet-wide, whereas an address is only unique within a broadcast domain. An installation
with several segments reusing the same addressing would otherwise attribute a radio to
the wrong device entirely.

Two refinements come from real deployments:

- A controller **mirrors each CAP's interfaces locally**, so a CAP's radio MAC genuinely
  appears on two devices. A radio the controller reports as `local: false` lives on a CAP
  by definition, so the controller is never a valid answer for it.
- A radio MAC often differs from the device's interface MAC in the final octet, so lookup
  falls back to a five-octet prefix while keeping the OUI exact.

A CAP that is **not** in the fleet is surfaced as unmanaged rather than hidden — that is
usually the reason an access point appears to be missing.

## What you get

The **CAPsMAN panel** on the Wireless page lists every controller with the access points
it provisions, one row per radio: the AP it lives on (linked), interface name, provisioned
SSID, operating channel, connected clients, and state.

Two details are read from the controller rather than the CAP, because the CAP does not
know them:

- **SSID** — held on the controller's mirror of the interface.
- **Client counts** — a CAP's own registration table is empty when traffic is processed
  centrally. Counts come from the registration table with each client attributed to its
  radio by following `master-interface`, since clients register on the virtual AP carrying
  the SSID rather than on the physical radio.

**Clients are shown on the access point they're connected to**, even when the controller
is the one listing them (#365). With traffic processed on the controller, its
registration table names each CAP radio by the controller's copy of it (`WAP-5Ghz`). The
client list, client detail, the AP density chart and the topology map put the client on
the CAP that radio lives on, on the CAP's own interface for it (`wifi2_5Ghz`), with the
CAP's way up as its connection path. A client on a virtual AP, such as a guest SSID,
moves to the CAP too and keeps the controller's interface name. If the CAP isn't a
managed device, the client stays on the controller.

A controller with radios of its own (`controller_cap`) is listed with its own clients. Its copies
of its CAPs' interfaces hold the CAPs' clients, and those are counted on the CAPs.

**A controller with no radios of its own isn't an access point.** It has its own section
on the Wireless page, and isn't counted in **Total APs** or listed in the **Access
Points** table. In **Channel Usage**, the controller's copy of a CAP radio is left out
when the CAP is a managed device, since the CAP's own entry shows that radio. If the CAP
isn't managed, the copy is the only view of that radio, so it stays, grouped under its
controller.

## Write protection

A provisioned radio is owned by the controller, so a local write to it is either rejected
outright or silently replaced at the next provision — while the API reports success.

Five paths refuse or skip provisioned radios, naming the controller in the error: bulk
SSID deployment, interface create, interface edit, interface delete, and guest network
setup.

## Current limits

**Provisioning, configuration edits and interface enable/disable are deliberately not
exposed.** A CAPsMAN configuration applies to every access point bound to it
simultaneously — the fleet-wide version of the failure [Change Guard](change-guard.md)
exists to prevent. Those operations are held back until they carry the same
prediction-and-revert protection that per-device changes do.

## Legacy CAPsMAN

The original CAPsMAN (`/caps-man`, from the `wireless` package) is supported too (#250).
Older 802.11n and 802.11ac wave 1 access points (RB951, hAP ac lite, cAP ac and similar)
can only be CAPs of this one, often managed from a CHR.

- **Controller:** a device with `/caps-man manager` enabled is a controller, even when it
  also has the newer `wifi` menu, as every RouterOS 7.24 device does. A controller can run
  both CAPsMANs at once (newer APs on one, legacy APs on the other); both are read, and
  their radios and clients are listed together.
- **Radios and APs:** read from `/caps-man interface` and matched to access points by MAC,
  the same way as the newer CAPsMAN. The Wireless page and the CAPsMAN panel show them
  without any difference.
- **Clients:** under legacy CAPsMAN only the controller lists the clients
  (`/caps-man registration-table`); the access point's own table stays empty. They're
  read from the controller with their signal, traffic and last known address, named by
  the comment given to them there when DHCP doesn't name them. A client on one of a
  managed access point's radios is shown on that access point. One on a virtual
  interface, or on an access point that isn't managed, is shown on the controller.
- **The CAP:** an access point whose `/interface wireless cap` is enabled is a CAP. The
  interfaces it hands to the controller are marked as managed by CAPsMAN and show the SSID
  from the controller rather than the AP's own, unused settings.

Devices classified before this was added are checked once more, so an existing legacy
controller is found after upgrading.

Developed against the #250 reporter's CHR and RB951Ui-2HnD output (RouterOS 7.24.5). It
hasn't been run against RouterOS 6.

## Roaming history

A client's association history is reconstructed from access point logs at
`GET /api/clients/:mac/roaming?range=24h`, and shown on the client detail page.

Roaming happens between polls, so a poll-based view can never see it — the log is
the only record that a client moved, when, and at what signal. Sessions are rebuilt
from RouterOS's own lines, including every band or AP change and the disconnect
reason.

Sessions with six or more roams per hour are flagged. A client bouncing between
radios usually indicates roaming thresholds rather than a faulty client: overlapping
cells at similar signal give it no reason to prefer one.

Nothing new is collected — this reads the events already gathered, so it works
retroactively over whatever log history exists. It does require association logging
to be enabled on the access points.
