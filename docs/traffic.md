# Traffic analytics

Per-client and per-application traffic, from a NetFlow collector built into the platform.

## The collector

The platform listens for **NetFlow v9 and IPFIX on UDP 2055**. There is no external collector
to run. Point a device's exporter at the platform's address and flows start arriving.
It accepts IPv4 and IPv6 exporters on the same port where the host's kernel has IPv6, and
IPv4 only where it doesn't. A device exporting over IPv6 is recognised by its IPv6 address,
however that address was written when the device was added.

How flows are counted:

- **Deduplication.** A flow crossing two managed routers is exported twice. It is counted once.
- **Exporters are identified by source address.** A flow is taken as coming from the managed
  device that owns its source address (its management address or any address on it).
- **Clients are matched within the exporter's site.** A flow's addresses are matched to
  clients seen in the same site as the exporting device, and the traffic is stored with that
  site. Two customers both using 192.168.88.0/24 never have their traffic mixed.

### Flows from unidentified exporters

If NAT sits between your routers and the platform (common with Docker Desktop, or a router
exporting through a firewall), flows arrive from the NAT gateway's address instead of the
router's, and match no device. NetFlow has no authentication, so taking flows from addresses
that aren't managed devices lets anything that can reach UDP 2055 send traffic figures.

That is controlled by **Accept flows from unidentified exporters** on **Network Services →
NetFlow** (fleet admins only):

- **Off** (the default for new installs): such flows are refused, and the page lists the
  addresses being refused so missing traffic isn't a mystery.
- **On**: they are accepted, but only from private, CGNAT, link-local or loopback addresses,
  which is where a NAT gateway in front of the platform would be. Flows from a public address
  are always refused, and the page says so; seeing one means the collector is reachable from
  outside your network (see [Network exposure](configuration.md#network-exposure)).

An unidentified exporter can't say which site it belongs to, so its flows are matched to a
client only when the address exists in exactly one site. With a single site that is always
the case. If the same addresses are in use at more than one site, those flows are counted in
the all-sites view only.

Installs from before 0.24.47 keep the setting they had, which was on.

**Network Services → NetFlow** configures the exporters and the collector.

## What it shows

| View | Answers |
|---|---|
| **Top talkers** | Which clients are using the most, over 1h → 30d |
| **Application breakdown** | HTTPS, QUIC, DNS, SSH, email, WireGuard and others, by port and protocol |
| **Per-client history** | What one client has been doing over time |
| **Time series** | Throughput across the selected range |

Top talkers can be filtered by IP, name, MAC or vendor, and sorted. Selecting a client opens
its detail page — see [Clients](clients.md).

With a site selected, every view shows that site's traffic only, and accounts limited to
particular sites see only theirs. Traffic recorded before 0.24.47 has no site, so on a
multi-site install it appears in the all-sites view only. On a single-site install, or any
selection that includes every device, nothing is filtered and all of it shows (0.24.48;
0.24.47 hid it, and its site filter also made long ranges slow enough to time out).

Application classification is by port and protocol. It identifies what a flow *looks* like, not
what it is: anything on 443 reads as HTTPS whether or not it is a browser.

## Retention

Two settings, both in **Settings**:

| Setting | Default | Covers |
|---|---|---|
| `netflow_retention_days` | 30 | Per-client time series (one-minute detail) |
| `netflow_daily_retention_days` | 365 | Daily per-client rollups |

Flow records are the bulky ones; the daily rollups are small and are what the longer ranges are
drawn from. Raising the first is the expensive change.

## Proxy usage

If a router runs a proxy in a RouterOS container (3proxy, for example) that writes its access
log as JSON to the device log, the dashboard shows a **Proxy usage** card. It ranks the busiest
**Clients**, authenticated **Users**, **Destinations**, and **Denied** attempts over 1 hour,
24 hours, 7 days or 30 days, with a selector when there is more than one proxy. Clicking a row
opens the matching lines on the Events page.

The lines are read from the log the manager already collects, under the topics
`container,info,debug`, so nothing extra runs on the device. The card only appears once such
lines exist. Parsed records are kept for **Proxy log retention** days (Settings → General,
30 by default). On the first start after updating, existing events are scanned once for proxy
lines.

`GET /api/proxy/top?by=client|user|destination|denied&range=1h|24h|7d|30d` and
`GET /api/proxy/sources` serve the card. Contributed by thanhtrung5763 in #177.

## If no data appears

1. Is the collector enabled? `netflow_enabled` in **Settings**.
2. Is UDP 2055 reachable from the device? The platform must be reachable *from* the router,
   which is not the same direction as the API connection.
3. Does the exporter match a known device? If flows arrive from an address the platform cannot
   match, they are refused unless **Accept flows from unidentified exporters** is on, and
   always from a public address. The NetFlow page lists refused sources and why.
