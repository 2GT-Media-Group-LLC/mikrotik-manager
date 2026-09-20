# Adopting devices

Two quite different things are called "adding a device", and the platform decides which one
you need rather than asking you to work it out.

**A device that is already configured** — the usual case, and the one that applies when you
first point the manager at an existing network. It has an address, it is reachable, and it
needs nothing except credentials. Nothing on the device is changed.

**A device straight out of its box.** RouterOS ships on `192.168.88.1/24` with no DHCP client
and no default route, so a new switch is visible the moment it is plugged in — it announces
itself over MNDP and every managed neighbour reports it — but nothing can reach it. Until now
that meant Winbox and a MAC address. The platform can now configure it for you.

Both start the same way: **Devices → Discover**, then **Adopt Device** on the row.

## What it detects, and how

Neighbour discovery exposes two things before anything connects: the address and the system
identity. Both being factory defaults means a new device; neither means one already in
service.

| Signals | Verdict |
|---|---|
| On `192.168.88.1` **and** identity is `MikroTik` | Brand-new device |
| Neither | Already configured |
| One but not the other | Brand-new, flagged as uncertain |

The dialog states what it found and what it will do about it, with a link to disagree.
Reachability is deliberately **not** used to decide: a configured switch in a VLAN the manager
cannot route to is unreachable *and* fully configured, and adopting it would rewrite addressing
it is already using.

!!! warning "The check that matters runs later"
    The verdict above is a guess from two fields. After authenticating and **before writing
    anything**, the device is inspected properly — identity, every address, every user account
    — and adoption stops if it does not look untouched. Overriding the dialog does not disable
    that; it is what protects a live switch from a wrong choice.

## What you need

**The password printed on the unit.** Modern MikroTik hardware ships with a unique password on
a sticker rather than a blank one, so there is nothing to pre-fill and nothing to guess. There
is no default and the API refuses the request without it.

**A managed device on the same broadcast domain.** The manager has no path to a factory device,
but a neighbour does. One is borrowed for about a minute. Any device that can see the new one
is offered; pick whichever you would rather touch.

## Addressing

You choose how the device is addressed. None of it is inferred, because a wrong prefix or
gateway strands the device on both networks at once.

| Option | Notes |
|---|---|
| **Static** | Address, prefix and gateway. The prefix is not assumed to be /24, the gateway is not assumed to end in `.1`, and the gateway is checked to be reachable from the address |
| **DHCP** | A client is added and the lease read back to learn where the device landed. Consider a reservation — infrastructure benefits from a stable address |
| **Management VLAN** | Either option, on a tagged VLAN. A `bridge-vlanN` sub-interface is created to carry the address |

A static address is checked against the network first, using both ARP and ping from the
borrowed neighbour. Neither is sufficient alone: an address can answer ping while being absent
from the ARP cache, and an ARP entry can be a record of a *failed* lookup rather than a live
host. Adoption stops rather than handing a switch an address something else is using.

!!! note "If the VLAN is wrong"
    Operations are additive, so the factory address stays until the new one is proven. A
    management VLAN the uplink does not actually carry means verification fails and the device
    is left exactly as reachable as it was — still adoptable, not stranded.

## What it does

1. Borrows the chosen neighbour and gives it a temporary address in the target's subnet
2. Confirms the device answers, and authenticates with the password you supplied
3. Confirms the device really is factory-default
4. Checks the address you chose is free
5. Adds the address, the default route, and the identity — adding only, never replacing
6. Returns the neighbour to exactly how it was found
7. Confirms the manager can now reach the device directly
8. Removes the factory `192.168.88.1` address, if you left that ticked
9. Registers the device and starts polling it

Every step is reported as it happens, so a failure says which one and why.

Removing the factory address is recommended and on by default: two un-adopted devices both
answering on `192.168.88.1` would collide.

## The borrowed device

It gets one temporary IP address, and that is all. It is removed on every path out of the
operation, including failures and refusals. Anything temporary is tagged, and
**Devices → Discover → Clean up** sweeps for leftovers should the process ever be killed
mid-flight.

## Security

The password is sent over plain HTTP. Factory units ship with HTTPS **disabled**, so there is
no encrypted path to a device in that state. It travels only between the borrowed neighbour and
the new device, on your local segment, for the duration of the adoption.

Changing the password afterwards is worth doing regardless: the factory one is printed on the
chassis and known to anyone with physical access.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Could not authenticate" | Wrong password. It is on the sticker, not blank |
| "does not look factory-default" | The device is in service. Add it normally with its credentials |
| "is not free" | Something already answers at that address |
| "no lease arrived" | DHCP chosen with no server on that segment |
| "not answering the API from the manager" | Configured, but unreachable — usually a wrong gateway or a VLAN the uplink does not carry. The factory address is still in place |
| Device not listed | Only MikroTik neighbours can be adopted. Run **Discover** and confirm a managed device can see it |

## What it does not do

It does not configure anything beyond addressing and identity — no VLANs, no ports, no
firewall. Use configuration templates (**Settings → Config Templates**) or
[bulk commands](commands.md) once the device is under management.
