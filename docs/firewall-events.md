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

### Rule activity estimate

Before logging is enabled, MikroTik Manager samples the rule's packet counter
for approximately 5 seconds and shows an estimated packets-per-minute rate in
the **Activity** column.

The estimate is intended as a quick indication of how much log traffic a rule
may produce. Rules matching **1,000 packets/min or more** are treated as
high-volume and require the explicit **Allow high-volume rules** option before
monitoring can be enabled.

The existing structural safety checks still apply. FastTrack rules cannot be
monitored, and rules such as broad ACCEPT or established/related rules also
require the high-volume override.

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

## Device Logs

Firewall packet logs have their own **Events → Firewall Logs** page, so they
are hidden from **Device Logs** by default.

Enable the **Firewall packets** toggle on Device Logs to include them in that
view when needed.

## Retention and clearing

Firewall packet logs have a separate retention setting under **Settings → Data
Retention**. The default firewall log retention is **7 days**.

Other device events continue to use the normal `retention_events_days` setting.

Users with write access can use **Clear** on the Firewall Logs page to delete
stored firewall packet events. When a device is selected, only that device's
firewall logs are cleared. Without a selected device, the operation is limited
to the user's current writable site scope.

Clearing Firewall Logs does not delete ordinary Device Logs.
