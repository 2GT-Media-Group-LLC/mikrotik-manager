# Bulk commands

[← Documentation index](README.md)

Run RouterOS console commands across many devices, in waves, stopping at the first
failure. Several commands on separate lines run in order.

Commands run over **SSH**, because console syntax — `:put`, `:foreach`, `/interface print`
— is not reachable through the binary API, which has its own command tree.

## Templates

Commands you run more than once can be saved as templates: firewall rules, LTE settings, DNS
and NTP defaults, anything you would otherwise keep in a notes file.

- The **Templates** page (under Operations) lists them all, with search, and lets you create,
  edit, duplicate and delete them. **Run** opens a template in Bulk Commands.
- On Bulk Commands, **Save as template** saves what's in the command box, and **Load a saved
  template** puts one back. Edit it there if needed; **Update** saves the edited version.

Loading or running a template only fills the command box. It runs like any typed command, with
the same waves, halt-on-failure and Change Guard. A template can also run on each device after
a firmware upgrade: pick it under **Then run** when creating a rollout (see
[Firmware rollouts](firmware.md#the-pipeline)).

### Config Templates

Config Templates, which could only set DNS servers, NTP servers and a syslog host, have been
merged into templates. Existing ones are converted automatically on upgrade, marked "from
Config Templates", into the equivalent commands:

```
/ip dns set servers="1.1.1.1,8.8.8.8"
/system ntp client set enabled=yes servers="pool.ntp.org"
:local a [/system logging action find target=remote]; :if ([:len $a] > 0) do={ /system logging action set ($a->0) remote="10.0.0.5" }
```

The syslog line does what Config Templates did: it updates the first remote logging action and
does nothing if there isn't one. The NTP line uses RouterOS v7 syntax; the old version also
tried the v6 form. The old `/api/config-templates` endpoints now answer `410 Gone`.

## Choosing devices

Pick them individually, or use **All** / **None**. Devices are grouped by site, with a
checkbox per site that selects all of it, and a search box once the list is long. The same
picker is used for [maintenance windows](alerting.md#maintenance-windows).

Where devices carry tags, each tag in use appears as a chip beside those buttons and selects
every device carrying it. Tags are assigned on the device page, or to many devices at once
from the [device list](devices.md#the-device-list).

This is what tags are for. Sites group devices by where they are and device types group them
by what they are, and both are single-valued; a tag is many-per-device and crosses both, which
makes it the right way to express "the three switches I upgrade first" or "never touch these
during business hours".

## Why waves exist

A shell loop already runs a command on many hosts, costs nothing, and prints errors as
they happen. What it cannot do is **stop**.

Devices run together within a wave; waves run strictly in sequence. With halt-on-failure
enabled, a mistake reaches one wave rather than the whole fleet. That is the entire reason
to do this here rather than in a terminal — without it, this would be a worse shell loop.

Start with a wave of one. Widen it once the command has proved itself.

## Detecting failure

RouterOS reports most errors in the **output text** rather than through an exit code, so a
rejected command and a successful one are indistinguishable unless the output is read.

Output is scanned for unambiguous markers — `syntax error`, `bad command name`, `no such
item`, `failure:` and similar. The matching is deliberately conservative: mistaking
ordinary output for failure would halt a run that was working, which is worse than the
error it guards against.

## Change Guard

Each device is wrapped by [Change Guard](change-guard.md) by default, so one that stops
answering after the command restores itself.

With Change Guard on, a device that can't arm it (for example, its API user isn't allowed
to save a backup) is marked **failed** rather than run without protection, and that counts
toward halt-on-failure. A device where the revert couldn't be confirmed removed is marked
successful, with a note giving the time it may still revert.

It is **one click to turn off**. You may know exactly why you are running something that
will drop a device, and a tool that refuses to cut is not a sharp tool.

The one combination that asks for explicit acknowledgement is a command that can sever
management **with the guard disabled** — the only case where nothing catches a mistake.

## Preview

Before running, the preview shows:

- which devices are selected and which wave each falls into
- whether the command matches patterns that can cut management access, and why
- devices with **no SSH credential**, which would otherwise produce a wave of identical
  authentication failures

It warns; it never blocks.

## Output

Captured per device and kept with the run. Some commands exist purely for their output —
`:put [:resolve google.com]` across a fleet is a legitimate use — and "it failed" without
the device's own words is not actionable.

## Stopping a run

Cancelling prevents the **next wave**. Devices already executing finish, because that is
the only point at which stopping is safe.

## Requirements

Every targeted device needs an SSH credential: either a password, or a verified
[SSH key](ssh-keys.md). On a fleet of any size, keys are the practical answer.
