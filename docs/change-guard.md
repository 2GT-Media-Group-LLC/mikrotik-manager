# Change Guard and Config Health

[← Documentation index](README.md)

RouterOS applies every command immediately and independently. There is no transaction,
no rollback, and no cross-object validation — so it will accept a change that severs the
very path you are managing the device over. MikroTik's own documented advice for enabling
VLAN filtering is to have a serial console ready.

Three layers address that. This page covers how they behave and how to configure them;
the [README](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/blob/main/README.md#what-makes-it-different) has the short version.

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

Every write that can take a device off the network runs under Change Guard. Some are
also simulated first, so a change predicted to cut management is stopped before it is
applied; the rest are protected by auto-revert alone.

| Area | Operations | Predicted? |
|---|---|---|
| Firewall filter | add, edit, enable/disable, move, delete | Yes, in rule order (see [Firewall rules](#firewall-rules)) |
| Firewall address lists | add, edit, remove | Yes |
| Bridge | VLAN filtering toggle | Yes |
| Ports | PVID and tagged/untagged membership | Yes |
| Ports | enable/disable | Yes |
| Ports | MTU, FEC, flow control, speed, PoE | Flagged when the port carries management |
| Bridge VLANs | add, update, delete, copy from another switch | Yes |
| Addressing | IP address add, remove | Yes |
| Routing | static route add, remove | Yes |
| Routing | OSPF, BGP, routing tables, route filters | No |
| Bonding | create, edit, delete | Flagged when a member or the bond carries management |
| Services | management service enable/disable | Yes |
| NAT | add, edit, move, delete | No |
| WireGuard | interface enable/disable, delete | Yes; the tunnel the manager arrives through is read-only, below |
| WireGuard | interface edit, peers | Flagged when the tunnel carries management; the manager's own tunnel is read-only, below |
| Wireless | interface edit, enable/disable, delete; security profile edit, delete | Enable/disable and delete predicted; edits flagged when the interface carries management |
| Guest Wi-Fi | hotspot setup, server enable/disable, remove | Setup flagged when the chosen interface carries management |

"Flagged" means the change can't be simulated, but because it touches something the
manager's connection runs through, auto-revert becomes mandatory for it (see
[When protection is required](#when-protection-is-required)).

### The manager's WireGuard tunnel

When the manager reaches a device through WireGuard, that tunnel is left alone from here
(#205). It's the WireGuard interface that either holds the address the manager connects to,
or carries the device's route back to the manager.

- The WireGuard page marks it **Protected**, says why, and shows the interface and every
  peer on it read-only: no switching off, editing or deleting, and no adding peers. The peer
  carrying the manager's address is marked *Manager*.
- The API refuses any change to that interface or its peers, including moving another
  peer onto it, with the reason.

Change it on the device itself (WinBox or the terminal), or move management off the tunnel
first. Other WireGuard interfaces work as before, under Change Guard.

Where the device doesn't track connections, the manager can't see its own address there,
so the peer carrying it can't be singled out (*Maybe manager* on every peer). The tunnel is
protected either way.

Creating a bond also moves the member ports' VLAN membership onto the bond, and deleting
it gives the ports their VLANs back. Before 0.24.44 a port tagged on a VLAN became a bond
that wasn't, and that VLAN stopped crossing the link.

Each guarded change takes a few seconds longer than an unguarded one: the device saves a
restore point first, and the manager proves it can still connect before disarming.

### One change at a time per device

While a protected change is being applied or verified, other writes to the same device
are refused with HTTP 409 and `code: "device_busy"`. A revert restores a backup taken
before its change, so a write that slipped in between would be undone with it. Reads,
diagnostics and the manager's own records (location, monitoring) are not affected.

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
| `committed` | Change applied, device confirmed reachable, guard disarmed and proven gone |
| `reverted` | Contact lost; the device was left to restore itself |
| `failed` | Change rejected by the device; nothing applied, guard disarmed |
| `uncertain` | Change applied and the device is reachable, but the revert scheduler could not be confirmed removed. The device may still restore its previous configuration when the timeout runs out; the UI gives the time. |

Disarming is only counted once the manager has re-read the device's schedulers and seen
the revert gone. A failed read is a failure, not an empty list: before 0.24.36 a timed-out
read could record `committed` while the revert stayed armed and later undid the change.
While a revert may still fire, the device stays locked against other protected changes.

### Settings

| Setting | Default | Description |
|---|---|---|
| `change_guard_enabled` | `true` | Master switch. When off, routine guarded changes apply with no safety net, and changes that need protection (see below) are refused. |
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
  connection tracking — rather than being treated as unknowable behind NAT. When other
  hosts (a monitoring tool, WinBox) are connected to the API port too, the manager picks
  out its own session by its source port; if it can't, it says so and works from the
  default gateway instead of guessing.
- The **ingress port** is taken from the bridge forwarding table, so it is the port the
  traffic actually arrives on, not a guess from topology.

What the model follows:

- the address, the interface holding it, and a VLAN interface's parent port, so
  disabling `ether1` under `vlan10` is caught;
- the bridge and its VLAN table, including a VLAN interface reached through an access
  port whose PVID is that VLAN (tagged at the CPU, untagged on the wire);
- a bond holding the address, under its VLAN interface, or as the ingress port;
- the route back to an off-subnet manager, whether that is the default route or a more
  specific one;
- the API service and the input firewall chain.

A failed read during the check is never taken as "nothing there": the check fails, and the
change then requires auto-revert. VLAN edits are simulated with the same planning code the
device write uses, so the prediction and the write can't disagree about which rows change.
(Before 0.24.49 a port listed as both tagged and untagged for a VLAN was simulated as both;
the write leaves it untagged.)

The resulting warning names the mechanism:

> **This change is predicted to cut management access to 2GT-NW-100G.**
> Management arrives untagged on `sfp28-1` (PVID 1) — the gateway's MAC is learned there —
> but VLAN 1 has no bridge VLAN entry listing `bridge1` as an untagged member.

### Firewall rules

The input chain is evaluated the way RouterOS does it, first match wins, for the
connection the manager actually opens: a new TCP connection from its address to the API
port, arriving on the interface that holds the management address. Address lists,
interface lists and jumps into custom chains are followed. Anything the check can't
evaluate (tcp-flags, rate limits, marks, time) counts as "maybe", and a rule that maybe
matches makes the answer "can't tell" rather than a guess.

So enabling a staged drop rule with the toggle, moving a drop above the rule that
accepts the manager, deleting that accept rule, or removing the manager from an accepted
address list is caught before it is applied. RouterOS's default configuration is
understood correctly: it lets LAN traffic reach the end of the chain, so appending a
drop-all to it is predicted as a lockout.

Only the IPv4 filter table is checked. Rules in the raw table are not, and a manager
connecting over IPv6 isn't affected by the IPv4 filter at all. If the device has
connection tracking switched off (RouterOS turns it on only once firewall rules exist),
the manager's address isn't known, so rules scoped to a source address count as "can't
tell".

### Overriding a verdict

Deliberately awkward. The API requires `confirm_lockout: true` in the request body, and
the UI requires typing the device name. The change then runs under Change Guard regardless,
so an override is a decision to *rely on* auto-revert — not to bypass protection.

### When protection is required

Auto-revert is mandatory, not best effort, for a change that:

- you confirmed past a lockout warning,
- the prediction flagged as a warning, or
- could not be analysed (the device's state couldn't be read), or
- depends on something the check couldn't evaluate.

A failed read of any part of the device's state counts as "could not be analysed". Before
0.24.44 a failed read was treated as an empty table, which could produce a confident
"safe".

If the device can't arm auto-revert for one of these (the API user can't save a backup or
add a scheduler, the flash is full, or Change Guard is turned off), the change is **refused
before anything is applied**, with HTTP 422 and `code: "guard_required"`. Until 0.24.36 it
ran unprotected and only said so afterwards. Bulk commands with Change Guard ticked follow
the same rule: a device that can't arm it is marked failed, which counts toward
halt-on-failure.

The lockout dialog checks this before you confirm, so it never promises protection the
device can't give:

```
POST /api/devices/:id/change-guard/check   ->  { "ready": true, "mode": "binary", "reason": null }
```

The check does what a real guard does, with throwaway names: it saves a restore point and
adds a scheduler, then removes both.

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
| Ingress port would reject the frames management arrives in | `admit-only-vlan-tagged` on a port carrying untagged management drops it at ingress, while every VLAN row still lists the port |
| Spanning tree off on a bridge with several active ports | Nothing stops a loop; the second cable someone plugs in becomes a broadcast storm |
| Bridge running classic STP rather than RSTP | Convergence takes tens of seconds where RSTP takes under one |
| Device-mode blocks the scheduler | Change Guard can't arm its automatic undo, so changes that could cut off management are refused |
| Device-mode blocks bandwidth-test, sniffer, hotspot or fetch | The bandwidth test, packet capture, Guest WiFi wizard or adopting through this device fail with "not allowed by device-mode" |
| RouterOS has flagged the device | RouterOS found configuration it considers suspicious; device-mode can't change until it's cleared |

Changing [device-mode](https://help.mikrotik.com/docs/spaces/ROS/pages/93749258/Device-mode)
needs someone at the device: RouterOS asks for a button press or power-cycle to confirm.

### Settings

| Setting | Default | Description |
|---|---|---|
| `config_health_enabled` | `true` | Runs the standing audit |
| `config_health_interval_min` | `60` | Cadence per device — one read-only snapshot over the API |

Both are under **Settings → General → Config Health**. Before 0.24.37 the scheduler never
read them, so the audit always ran hourly whatever they said.

### A note on false positives

Rules are calibrated against real hardware rather than documentation alone. For example,
RouterOS 7 relocates an address configured on a bridge slave port onto the bridge itself
(`actual-interface`), so that stock configuration works — and is reported as informational
rather than critical. Similarly, a port that belongs to no VLAN is only reported when it
is actually active, because an unplugged port carrying no configuration is not a fault.
