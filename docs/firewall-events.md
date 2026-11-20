# Firewall logs

The **Security → Firewall Logs** page presents RouterOS firewall packet logs as
structured events.

Each row can show:

- time and device
- inferred firewall action
- source and destination address (or name) and port
- protocol
- firewall chain
- input and output interface, or from and to zone on a zone-managed device

IPv4 and IPv6 packet logs are supported.

A rule in a chain of your own (a jump target) is logged under that chain's name rather than
input, forward or output. Before 1.1.0-beta.71 (and 1.0.25) those lines were left off this page; now they
show with their own chain's name, and the zone columns work out whether the packet was to the
router, from it, or passing through from its interfaces. A zone rule's **Log** writes lines like
this (see [Zones](devices.md#zones)).

## Grouped and raw

RouterOS logs every packet a logging rule matches, so one blocked client retrying, or a port
scan, fills the page. The page opens **Grouped**, the way a Palo Alto or Check Point log reads:
one line per device, rule, chain, interfaces, protocol, source, destination and destination
port, with how many lines it stands for and when it was first and last seen. The source port
is left out, so retries from new ports stay on one line. Click a count to see its lines in
**Raw**, which shows every line as the device logged it. The page remembers which view you
used last.

Grouping reads the newest 100,000 lines that match the filters; narrow by device or search to
look further back.

For whole connections rather than logged packets, with bytes each way and how each one ended,
see [Sessions](sessions.md), built from NetFlow.

## Zones

On a device whose firewall is managed with [zones](devices.md#zones), the In and Out columns
become **From zone** and **To zone** and show zone names instead of interfaces. Traffic to or
from the router itself shows **Router** as its zone. The chain is left out on those lines,
since the zones already say where the traffic went.

Each zone shows as a coloured badge. The manager doesn't know which zone you trust, so the
colour comes from the name:

- names like untrust, WAN, outside or internet are red;
- trust, LAN, inside or internal are green;
- DMZ, guest or IoT are amber;
- Router is grey;
- any other zone gets a colour of its own that stays the same from page to page.

- An interface in no zone shows as the interface name, in italics.
- When the page mixes zone and non-zone devices, the columns are labelled **From** and **To**.
- The manager reads zone membership when you apply zones, when you open the Zones tab, and
  with the hourly config check. A membership change made on the device shows here within the
  hour.

When a device in the selected site or group runs zones, two filters appear next to the rule
filters: **From any zone** and **To any zone**. Pick a zone in one to see only traffic from it,
or in the other for traffic to it, or both for one direction, such as from WAN to LAN. **Router**
is traffic from, or to, the router itself. The filters cover every zone-managed device in scope,
so picking LAN brings in LAN on each of them; pick a device too for just one. Lines from devices
without zones don't match a zone filter.

## Resolve names

**Resolve names** shows names in place of addresses. Hover a name to see its address. A name
comes from one of two places:

- the hostname of a [client](clients.md) the manager knows at the same site;
- otherwise, a reverse DNS (PTR) lookup from the manager's own resolver.

Reverse DNS answers are kept for an hour and misses for ten minutes. A page waits at most
1.5 seconds for them, and slower answers show on the next refresh. The setting is off by
default, because reverse DNS sends the addresses on the page to the manager's DNS server.
Search still matches addresses, not names.

## Application and row colours

The **Application** column names the service behind a line's port (#415): 443 is HTTPS, 587 is
SUBMISSION, 8291 is WINBOX. It goes by the destination port, or by the source port for a reply
(a DNS answer from port 53 back to a client shows as DNS). The grouped view has only the
destination port, so it names that. Names come from a built-in list based on `/etc/services`,
plus the MikroTik ports it doesn't know (WinBox, the API, MNDP, bandwidth test). Search still
matches ports, not names.

Names you add under **Settings → Firewall Logs** also name applications in
[Traffic](traffic.md#what-it-shows), for ports it would otherwise count as Other TCP or Other UDP.

Two kinds of background traffic get a row colour, so they stand apart:

- **DHCP**: UDP 67/68, and DHCPv6 on 546/547. A DHCP discover to 255.255.255.255 counts as
  DHCP.
- **Multicast and broadcast**: 224.0.0.0/4, ff00::/8 and 255.255.255.255. A subnet's own
  broadcast address (192.168.88.255, say) isn't recognised, because the log line doesn't carry
  the mask.

Set both under **Settings**, **Firewall Logs**, or with **Port names & colours** on the page.
Each colour can be one of nine, or **None**. **Port Names** adds a port the list doesn't know, or
names one it does your way, for TCP, UDP or both. A port can also be a range, such as
`5000-5100`, which names every port in it (from [@ronchan44](https://github.com/ronchan44)'s #415). A single port listed as
well keeps its own name, a narrower range wins over a wider one, and two ranges can't overlap.
Show the built-in list to see what it already names; a port you've renamed is struck out there. Everyone sees the same names and colours;
only admins change them.

## Where the events come from

Firewall logs are collected from the normal RouterOS log stream. A firewall
rule therefore produces entries on this page only when logging is enabled for
that rule.

By default, the page requests firewall events from the last 24 hours. The
period selector changes that to the last hour, 7 days or 30 days (only lines
still within the firewall log retention are there to find), and a link can
open it with `?range=1h|24h|7d|30d`. Results can be filtered by device, action,
protocol, [zone](#zones), or text such as an address, port, interface, or log prefix.

**All rules** narrows the page to one rule's lines. It lists the log prefixes that logged in
the period, each with its device and how many lines it wrote, busiest first; with a device
picked, a tagged rule is named by its comment. The match is on the whole prefix, so
`PERMIT-ZT` doesn't also bring in `PERMIT-ZT-ADMIN` the way the search box does. Picking a rule
picks its device as well, and a link can open it with `?device=ID&rule=<prefix>`. Lines logged
without a prefix aren't listed: nothing tells their rules apart.

**Hide rules** does the opposite: it leaves the checked rules out and shows everything else,
which is how to read the page without the internet scans a drop rule logs all day. Each hidden
rule is one prefix on one device, matched whole like **All rules**, in both views; lines logged
without a prefix are never hidden. Up to 20 rules can be hidden. The choice is kept in the
browser, and a hidden rule that didn't log in the period stays in the list so it can be shown
again. The API takes it as `?hide=<deviceId>|<prefix>`, repeated.

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

## Which rule logged it

RouterOS writes a rule's log prefix in front of each line it logs, and nothing
else that identifies the rule. So a filter or NAT rule that logs gets a short
**tag** at the end of its prefix, `mtm#` and four letters or digits, unique on
the device, from Ron's request in #369:

```
MTM-FW-DROP mtm#7f3a input: in:ether1 out:(unknown 0), proto TCP ...
```

- A line with a tag shows **rule mtm#7f3a** next to its chain. It opens the
  device's Firewall tab with that rule picked out.
- On the Firewall tab, a tagged rule shows **mtm#7f3a · log lines**, which opens
  this page filtered to that device and that rule's lines. **Logged** narrows
  the tab to the rules that log at all (`log=yes`).
- A rule added or edited in MikroTik Manager with logging on gets a tag by
  itself, and an edited rule keeps the tag it had. A prefix you set is kept,
  with the tag after it.
- Rules that already log without a tag, such as ones made in Winbox, are
  counted at the top of the Firewall tab, with **Tag all** (and **Review
  changes**) to tag them in one go. Only their log prefixes change, through
  [Change Guard](change-guard.md).

## Device Logs

Firewall packet logs have their own **Security → Firewall Logs** page, so they
are hidden from **Device Logs** by default.

Enable the **Firewall packets** toggle on Device Logs to include them in that
view when needed.

## Retention and clearing

Firewall packet logs have a separate retention setting under **Settings → General →
Data Retention**. The default firewall log retention is **7 days**.

Other device events continue to use the normal `retention_events_days` setting.

Users with write access can use **Clear** on the Firewall Logs page to delete
stored firewall packet events. When a device is selected, only that device's
firewall logs are cleared. Without a selected device, the operation is limited
to the user's current writable site scope.

Clearing Firewall Logs does not delete ordinary Device Logs.
