# Change Guard and Config Health

[← Documentation index](README.md)

RouterOS applies every command immediately and independently. There is no transaction,
no rollback, and no cross-object validation — so it will accept a change that severs the
very path you are managing the device over. MikroTik's own documented advice for enabling
VLAN filtering is to have a serial console ready.

Three layers address that. This page covers how they behave and how to configure them;
the [README](../README.md#what-makes-it-different) has the short version.

## Change Guard — device-side auto-revert

Before applying a protected change:

1. The device saves a **restore point** locally.
2. A **scheduler** is armed to reapply it after a timeout.
3. The change is applied.
4. Reachability is proven **on a brand-new connection** — not the one that made the change.
5. Confirmed → the scheduler is disarmed and the restore point deleted.
   Unreachable → nothing is done, and the device restores itself.

The restore point is saved *before* the scheduler is armed, so a rollback returns a
configuration containing neither the scheduler nor the change. It is self-cleaning, and
a revert loop is impossible.

Everything runs over the RouterOS API, so it works on devices with no SSH credentials
configured.

### Covered changes

Twelve change types are guarded:

| Area | Operations |
|---|---|
| Bridge | VLAN filtering toggle |
| Ports | PVID and tagged/untagged membership |
| Bridge VLANs | add, update, delete |
| Addressing | IP address add, remove |
| Routing | route add, remove |
| Bonding | bond create, delete |
| Services | management service enable/disable |

### What you see when it fires

Verified end to end on a CRS running RouterOS 7.23.3 by deliberately deleting a switch's
own management address:

```
T+0      restore point saved, revert scheduler armed, change applied
T+0s     device drops off the network
T+40s    manager gives up after 4 fresh connection attempts and reports back
T+120s   device restores its own backup and reboots
T+3m     device is back, change undone, scheduler and restore point gone
```

The request returns **HTTP 200** with `guard.auto_reverting: true` and the message
*"Contact with the device was lost while applying this change. It is restoring itself and
should come back shortly."* — deliberately not an error.

This matters. The most dangerous changes sever the very connection carrying them, so the
API call times out even though the change succeeded on the device. **Reachability, not the
exception, decides the outcome.** A change that throws while the device is still reachable
is a genuine failure, and the guard is disarmed immediately so nothing reboots for nothing.

### Guard history

Every protected change is recorded per device:

| Status | Meaning |
|---|---|
| `committed` | Change applied, device confirmed reachable, guard disarmed |
| `reverted` | Contact lost; the device was left to restore itself |
| `failed` | Change rejected by the device; nothing applied, guard disarmed |

### Settings

| Setting | Default | Description |
|---|---|---|
| `change_guard_enabled` | `true` | Master switch. When off, guarded changes still apply — with no safety net and no lockout refusal. |
| `change_guard_mode` | `binary` | See below. |
| `change_guard_timeout_sec` | `120` | How long the device waits before rescuing itself. |

**Choosing a mode:**

| Mode | Mechanism | Reboots? | Recovers a deletion? |
|---|---|---|---|
| `binary` | `/system backup` restore | **Yes** | Yes — restores the configuration exactly |
| `script` | `/export` then `/import` | No | **No** — `/import` is additive |

`binary` is the default because a change that deletes an interface can only be undone by
a restore that recreates it. `script` avoids the reboot but cannot undo a deletion, which
is the case most likely to lock you out.

**Choosing a timeout:** it must exceed the time the manager needs to verify reachability —
roughly 40 seconds across four connection attempts — with margin for a slow device. Too
short and a healthy device reverts a good change; too long and an outage lasts longer than
it needs to.

## Lockout prediction

Rather than blocklisting operations someone once decided were dangerous, the platform
reads live device state, resolves how the manager actually reaches the device, simulates
the proposed change against that model, and reports any invariant that flips from
satisfied to violated.

Two details make the result precise rather than merely cautious:

- The **manager's own address**, as the device sees it, is read from the device's
  connection tracking — rather than being treated as unknowable behind NAT.
- The **ingress port** is taken from the bridge forwarding table, so it is the port the
  traffic actually arrives on, not a guess from topology.

The resulting warning names the mechanism:

> **This change is predicted to cut management access to 2GT-NW-100G.**
> Management arrives untagged on `sfp28-1` (PVID 1) — the gateway's MAC is learned there —
> but VLAN 1 has no bridge VLAN entry listing `bridge1` as an untagged member.

### Overriding a verdict

Deliberately awkward. The API requires `confirm_lockout: true` in the request body, and
the UI requires typing the device name. The change then runs under Change Guard regardless,
so an override is a decision to *rely on* auto-revert — not to bypass protection.

A pre-existing violation is reported separately from one your change would cause. That
distinction matters: if an invariant is already broken, that check cannot detect a new
break, and the verdict says so rather than implying a clean result.

### Capability probe

```
POST /api/devices/:id/change-guard/probe
```

Reports what safety mechanisms a device actually supports, tested on the device rather
than assumed. Non-destructive — it creates and removes a harmless scheduler and leaves
nothing behind.

It also establishes whether `/system history` can revert a change without a reboot.
Measured on RouterOS 7.23 over the binary API:

| Command | Result |
|---|---|
| `/system/history/print` | works |
| `/system/history/undo` | no such command |
| `/undo numbers=<id>` | unknown parameter |
| `/undo` | works — reverts the newest action, no reboot |

Undo is therefore real but **untargeted**, and it cannot replace auto-revert: a dead-man
switch has to fire once the manager has already lost contact, and issuing an undo requires
the contact that was just lost. Binary restore remains the default.

## Config Health

A scheduled, read-only audit for configurations RouterOS accepts without complaint and
then quietly fails to honour. Each finding explains what it does to the network, how to
fix it, how long it has been present, and links the relevant MikroTik documentation.

Findings appear on the device's Security tab and in the dashboard's *Things to handle*.

### What it checks

| Finding | Consequence |
|---|---|
| IP address on a bridge slave port | The address is served by the bridge, or not at all |
| VLAN interface on a bridge slave port | The interface receives nothing; management may be unreachable |
| VLAN interface added as a bridge port | Forwarding loop; STP ports flap |
| Bond slave that is also a bridge port | Undefined forwarding path; the bond silently loses members |
| VLAN interface whose VLAN the bridge is not tagged in | The interface is up and carries nothing |
| Management surviving only on a dynamic VLAN entry | Works today; disappears the moment a port admits only tagged frames |
| Port in no VLAN on a filtering bridge | Links up, then every frame is dropped |
| Multi-VLAN bridge entry with untagged ports | Ambiguous; RouterOS warns and applies it anyway |
| PVID next to `frame-type=admit-only-vlan-tagged` | The PVID is stored but never applied |
| Several bridges competing for hardware offload | One silently falls back to CPU forwarding |
| MTU above L2MTU | Large frames dropped without error |
| Duplicate address on two interfaces | Only one can answer; which is not stated by the config |

### Settings

| Setting | Default | Description |
|---|---|---|
| `config_health_enabled` | `true` | Runs the standing audit |
| `config_health_interval_min` | `60` | Cadence per device — one read-only snapshot over the API |

### A note on false positives

Rules are calibrated against real hardware rather than documentation alone. For example,
RouterOS 7 relocates an address configured on a bridge slave port onto the bridge itself
(`actual-interface`), so that stock configuration works — and is reported as informational
rather than critical. Similarly, a port that belongs to no VLAN is only reported when it
is actually active, because an unplugged port carrying no configuration is not a fault.
