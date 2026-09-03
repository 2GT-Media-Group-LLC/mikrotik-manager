# Bulk commands

[← Documentation index](README.md)

Run one RouterOS console command across many devices, in waves, stopping at the first
failure.

Commands run over **SSH**, because console syntax — `:put`, `:foreach`, `/interface print`
— is not reachable through the binary API, which has its own command tree.

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
