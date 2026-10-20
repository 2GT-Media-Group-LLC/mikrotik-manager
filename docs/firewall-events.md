# Firewall logs

The **Events → Firewall Logs** page presents RouterOS firewall packet logs as
structured events.

Each row can show:

- time and device
- inferred firewall action
- source and destination address and port
- protocol
- firewall chain
- input and output interface

IPv4 and IPv6 packet logs are supported.

## Where the events come from

Firewall logs are collected from the normal RouterOS log stream. A firewall
rule therefore produces entries on this page only when logging is enabled for
that rule.

By default, the page requests firewall events from the last 24 hours. Results
can be filtered by device, action, protocol, or text such as an address, port,
interface, or log prefix.

## Enabling firewall monitoring

Users with write access can select **Configure monitoring** on the Firewall
Logs page.

The dialog shows firewall filter rules for the selected device and allows
logging to be enabled per rule. MikroTik Manager changes only the rule's
logging settings; it does not change the rule action, match conditions, or
order.

Rules managed by MikroTik Manager use an `MTM-FW-*` log prefix so their action
can be identified when the log entry is parsed.

Existing custom logging is not overwritten.

For safety:

- dynamic rules cannot be changed
- FastTrack rules are not enabled for monitoring
- existing custom logging is preserved
- potentially high-volume rules require the explicit **Allow high-volume
  rules** option before their monitoring toggle becomes available

The high-volume option only unlocks those rule toggles. It does not enable
logging automatically.

Disabling monitoring for a rule that MikroTik Manager previously enabled turns
off its managed logging and removes the managed prefix.
