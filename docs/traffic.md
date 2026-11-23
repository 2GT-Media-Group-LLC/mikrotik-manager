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

With accepting on, a router behind NAT is usually still recognised by when it booted: every
NetFlow packet carries that time, and polling records it for each device. Its flows are then
counted under its own name and site, as if they came from its address. Two routers that booted
within 10 seconds of each other stay unidentified.

**Network Services → NetFlow** configures the exporters and the collector.

## What it shows

| View | Answers |
|---|---|
| **Top Talkers** | Which clients are using the most, over 1h → 30d |
| **Application breakdown** | HTTPS, QUIC, DNS, SSH, email, WireGuard and others, by port and protocol; click one to see who's using it |
| **Per-client history** | What one client has been doing over time |
| **Time series** | Throughput across the selected range |

Top Talkers can be filtered by IP, name, MAC or vendor, and sorted. Selecting a client opens
its detail page — see [Clients](clients.md).

**Unattributed (local)** is traffic whose local end is a private, CGNAT or link-local address
that MikroTik Manager can't match to a client it knows in that site, such as a host it hasn't
seen in DHCP or ARP. Downloads through NAT are recorded as they arrive on the WAN, addressed to
the router, and are counted for the LAN client from the post-NAT destination, so leave
`nat-dst-address` on in the router's IPFIX settings (**IP > Traffic Flow > IPFIX**; it is on by
default). Before 1.0.32 and 1.1.0-rc.4, a router whose WAN address is itself private (behind
an ISP modem or CGNAT) had its downloads counted here instead (Discussion #486).

Clicking an application in **Traffic by Application**, on the chart or its list, opens the
clients behind it over the same range: each one's download, upload and share of that
application's traffic, busiest first, up to 50 (from [@azizfayziev](https://github.com/azizfayziev)'s
#366). Selecting a client opens its page. The chart's folded **Other** slice is several
applications together, so it doesn't open a list; the applications in it do, from the list.

### Zooming in on a time

To look into a spike, drag across it on the **Network Traffic** or **Inbound Packets** chart
(from [@ronchan44](https://github.com/ronchan44)'s #463). The whole page then covers just that
window: the totals, both charts, Top Talkers, Traffic by Application and the clients behind an
application, Top Destinations and the names looked up. A bar at the top shows the window, and
**Back to** returns to the range you were on. Picking another range does the same.

The charts redraw in finer steps for the window, down to a minute, so you can drag again to
narrow it further. A window can be from a minute to 31 days long. A zoomed view doesn't
refresh, since a window in the past doesn't change.

Top Destinations and the names looked up are kept by the hour, so they cover every whole hour
the window touches: a window from 20:15 to 20:45 shows the 20:00 to 21:00 hour. The bar says
which hours when the window doesn't start and end on the hour.

### Where traffic goes

Each application's card has a second tab, **Where it goes**: the remote addresses that carried
it, busiest first (#366). Under Top Talkers, **Top Destinations** does the same for all of
the site's traffic; click one to see which clients used it. On a client's row, **Where to** lists
that client's destinations for the application, and a client's page has **Where it goes** under
its traffic.

Each address is named by the organisation that owns it (Google, Telegram, Cloudflare...), with
its country, AS number and reverse DNS name. Private, CGNAT and multicast addresses say so
instead. The names come from the [iptoasn.com](https://iptoasn.com) list (public domain): a copy
is built into each release, and a newer one is downloaded weekly unless **Settings → Dark Site
Mode** turns that off. An organisation is who owns the address, not always the service: a CDN
such as Cloudflare or Akamai carries many sites. The name the client actually looked up comes from
the sources under [Names for addresses](#names-for-addresses).

To keep it small, each client keeps its busiest 20 addresses per application in each minute,
counted by the hour; the rest are added together and shown as a total under the list. Only
traffic between a client and an address outside the network is counted.

Destinations start from when the manager began recording them, for a new install or right after
the upgrade that added them, so for a while a 24-hour view holds only the hours since. The list
then says when recording began, so the gap doesn't read as missing traffic.

### Names looked up (AdGuard Home and Pi-hole)

NetFlow carries addresses, not names. Add the servers that answer a site's DNS under
**Settings → DNS Query Log** (fleet admins; fleet operators see it read-only): AdGuard Home or Pi-hole (version 6 or later), with
the site whose clients use it, its web address and login. Add every one of them: two resolvers
sharing the load each see their own part of the lookups, and the counts add up. **Test** checks
the address and login first. MikroTik Manager then reads each query log every minute and keeps
how often each client looked up each name, per hour, and how many of those were blocked.

Then the **DNS** application has a **Names looked up** tab, each client's row under it shows
that client's lookups, and a client's page has **Names looked up**.

The servers see clients by address, so lookups are matched to clients through the addresses
MikroTik Manager knows for them in that site. A client behind another NAT, or using a different
resolver, isn't covered. Lookups the server makes itself (Pi-hole naming its clients) aren't
counted. Passwords are stored encrypted, and changing the address or turning off the
certificate check needs the password typed again, so a saved one is never sent to a server it
wasn't saved for. Pi-hole logs in with a password alone; with two-factor login on, use an app
password from Pi-hole's settings. The servers' own logs aren't copied, only the counts.

**AdGuard Home as a Home Assistant add-on** answers on its own port only once one is set:
**Settings → Add-ons → AdGuard Home → Configuration → Network → Web interface** (for example
3001), then restart the add-on. With the add-on's **ssl** option on, that port serves HTTPS and
needs the certificate files in `/ssl`; without them the add-on doesn't start at all, DNS
included, so turn **ssl** off (plain HTTP, for a manager on the same network) or add the
certificates first. The address is then `http://<Home Assistant address>:3001`, and the login is
a Home Assistant user: a separate one for the manager, without admin rights, is enough.

### Names for addresses

Destinations, [Firewall Logs](firewall-events.md) (with names on) and Sessions show the name
behind an address, from the best source there is:

1. **AdGuard Home's answers:** AdGuard logs the addresses each name answered with, so a
   destination gets the domain the client asked for (`www.youtube.com` rather than just Google).
   Pi-hole doesn't log answers.
2. **Routers' DNS caches:** a router that answers DNS for its network (**IP > DNS > Allow Remote
   Requests**) holds the names it resolved and their addresses. MikroTik Manager reads the cache
   of those routers every fast poll and names each address by the name that was asked, following
   CNAMEs back (`www.netflix.com`, not `ftl-www.netflix.com`). This covers Pi-hole, or any
   resolver that forwards to the router, but isn't per client. Switch it off under **Settings →
   Polling → Collectors**.
3. **Reverse DNS** from the manager's own resolver, which for a CDN often names the server
   rather than the site.

A shared address (a CDN serving many sites) can carry several names; the most recent are shown.
Names are kept for the days set for DNS lookups under **Settings → General → Data Retention**.

With a site selected, every view shows that site's traffic only, and accounts limited to
particular sites see only theirs. **Flow Sources & Data Health** lists that site's exporting
devices too; its packet and flow counts are the collector's own and cover every site.
Unidentified exporters and refused sources belong to no site, so they're listed in the
all-sites view only. Traffic recorded before 0.24.47 has no site, so on a
multi-site install it appears in the all-sites view only. On a single-site install, or any
selection that includes every device, nothing is filtered and all of it shows (0.24.48;
0.24.47 hid it, and its site filter also made long ranges slow enough to time out).

Application classification is by port and protocol. It identifies what a flow *looks* like, not
what it is: anything on 443 reads as HTTPS whether or not it is a browser.

Ports the built-in list doesn't know count as **Other TCP** or **Other UDP**. The port names
added under **Settings → Firewall Logs** ([Port names](firewall-events.md#application-and-row-colours))
name those too: add `udp 1198 OpenVPN` and a VPN on that port becomes an application of its own,
in the chart, its clients and Where it goes, and its sessions read the right way round. A saved
name never renames a port the built-in list already names (443 stays HTTPS), so the categories
and their history don't change. New flows take a change within a minute; traffic already
recorded keeps the name it had.

Each chart remembers the time range you last picked, in this browser, rather than going back to
its default (#331). That goes for the charts on device, client and port pages too.

## Retention

Four settings, under **Settings → General → Data Retention**:

| Setting | Default | Covers |
|---|---|---|
| `netflow_retention_days` | 30 | Per-client time series (one-minute detail) |
| `netflow_daily_retention_days` | 365 | Daily per-client rollups |
| `retention_destinations_days` | 7 | Where traffic goes: per client, application and remote address, by hour |
| `retention_dns_days` | 7 | Lookup counts and answers from AdGuard Home and Pi-hole, and names from routers' DNS caches |

Flow records are the bulky ones; the daily rollups are small and are what the longer ranges are
drawn from. Raising the first is the expensive change.

## Proxy usage

If a router runs a proxy in a RouterOS container (3proxy, for example) that writes its access
log as JSON to the device log, the dashboard shows a **Proxy Usage** card. It ranks the busiest
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

The 24h, 7d and 30d rankings read an hourly rollup (`proxy_usage_hourly`, one row per hour,
device, proxy, port, client/user/destination and peer) that is updated as logs arrive, so
they stay fast however many connections are stored; **1h** reads the stored connections and
is exact to the minute. The rollup starts at the hour containing *now minus the range*, so
a range can reach up to an hour further back. It is built from the stored connections in the
background after the first start following an update, so startup is not held up (until it
finishes, the card reads the stored connections directly; the instance list is filled the
same way), and the last 48 hours are recomputed once a day to repair any drift. To go back to reading the stored connections,
set the app setting `proxy_usage_rollup` to `false`.

## If no data appears

1. Is the collector enabled? `netflow_enabled` in **Settings**.
2. Is UDP 2055 reachable from the device? The platform must be reachable *from* the router,
   which is not the same direction as the API connection.
3. Does the exporter match a known device? If flows arrive from an address the platform cannot
   match, they are refused unless **Accept flows from unidentified exporters** is on, and
   always from a public address. The NetFlow page lists refused sources and why.
