# CAPsMAN

[← Documentation index](README.md)

An access point provisioned by CAPsMAN holds none of its own wireless configuration —
the controller owns it. Reading the AP directly returns blank SSID, security and band,
which makes a perfectly healthy access point look broken.

The platform models the controller relationship instead.

## Device roles

Every device is classified each poll from `/interface/wifi/capsman` and
`/interface/wifi/cap`:

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

Legacy `/caps-man` — the pre-RouterOS 7 controller — is a separate API tree and is not
covered. The RouterOS 7 `wifi` stack is supported.
