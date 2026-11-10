# Devices

The device list is the front door to everything else. This page covers getting devices in,
what each tab of a device does, and the parts that write to hardware.

## Adding devices

Use **Wireless Systems** for outdoor PTP/PtMP bridges, antennas and CPE. It has a
dedicated device filter and an **Antenna aligner** tab for watching both ends of
a link. Existing devices can be reclassified in Edit Device. See the
[antenna aligner guide](antenna-aligner.md).

**Devices → Discover** finds MikroTik hardware your managed devices can already see, over
LLDP, CDP and MNDP. Each discovered device offers one button, **Adopt Device**, and the
platform decides what that means — a factory-default unit is configured first, an already
configured one is simply registered. See [Adopting devices](adoption.md).

**+ Add Device** is the manual route when discovery cannot see it: address, credentials, and
optionally a [credential preset](#device-credentials) so the same username and password are not
retyped per device.

**Site** chooses the [site](sites.md) it joins: the one in view to begin with, or with a group in
view, that group's first site. A fleet-wide account can pick **New site…** to make one on the
spot, with a group (customer) for it, existing or new (#306). An install with one site shows
**Add it to a new site…** instead. A site made this way stays if the device then can't be added;
adding again with the same name finds it.

The address can be a LAN IP, a public IP, an IPv6 address, or a hostname (a local DNS name, or
a router's own `/ip cloud` DDNS name). Pasting a full URL like `https://203.0.113.5:8729/`
works too — the port is pulled out into the API Port field automatically. The same goes for an
address with a port sent through the API: it is used as the API port, and refused if a
different port is also given.

Leave **API Port** blank and the manager tries **API-SSL (8729) first**, falling back to the
plain API (8728) only if API-SSL isn't available (turned off, firewalled, or without a
certificate). If API-SSL answers but refuses the login, or presents a different certificate from
the one pinned, the manager stops there rather than trying the plain API. Before 1.0.1 both were
tried at once, which sent the password unencrypted even when API-SSL worked. A port you enter, or one in the credential preset, is used as
given. The plain API sends the login unencrypted on every poll, so a device that ended up on
8728 is listed on the [Security page](security.md#encrypted-management-api-ssl), where it
can be switched over. Choosing 8728 for a public address still shows a warning.

When you enter a port, an **API-SSL (encrypted)** box appears under it. It is ticked for 8729
and clear for any other port. Tick it when api-ssl runs on another port: a port forwarded
through NAT to reach several devices behind one address, say, or a network where 8729 is
blocked (#257). The box is in Edit Device too. Before 0.46.0, any port other than 8729 was
taken to be the plain API, and the device logged TLS errors. Ports outside 1–65535 are
refused.

### Devices without the API enabled (SSH only)

Many fleets start with the RouterOS API services (`api`, `api-ssl`) turned off. Tick **The API
isn't enabled on this device yet** in Add Device, or put `yes` in the `ssh_only` column of a
[CSV import](#importing-from-csv) (#174).

The manager tries the API briefly first, and if it answers, the device is added normally. If
it doesn't, the manager logs in over SSH instead. That reads the device's identity, model,
RouterOS version and serial number (the serial still catches duplicates), and pins its SSH host
key. The same login is used for SSH now and tried on the API later. A credential preset works
too: its SSH login is used, or its API login when it has no SSH one.

The device is listed as **SSH ONLY** in the API column. Until the API is on:

- **These work:** bulk commands, command templates, the terminal, backups and config history.
  The manager checks over SSH every minute that the device is up. An outage alerts as usual,
  and the name, version and model stay current.
- **These wait for the API:** live status and graphs, clients, ports, VLANs and the other device
  tabs, firmware upgrades, and Change Guard. The device page shows only Overview and Config
  History, with a note explaining why.

To turn the API on, run a bulk command or template on these devices with **Change Guard
off**, since Change Guard needs the API itself. For example:

```
/ip service enable api-ssl
```

You can also create a separate user for the manager at the same time. If you do, set it as the
device's API login in Edit Device.

The manager tries the API every minute, or every 15 minutes after a refused login, so a wrong
password doesn't fill the router's log. Once the API answers, the device becomes an ordinary
one: API-SSL is preferred, its certificate is pinned, a full sync starts, and an event is
logged. **Check API** on the device page tries straight away and says why it failed, if it did.

### IPv6 addresses

Enter an IPv6 address with or without brackets: `2001:db8::1` and `[2001:db8::1]` both work,
and `[2001:db8::1]:8729` puts 8729 in the API Port field.

Reaching IPv6 devices is **off by default**, because it changes how Docker sets up the
host's networking. Turn it on only if you have devices you can reach only over IPv6.

**Before you turn it on**, check the host:

- **It has IPv6 itself.** If `curl -6 https://ipv6.google.com` fails on the host, the
  manager can't reach IPv6 devices either.
- **Docker 27 or later.** Check with `docker version`.
- **`accept_ra=2` on its network interface.** Docker enables IPv6 forwarding when it creates
  an IPv6 network, and most Linux distributions then stop accepting router advertisements.
  A host that gets its IPv6 address and default route automatically can lose its own IPv6
  connectivity. Setting `accept_ra` to 2 keeps it, for example for `eth0`:

  ```bash
  echo 'net.ipv6.conf.eth0.accept_ra = 2' | sudo tee /etc/sysctl.d/99-docker-ipv6.conf
  sudo sysctl --system
  ```

  Hosts with a static IPv6 address and gateway don't need this.

**To turn it on**, add this line to `.env` next to your compose file:

```bash
ENABLE_IPV6=true
```

then recreate the stack. Your data is kept, and the manager is down for about a minute:

```bash
docker compose down
docker compose up -d
```

With the pre-built images, add `-f docker-compose.ghcr.yml` to both commands.

To turn it off, remove the line and run the same two commands.

The web UI (nginx) and the backend listen on both IPv4 and IPv6 inside their containers
whenever the host's kernel has IPv6, whether or not this setting is on. With it on, they
accept IPv6 connections directly, including from a reverse proxy of your own. On a host
booted with IPv6 disabled they listen on IPv4 only.

Use `down` then `up` rather than just `up -d`. Docker has to rebuild the network when this
setting changes. Recent Compose versions do that on a plain `up -d`, but older ones can keep
the old network and not apply the change. `down` then `up` works on all of them.

IPv4 devices work the same either way.

!!! note "Reachable over a VPN but not over its public IP?"
    RouterOS's own `IP → Services` list restricts each service (`api`, `api-ssl`) by an
    **"Available From"** address list. It accepts the TCP connection from anywhere, then
    silently drops it mid-login if the source isn't on that list — which shows up here as
    "The device closed the connection during login," not a normal refused/timed-out error.
    If a device connects fine over WireGuard (or another VPN) but not from its public IP,
    check that field: either add the reachable range, or leave it restricted and keep using
    the VPN, which is the safer choice for internet-facing management anyway.

**Try All** runs a bulk add across every discovered device as a server-side job. It survives a
closed browser tab and reports progress and failures per device.

### Importing from CSV

**Import CSV** on the Devices page adds up to 500 devices from a spreadsheet.

1. In the import dialog, click **Download template**.
2. Open it in Excel or Google Sheets. It has one column per field and a few example rows.
3. Replace the example rows with your devices, one per row, and save as CSV.
4. Choose the file in the same dialog.

| Column | Needed | What to put in it |
|---|---|---|
| `ip_address` | Required | The device's IP address or hostname |
| `name` | Optional | What to call it. Blank uses the address |
| `type` | Optional | `router`, `switch`, `ap`, `wisp` or `other`. Blank means router |
| `preset` | Login | The name of a saved [credential preset](#device-credentials) |
| `username`, `password` | Login | The RouterOS login, if not using a preset |
| `port` | Optional | The API port. Blank tries API-SSL (8729), then 8728 |
| `api_ssl` | Optional | `yes` when `port` runs api-ssl on a port other than 8729, `no` for the plain API on 8729 |
| `ssh_username`, `ssh_password` | Optional | Only if SSH uses a different login. Blank uses the one above |
| `ssh_only` | Optional | `yes` when the API isn't enabled yet; see [SSH only](#devices-without-the-api-enabled-ssh-only) |
| `tags` | Optional | Existing tags. Create them under Settings → Tags first |
| `site` | Optional | The [site](sites.md) it joins, by name. One that doesn't exist yet is made (fleet-wide accounts). Blank joins the site in view |
| `site_group` | Optional | The [group](sites.md#groups) (customer) a new site goes in, made if it's new. Also read as `customer` or `client` |
| `notes` | Optional | Anything you like |

A `group` column is read as tags, as it always was; the dialog says so. The group of a site
that already exists is left as it is. The dialog lists the sites an import will make.

For several tags on one device, separate them with a vertical bar: `branch|lab`.

Each device needs a login: a preset, or a username and password. An `ssh_only` row can use
`ssh_username` and `ssh_password` instead. `port` and `ssh_port` can
be added as extra columns if yours aren't the defaults (8728 and 22).

The file is checked before anything is sent. Each row shows as ready, skipped or a problem,
with the reason. Skipped rows are:

- devices that are already managed
- the template's example rows, if they were left in (they use `192.0.2.x`, an address range
  reserved for examples)

Columns can be separated by commas, semicolons (which Excel uses in many countries) or tabs.
Unknown columns are listed and ignored.

The import runs as the same server-side job as **Try All**, so the tab can be closed.

!!! note "Credentials are stored encrypted"
    API passwords are encrypted at rest with the key from `ENCRYPTION_KEY`. Losing that key
    means re-entering every device password; see [Configuration](configuration.md).

## Device credentials

**Operations → Credentials** holds credential presets: a RouterOS username and password (and
optionally SSH login) saved once and picked when adding devices. Passwords are encrypted and
never sent back to the browser.

A preset is either **fleet-wide** or belongs to **one site**:

- Fleet admins manage every preset. A site admin manages the presets of the sites they
  administer.
- A site's preset is only offered, and only accepted, for devices in that site. The Add
  Device, CSV import and Try All dialogs list fleet-wide presets and those of the site the
  new device joins (the selected site, or the default site when none is).
- **Operator access** off makes a preset usable by admins only: fleet admins for fleet-wide
  presets, and that site's admins for a site's preset.
- Names are unique within a site, so CSV import matches a preset name against that site's
  presets and the fleet-wide ones.
- With a site or group chosen in the site selector, the list shows its presets and the
  fleet-wide ones, and says how many it hides. A new preset starts in the chosen site.

Before 0.30.0 presets were fleet-wide only and lived under Settings.

**Edit Device** offers the same presets (#259): picking one replaces the device's login, SSH login
included, with the preset's. The manager logs in with it first, and nothing is saved if that
fails.

**Changing a device's address.** Anyone but a fleet admin has to enter the device's API password
(or pick a preset) to move it to another address, and the saved passwords stay behind: after the
move the device has only the passwords entered with it, and SSH uses the API password unless an
SSH password was entered too. So moving a device can't send its saved passwords to a host
someone else runs. A fleet admin may move a device with its saved passwords. Before 1.0.1 any API
password was accepted and the saved SSH password went to the new address.

### Changing the login for many devices

Select devices in the device list and choose **Change login…** in the bar above it (#259). Pick a
preset, or type a username and password (optionally an SSH login too). This changes the login the
manager uses, not anything on the devices. Each device is logged in to with the new login first,
and keeps its current one if that fails; the result lists every device and why any were left
alone. Presets are offered only when every selected device's site can use them.

A typical use: devices added with a shared admin login, then moved to a dedicated manager user
once that user exists on them.

### The RouterOS login the manager uses

Give the manager a RouterOS user in the built-in **`full`** group. It reads and changes
configuration over the API, takes backups, upgrades firmware and runs bulk commands, and
between them those need most of RouterOS's permissions.

[Change Guard](change-guard.md) in particular needs the **`policy`** permission. Before every
protected change it saves a restore point with `/system backup save`, which RouterOS refuses
without `policy`, and the revert it schedules runs with the permissions of the user that
created it. RouterOS 7's built-in **`write`** group has every permission except `policy` and
`ftp`, so with a `write` user the restore point fails with "not enough permissions" and:

- protected changes are applied without auto-revert, and the result says so: *Applied without
  auto-revert protection: Could not arm auto-revert on this device (not enough permissions
  (9))*;
- changes that could cut the manager off are refused rather than applied unprotected.

A user in the `read` group can be monitored but not changed.

To check a device, run `/user print` and look at the group of the user the manager logs in as.
To fix it, `/user set [find name=<user>] group=full`. If you'd rather use a group of your own,
Change Guard needs `read`, `write`, `test`, `api` and `policy` (tested on RouterOS 7.24.5:
saving the restore point, and a revert firing and restoring it).

If the login has to stay in the `write` group, set **Settings → General → Change Guard → How it
reverts** to **Targeted, no reboot** ([script mode](change-guard.md#settings)): it needs no
`policy` permission and never reboots.
Changes script mode doesn't cover still need a binary restore point, so those stay unprotected
for a `write` user.

## The device list

Filter by status, type, tag, rack or location, and sort by any column. The search box matches
name, address, serial and MAC. **All** clears the status and the AP/SW/RTR type filter; clicking
the selected type again also clears it.

Two columns show how the manager reaches each device, and each has a filter:

- **API**: **SSL** for API-SSL (8729, or another port set to API-SSL), **PLAIN** for the
  unencrypted API (8728). See
  [Encrypted management](security.md#encrypted-management-api-ssl).
- **Login**: **PW** when the manager has only the password, **PW+KEY** when it also has a
  verified [SSH key](ssh-keys.md) (SSH then uses the key), **KEY** for a key without a password.

The list updates by itself as polls finish; there is no need to reload.

The power icon on a device's row reboots it, after a confirmation (#292). It isn't offered
for a device added over SSH only.

**Columns** at the end of the filter bar shows or hides columns, apart from the status dot,
the name and the action buttons (#283). Drag a column header's right edge to make it wider or
narrower, and double-click that edge to put it back. **Reset columns** restores the
defaults. The choice is remembered in your browser.

### Device names

A device's name follows its RouterOS identity (`/system identity`): rename a router on the
device, or from its Config tab here, and the new name shows up at the next poll.

A name you choose yourself is kept instead. That happens when you type a name in **Add
Device** that differs from the router's identity, or rename a device in **Edit Device**. The
name then stays put whatever the identity says, and Edit Device shows "Set manually". Click
**Use the router's identity** there to go back to following it.

When the two differ, the device's **System Information** shows both: **Name** (in the
manager) and **Identity on the router**. **Use this name** beside the identity switches to it
straight away and follows it from then on (#253).

A device added without a name (from a CSV row with no `name`, or **Try All**) starts out named
after its address, and switches to its identity at the first poll.

Tags appear beside the device name. They are the only grouping that crosses both sites and
device types — see [Bulk commands](commands.md) for selecting a fleet by tag.

To tag many devices at once, tick them in the list (the box in the header selects every device
the current filters show), then choose **Add tag…** or **Remove tag…** in the bar that appears.
Tags can also be picked when adding a device, and set per row in a [CSV import](#importing-from-csv).
Tags themselves are created under **Settings → Tags**.

## Status colours

| Colour | Meaning |
|---|---|
| Green | Online |
| Amber | **Degraded**: online, but a power supply or fan reports a failure, or a temperature is at or over the limit |
| Red | Offline |
| Grey | Unknown, or offline when the device is marked as expected to drop out |

### Hardware health

The manager reads `/system/health` every few minutes, and on **Sync**. A device is degraded
when:

- a power supply state (`psu1-state`, `psu2-state`, …) is anything other than `ok`
- `fan-state` is anything other than `ok` (a fan speed of 0 on its own is not a failure, as
  some models stop their fans when cool)
- any temperature reaches the limit, 85 °C by default, set under **Settings → Alerting**

Voltages are not judged, since normal ranges depend on the model and power source.

The device's Overview tab lists the problem. If it is deliberate, for example a dual-supply
switch fed from one supply, click **Ignore on this device** and that reading no longer counts.
Ignored readings stay listed so they aren't forgotten.

Becoming degraded, and recovering, raise the `device_degraded` and `device_health_restored`
alerts, and are written to the device's event log.

### Devices that go offline on purpose

On a device's Overview tab, tick **Expected to go offline at times** for solar or battery
powered devices, or anything else that drops out normally. Such a device:

- shows grey rather than red when offline, and isn't counted as unreachable on the dashboard
- sends no offline alert when it drops out
- alerts once if it stays offline longer than its limit (24 hours by default; 0 means never),
  and then sends a recovery alert when it returns

### Availability, uptime and reboots

Two figures sound alike and aren't (#326):

- **Availability** (the dashboard's *Availability 30d*, and the device page's 30-day card) is the
  share of the last 30 days the manager could reach the device.
- **Uptime** (on the device page) is how long since the device last booted, with the boot time
  under it.

A reboot that's over before the next poll never shows as an outage, so availability alone misses
it. The manager also watches each device's uptime counter: when the boot time it implies moves
later, the device rebooted since the last look, however quickly. Those are counted as **Reboots**
on the device page (hover for the last one) and next to *Availability 30d* on the dashboard.
Counting starts from the upgrade to 0.73.0.

### Resetting a device's outage count

The dashboard lists a device that went offline several times in the last week as *had N
outages this week*. Once you've dealt with the cause, or the drops were expected (an LTE link
reconnecting, say), **Reset count** on that item counts the device's outages from now on, so
the item goes away until it drops again (#85). Only the count is reset: the availability
history, uptime figures and reports keep every outage. **Snooze** instead hides the item for
24 hours.

## Device tabs

| Tab | What it is for |
|---|---|
| **Overview** | Status, uptime, model, firmware, resource graphs, location |
| **Ports** | The switch faceplate, per-port configuration, bonds, VLAN membership |
| **Bridges** | Every bridge, its ports, VLAN filtering and spanning tree; create, rename, edit, delete |
| **VLANs** | The bridge VLAN table, copying VLANs between switches, and VLAN interfaces (`/interface vlan`) with their parent and addresses, which you can add, edit and remove |
| **Radios** | Wireless interfaces, SSIDs, channels, connected clients |
| **Firewall** | Filter and NAT rules and address lists, for IPv4 and IPv6 (the **IPv4** / **IPv6** switch at the top), with reordering and counters, and [Quick rules](#quick-firewall-rules). IPv6 NAT needs RouterOS 7 |
| **Routing** | IPv4 routes, IPv6 routes (read-only), routing rules, OSPF, BGP, routing tables and filters |
| **Queues** | Traffic shaping |
| **Connections** | The live connection tracking table: the total, and the first 200, 500 or 2,000 connections, filtered by protocol on the router. A busy router isn't asked for its whole table, and refreshing is on request unless you turn on auto-refresh (#300). Every column sorts, ports included (before 0.71.0, RouterOS 7.24's ports were missing) |
| **Graphs** | History for this device, one range for every chart (1h to 30d), with a hover cursor shared across them. See [Device graphs](#device-graphs) |
| **Hardware** | Health sensors, PoE, SFP module detail, and CPU and memory history: 5-minute averages as lines, with a light band up to the highest reading in each 5 minutes, so a short burst to 100% doesn't hide in the average (#402). Memory's band only shows where the peak is more than two points above the average |
| **LTE** | Signal, carrier, bands and the data cap — see [Cellular](cellular.md) |
| **Security** | Baseline hardening checks and the posture score |
| **Config** | System settings, certificates, SSH keys, clock |
| **Config History** | Snapshots of `/export`, diffs, and rollback ([what rollback can do](backups.md#restoring)) |
| **Tools** | Ping, traceroute, IP scan, Wake-on-LAN, packet capture, bandwidth test |

Tabs appear only where they apply: a switch has no Radios tab, a device without a modem has no
LTE tab.

### Editing settings

A save changes only what you changed. The Config tab, radio settings and SSIDs send just the
fields you edited, so renaming a device no longer resets its clock to the time the form was
opened, and editing an SSID no longer pins a radio set to choose its channel automatically.
The Config tab edits the first two NTP servers and keeps any others the device has.

Clearing a field clears it on the device. Emptying a firewall or NAT rule's address, port or
comment, a queue's comment, or a WireGuard peer's endpoint removes that setting from the item.
Switching a rule's source or destination between an address and an address list removes the
other one. Before 0.24.39 an emptied field was left out of the save and the device kept the old
value, while the page showed it gone.

On a switch port, changing flow control in one direction leaves the other direction alone.

On the Firewall tab, **Address Lists** entries can be turned off and on with the power button
without removing them, as in WinBox. A disabled entry stays in its list, struck through, and no
longer matches. Change Guard checks it like a removal, so disabling the entry that lets the
manager in is caught before it is applied.

### IP addresses

The **Config** tab's **IP Addresses** card lists the device's IPv4 addresses. Add one with the
form below the list, remove one with the bin, or click the pencil to edit it in place: the
address and prefix, the interface, the comment, and whether it's enabled (#285). Only the
fields you change are sent. Dynamic addresses (from a DHCP client, say) can't be edited.

Every change runs through [Change Guard](change-guard.md). Changing, disabling or moving the
address the manager connects to is predicted as a lockout and stops for confirmation, and
moving it to another interface counts too, since the manager reaches it through the old one.

### Bandwidth queues and FastTrack

The **Queues** tab, and **Limit this client** on a client's page, create a RouterOS simple
queue. FastTracked connections skip simple queues, so on a device with an enabled FastTrack
rule a queue only limits traffic that isn't FastTracked. When the device has one, the queue
dialog says so (#280). To limit a target, exclude it from FastTrack (for example, an accept rule
for it above the FastTrack rule) or turn FastTrack off.

## Device graphs

The **Graphs** tab (#402) shows a device's history in sections, each with a one-line summary in its
header. Click a header to fold a section, or use the chips at the top to hide ones you don't need;
both are remembered in your browser. Sections only appear where the device has the data: a switch
without connection tracking has no Connections section, a single-core device no per-core chart.

| Section | What it shows |
|---|---|
| **CPU** | Load as 5-minute (or longer) averages, with a light band up to the highest reading in each window, and each core on its own when there are several: one core pinned at 100% hardly moves the overall load |
| **Memory** | Memory used, with the peak band where it differs |
| **Connections** | Active connections (with the peak, and the share of the table's maximum), connections by protocol and NAT translations (src-nat, dst-nat), and new connections per second where the router counts them (below). Only where connection tracking is running |
| **Firewall drops** | Packets per second dropped by drop and reject rules, per chain (input, forward, and raw), and the rules that dropped the most in the range |
| **Interfaces** | The four busiest ports and bonds in the range (or the ones you pick, up to eight), in and out on one chart each, their utilisation of the link speed, and packets per second. The same traffic isn't picked twice: a bond is picked rather than its members, a PPPoE client rather than the port under it, and VLAN and VRRP interfaces are left out (their traffic is counted on the port or bond they ride on). A bond's speed is its running members' together and a PPPoE client's is its port's; an interface whose speed isn't known is named under the utilisation chart. The picker lists ports in number order (ether1, ether2 … ether48, then SFP and QSFP ports, bonds and VLANs) |
| **Temperature** | Each temperature sensor the device reports |

A series that started inside the range, such as one new in this release or a device added
recently, says **Recorded since** when, so an empty start isn't read as nothing happening.

What it costs the router: per-core load, the connection-tracking totals and the rule counters ride
along with the fast poll's existing read. The protocol and NAT split counts the connection table on
the router, so it runs with the slow poll, and not at all on a table of more than 200,000
connections.

**New connections per second.** RouterOS has no counter for it. Add a rule that counts them, and
the Connections section draws it:

```
/ip firewall mangle add chain=prerouting connection-state=new action=passthrough comment=mtm:new-conn
```

## Quick firewall rules

**Quick rules** on the Firewall tab adds the rules nearly every router needs, close to MikroTik's
own default configuration (#330). Pick a preset:

| Preset | Adds |
|---|---|
| **Input basics** | Accept established, related and untracked; drop invalid; accept ping (ICMP, or ICMPv6 with traceroute and DHCPv6 prefix delegation for IPv6); accept to the loopback (IPv4, for CAPsMAN); then drop everything else not coming from the LAN |
| **Management access** (IPv4) | An address list (`mtm-management` unless you name another) holding the manager's own address and any you add, an accept for WinBox, SSH, the API and WebFig from that list, and a drop for those ports from anywhere else. Only services that are enabled are covered, on their configured ports |
| **Forward basics** | For the traffic passing through: accept established, related and untracked; drop invalid; drop new connections from the WAN that aren't port forwards (IPv6: drop everything not from the LAN). **FastTrack** is optional; with it, IPsec traffic is accepted first so it isn't FastTracked |
| **Masquerade** (IPv4) | NAT out of the WAN, for a WAN address that changes |
| **Brute-force protection** (IPv4) | Bans an address that keeps opening new connections to SSH, WinBox, FTP, Telnet or a VPN server. See [Brute-force protection](#brute-force-protection) |

You choose what the LAN and WAN are: an interface list (the form starts on `LAN` and `WAN` when the
device has them, as defconf makes) or a single interface. Before anything is added, the dialog shows
each rule and where it goes:

- **Accepts and the invalid drop go to the top** of the table, so they work whatever else is there.
- **Catch-all drops go to the end**, so the accepts you already have keep working. The management
  drop is the exception: it goes to the top, right after its accept, since that's its purpose.
- **A rule that's already there is skipped**: one with the same chain, action and matchers, enabled,
  whatever its comment.

Every rule is commented `mtm quick: …`. **Review changes** shows the commands, and the preset is
added in one [Change Guard](change-guard.md) change: the whole preset is checked against the
manager's own connection first, so a LAN that doesn't include the interface management arrives on
is caught as a lockout before anything is added. For IPv6 the usual auto-revert applies.

The manager adds its own address to the management list when it can see it on the device: from
connection tracking, or, where that isn't running (most switches), from its own API session in
**System > Users > Active**. When neither shows it, the form asks for the addresses that manage the
router, the manager's included.

### Brute-force protection

RouterOS can't see a failed login, so this preset counts new connections instead, the usual way on
MikroTik (#405). Each new connection to a protected port moves the source address through three
one-minute stages (`mtm-bf-1` to `mtm-bf-3`); the fourth within those minutes puts it on
`mtm-banned` for the ban time you choose (1 hour, 1 day or 1 week), and everything from that list is
dropped, not only the protected ports.

What can be protected:

| Choice | Ports |
|---|---|
| SSH, WinBox, FTP, Telnet | The service's configured port, when it's enabled |
| L2TP/IPsec | UDP 500, 4500 and 1701 |
| PPTP | TCP 1723 |
| OpenVPN | The OpenVPN server's port (1194 unless changed), TCP and UDP |
| SSTP | TCP 443. Off unless you tick it: WebFig HTTPS and the [reverse proxy](certificates.md#reverse-proxy) share the port, so busy web clients could be counted too |

The form starts with the enabled services and the VPN servers that are on. Addresses under **Never
ban**, and the manager's own address, go in `mtm-bf-exempt` and are never counted: the manager
opens SSH sessions for backups and the terminal, and a ban would drop its API connection too. If the
manager can't see its own address on the device, the form won't add the rules until you enter it
under Never ban.

The rules: a drop for `mtm-banned` and a jump for new connections to the protected ports at the top
of the input chain, and the counting rules in their own `mtm-bruteforce` chain. A ban rule already
there is kept as it is; to change its ban time, edit its `address-list-timeout` on the Firewall tab.

Banned addresses show in a **Banned** card at the top of the Firewall tab, with the time left.
**Unban** removes the address from `mtm-banned`; **Never ban** also adds it to `mtm-bf-exempt`. An
unbanned address that keeps connecting is banned again. The **Security** page lists what's banned
across the fleet, as of each device's last slow poll.

The Security tab's **No input-chain firewall rule** finding (IPv4 or IPv6) has an **Add input rules**
button that opens Quick rules on Input basics.

## Zones

**Zones** on the Firewall tab (IPv4) builds the whole filter table from a matrix, the way
zone-based firewalls work (#369). A zone is an interface list (`LAN`, `WAN`, `DMZ`…). For each pair
of zones, and from each zone to the router itself, you choose **Deny**, **Allow everything**, or
**Only these services**:

| To | Services to pick from |
|---|---|
| Another zone | Ping, Web (80, 443), DNS, SSH, Remote Desktop, File sharing (SMB), NTP |
| The router | Ping, WinBox, SSH, WebFig, API, DNS, DHCP, NTP, SNMP. WinBox, SSH, WebFig and the API use the ports set in **IP > Services** |

Any pair can also have up to 10 rules of your own, under **+ Custom rule**: TCP or UDP ports
(`8080`, `5000-5010,6000`), a source address, a destination address, or any of them together. An
address can be one address, a subnet (`10.0.0.0/24`) or a range (`10.0.0.10-10.0.0.20`). With an
address the ports are optional, and the protocol can be **Any**. So WAN to DMZ can let one partner's
address reach one server on 443 and nothing else, and LAN to the router can take SSH from the admin
subnet only.

A custom rule can also be **ICMP**, with an optional type (`8` for echo request) or type and code
(`3:4`); left empty it allows every ICMP type. Or it can be any other IP protocol by number under
**Protocol #**: `89` for OSPF, `47` for GRE, `112` for VRRP. RouterOS shows a protocol it has a name
for by that name, so the rule appears on the device as `protocol=ospf`. Neither takes ports, and
both can take addresses.

A source or destination can also be a **hostname**, such as `smtp.office365.com`. The router looks
it up with its own DNS (**IP > DNS**) and keeps an address list of every address it resolves to,
updated as the name's records change, so a service behind several changing addresses stays
matched. The manager keeps one list per name, called `mtm-zone-<name>`, holding a single entry
commented `mtm zone host`, and removes it once no rule uses the name. If the router can't
resolve a name, rules using it match nothing.

Traffic between interfaces of the same zone is allowed unless you turn it off for that zone.

### Turning zones on

Zones replace the whole IPv4 filter table, so they can be turned on only when the table is empty or
holds just MikroTik's default rules (comments starting `defconf`). Click **Set up zones**: the form
starts from the device's interface lists. When it has `LAN` and `WAN`, the cells start like the
defaults: LAN reaches everything, WAN only gets ping to the router.

Add interfaces to a zone, or a new zone (which creates an interface list on the device). Put routed
interfaces in zones: a bridge, a VLAN interface, the WAN port. The firewall sees routed traffic on
the bridge, not on its ports, so a zone made of bridge ports gets a warning. So does an interface
with an address that's in no zone, since nothing reaches the router or another zone through it.

As you change the matrix, the form shows what applying will do: the lists and members it changes,
and how many rules it adds, removes and keeps. **Show the rules** lists them all.

### The rules

Every rule is commented `mtm zone: …`. In order:

- **Input** (traffic to the router): accept established, related and untracked; drop invalid;
  accept to the loopback (for CAPsMAN); accept the manager's own address, when MTM can see it on
  the device; a jump per zone that can reach the router, to `<zone>-to-router`; then drop the rest.
- **Forward** (traffic between zones): FastTrack established and related (optional, with hardware
  offload on RouterOS 7); accept established, related and untracked; drop invalid; an accept per
  zone for same-zone traffic; a jump per open pair, to `<from>-to-<to>`; then drop the rest.
- **One chain per open pair**, holding its accepts and ending in a return.

The manager's rule lets its address reach everything on the router by default. To narrow it,
set **The manager can reach** to **only the API, API-SSL and SSH ports**. Those are all the
manager connects to: the API for everything it reads and changes, and SSH for the terminal,
SSH-only devices and keys. It doesn't ping devices or poll them over SNMP. The ports are the ones
set in **IP > Services**, so an SSH server moved to 2222 is the port allowed. The choice only
appears when MTM can see its own address on the device.

The two final drops log by default with the prefixes `zone drop in` and `zone drop fwd`, tagged so
[Firewall Events](firewall-events.md#which-rule-logged-it) links each line to its rule. Untick **Log
what's dropped** to leave them quiet. The returns and the final drops aren't shown in the matrix.

Replies always get back: a connection allowed one way is tracked, and the stateful accepts let its
replies through. Port forwards (dstnat) are matched after the address is changed, so allow the
service from the outside zone to the zone the server is in.

### Applying

**Apply** runs as one [Change Guard](change-guard.md) change. The whole new table is checked
against the manager's own connection first, including the jumps into each zone's chain and any
interface moved between lists, so a matrix that would cut the manager off is caught before anything
is written. **Review changes** shows the commands.

Rules that are already right stay as they are, with their counters; the rest are added in place or
removed. New rules go in disabled and are turned on with the drops last, so no step along the way
drops anything the old table let through.

### While zones are on

Zones own the IPv4 filter table. The RouterOS rules that carry them out (one chain per zone,
with its jumps and returns) are folded away on the Firewall tab, so the tab reads as zones and
what each can reach. **Show RouterOS rules** opens them, with their counters, and the browser
remembers the choice; following a log line's rule link opens them too. They can't be edited,
moved or deleted there, and Quick rules other than masquerade are refused. NAT, address lists and
IPv6 are unchanged.

If the table is changed outside MTM (in WinBox, say), the Zones card says what differs, and
[Config Health](change-guard.md#config-health) reports **Firewall differs from its zones**.
**Apply** puts the rules back.

**Turn zones off** stops managing the table. Nothing on the device changes: the rules stay as
ordinary rules you can edit. Turning zones on again starts from the same matrix.

## Ports and the faceplate

The faceplate mirrors the physical front panel — copper staggered odd above even as the
hardware is, SFP cages and QSFP breakout lanes grouped separately. Bridges and bonds aren't on
the front panel, so they sit in a **Virtual** strip below it. A QSFP port that isn't broken out
is drawn as one box.

Some models have their layout built in, so the faceplate matches the panel without any setting:
CRS354-48P-4S+2Q+, CRS510-8XS-2XQ, CRS317-1G-16S+, CRS328-24P-4S+, CCR2216-1G-12XS-2XQ and
CRS518-16XS-2XQ (#288). Other models use the generic layout.

Ports are identified by RouterOS's **factory name**, not their display name, so renaming a port
to something useful does not move it into the wrong group or cost it its label or position.
Where a port has been renamed, the factory name is shown beneath it.

Negotiated link rate and SFP module details — type, connector, vendor part number — are read
from the device rather than guessed from the port's name, which also distinguishes an empty
cage from a copper port.

A port's **Comment** is its interface comment, or, where that's empty, the comment on its
bridge port (Bridge → Ports in WinBox), which is where many people put them (#290). Editing a
port's comment here sets the interface comment. The column is hidden when no port has a
comment.

Use **ports per row** in the faceplate header if the default does not suit your hardware;
it's remembered for each device in your browser, and a device you haven't set yet uses the last
choice you made. Next to it, **top row** says which ports are on top: `1 3 5` (most
models) or `2 4 6`, for models whose front panel has the even ports on top (#277). It appears
when the Ethernet ports sit in two rows, and is remembered per model in your browser. A choice you make there overrides the model's built-in Ethernet layout.

Selecting a port shows its throughput for the chosen range, and under it **Errors & drops**: how
many receive and transmit errors, drops and transmit-queue drops the port had in that range, with
a small chart of them when there were any, or "0 errors · 0 drops in this range" when there were
none (#402). They're kept apart from the throughput so a few
aren't flattened by gigabit traffic. Drops are counted from 1.1.0-beta.26 on.

### A port's MTU

A port's edit form takes its MTU, from 576 up to what the port's hardware takes. RouterOS calls
that `max-l2mtu`, and the field shows it ("up to 10218 on this port"). It varies by port: most
SFP+ and QSFP28 ports on CRS3xx and CRS5xx switches take 10218, while a CRS510's management port
(ether1) stops at 2028. RouterOS doesn't refuse a higher MTU; it keeps the most it can without
saying so. So the manager refuses one the port can't take, and reports it if the device keeps a
different value than asked.

The port's L2 MTU is raised with the MTU when it's too small, and is never lowered, so a port
raised for VLAN tags or jumbo frames keeps it. The MTU is only sent when you change it.

Jumbo frames switched between ports only need those ports' MTU raised. The bridge's own MTU
(see [Bridges](#bridges)) is only for the router's own traffic on the bridge.

### Power-cycling a PoE port

On a port that supplies PoE, **Power-cycle PoE** turns its power off for 5 seconds and back on,
which restarts the access point, camera or phone it powers (#291). It's in the selection bar
when that port is selected, and as a lightning icon on the port's row in the port table. If
management traffic reaches the device through that port, it asks first: the device being
powered may be carrying the manager's connection.

### Changing a port's VLAN

Selecting a port and setting it to **access** or **trunk** writes three things: the PVID, the
bridge VLAN membership, and frame admission (`frame-types` and `ingress-filtering`).

For a trunk, pick the native VLAN and tick the tagged VLANs. A trunk accepts both kinds of
frame: tagged frames for its tagged VLANs, and untagged frames, which join the native VLAN
(the PVID). So a device that doesn't use VLANs, such as a laptop or an unmanaged switch, works
on a trunk port and lands in the native VLAN. The native VLAN is greyed out in the tagged list
because it is carried untagged. The text box below the checkboxes holds the same list, for
copying between switches, and accepts ranges such as `10,20,100-110`. A VLAN typed there that
the switch does not have yet is created on the bridge when you save.

Tick **Tagged only** for a trunk that should drop untagged frames instead (`frame-types=admit-only-vlan-tagged`).
It then has no native VLAN. Before 1.0.11 every trunk was set this way, so a trunk saved by an
older version opens with **Tagged only** ticked. Untick it and save to let untagged devices use
the native VLAN.

Saving a trunk also takes the port out of any untagged VLAN other than its native one, so a
former access port stops sending its old VLAN untagged.

Unticking a VLAN removes the port from it. One exception: if the switch holds several VLANs
in one bridge VLAN entry (for example `vlan-ids=100-110`) and the port keeps some of them,
that entry is left alone and the editor tells you which VLANs are still tagged. Split the
entry on the VLANs tab to remove them.

An access port carries one VLAN, its PVID, untagged. Setting a port to access takes it out of
every other VLAN it was in, tagged or untagged, so a former trunk stops sending its VLANs. The
editor opens a port in the mode its frame admission says: a port that only admits untagged
frames shows as access, one that only admits tagged frames as a tagged-only trunk.

!!! warning "This is a guarded change"
    Moving the port that carries management traffic is the most common way to lock a MikroTik
    out of itself. Every VLAN change runs through [Change Guard](change-guard.md), which
    predicts lockout before applying and lets the device restore itself if contact is lost.

### Moving ports between bridges

Select one or more ports on the faceplate (shift-click for several) and choose **Move to
bridge** (#258). Pick an existing bridge, **New bridge…** to create one (RSTP, VLAN filtering
off), or **No bridge** to take the ports out, for a routed port with an address of its own. A
bond moves as one; its member ports, and ports a service such as CAPsMAN added to a bridge by
itself, can't be moved by hand.

A port's VLAN settings belong to its old bridge, so after the move its PVID is 1 and it admits
all frames, and the old bridge's VLAN table no longer lists it. Set its VLANs again in the new
bridge if it uses VLAN filtering.

If a port being moved into a bridge has an IP address or a DHCP client, the move stops and
says so: an address on a port stops working once the port is in a bridge, which is how a
router's WAN port gets cut off. You can still go ahead with **Move anyway**.

The **Bridge** column of the port table shows each port's bridge, marked **HW** when the
switch chip forwards its traffic and **CPU** when the CPU does. A MikroTik switch chip
hardware-switches one bridge, so ports in a second bridge are switched by the CPU: slower, and
CPU load grows with traffic. MikroTik documents CRS1xx and CRS2xx as able to offload several
bridges, but a CRS112 on RouterOS 7.24.5 didn't, so the move dialog warns on every model. The
result reads the device's own flag after the move (and waits a little longer for it where the
target bridge is already hardware switched), and the Bridge column shows the answer. To keep
networks apart on a switch, VLANs on one bridge keep hardware switching; on a router, a separate
bridge for a guest or IoT network is common, and usually carries little traffic.

To delete a bridge, double-click it on the faceplate and choose **Delete bridge**. Only a bridge
with no ports, addresses, VLAN interfaces or DHCP server can be deleted.

Moving ports and deleting bridges run through [Change Guard](change-guard.md): moving the port
management traffic arrives on out of its bridge is predicted as a lockout before anything is
applied.

### VLANs in the switch chip's table

Older switch chips, such as the Atheros 8327 in a hAP ac² and the chips in the RB951 and hEX
lite, can't hardware-switch a bridge with VLAN filtering on: turning it on moves that bridge's
switching to the CPU. On these chips VLANs belong in the switch chip's own table (**Switch,
VLAN** in WinBox), with each port's VLAN mode, VLAN header and default VLAN.

On such a device the **VLANs** tab shows a **Switch chip VLANs** card with that table and the
port settings (#278), and no longer suggests turning on bridge VLAN filtering or offers to add
bridge VLANs. You can edit it there:

- **Add switch VLAN** adds an entry: a VLAN ID and its member ports. Include the CPU port
  (`switch1-cpu`) for a VLAN the router itself needs to reach, such as one with a VLAN interface
  on it; it's ticked to start with.
- The pencil on an entry changes its ports or turns it on or off; the bin removes it.
- Each port's **VLAN mode**, **VLAN header** and **default VLAN** are set in the table below,
  with a save button that appears once you change a value. Hover a mode or header to see what
  it does. `secure` with `always-strip` and a default VLAN is a typical access port;
  `add-if-missing` a typical trunk.

Every change runs through [Change Guard](change-guard.md) with auto-revert required. The
lockout check can't model the switch chip, so it can't tell you in advance that a change is
safe; instead, if the device stops answering, it restores its previous configuration. These
changes use a binary restore point, so a revert also restarts the device. Where auto-revert
can't be armed (Change Guard turned off, or a login without the `policy` permission), the
change is refused rather than run unprotected. Chips that do VLAN
filtering in hardware on RouterOS 7 (CRS3xx and other Marvell switches, and the hEX's MT7621)
use bridge VLAN filtering as described above and don't show the card.

### VLAN interfaces

Routers often carry VLANs as VLAN interfaces (`/interface vlan`, **Interfaces, VLAN** in WinBox)
on a port, with no bridge VLAN table at all: the router-on-a-stick layout on a CCR, CHR or RB.
When a device has any, the **VLANs** tab lists them in a **VLAN interfaces** card (#309): VLAN
ID, name, parent, addresses (IPv4, and IPv6 other than link-local), MTU, state and comment.

The label next to the parent says what it is:

- **port**: a physical port, the usual router-on-a-stick layout
- **bridge, filtering**: a bridge with VLAN filtering; the VLAN interface is how the device
  itself joins that VLAN, and the bridge VLAN table above decides which ports carry it
- **bridge, no filtering**: a bridge without VLAN filtering; only the device itself sees the
  tag, nothing is enforced on the bridge's ports
- **bond**, or **Q-in-Q** for a VLAN stacked on another VLAN interface

The card is read live from the device each time the tab opens and every minute while it's open.

With write access you can add, edit and remove VLAN interfaces there. **Add VLAN interface**
takes a VLAN ID, the parent it's tagged on, a name (`vlan` and the ID if left blank), an MTU, a
comment, and optionally an IP address to put on it straight away. The pencil edits the same
settings except the address; change addresses under **Config**, **IP Addresses**. Every change
runs under [Change Guard](change-guard.md):

- Changing the VLAN ID or the parent of the VLAN interface the manager reaches the device
  through, or disabling or removing it, is predicted as a lockout and needs your confirmation.
  That includes a VLAN it's stacked on (Q-in-Q).
- Changing that interface's MTU can't be simulated, so it requires auto-revert.
- Renaming moves nothing: RouterOS renames every reference to the interface with it.

On a bridge with VLAN filtering, a new VLAN interface only gets traffic once the bridge itself
is a tagged member of that VLAN in the bridge VLAN table; the form reminds you when the parent
is a bridge. Removing a VLAN interface removes its addresses too; RouterOS would otherwise keep
them on a missing interface, marked invalid.

## Bridges

The **Bridges** tab lists every bridge on the device (#284): whether it's running, its spanning
tree mode and priority, its comment, its ports, whether VLAN filtering is on and which VLANs
have entries, and the addresses on it. Each VLAN is listed once; VLANs that RouterOS only added
by itself, for a port's PVID or a wifi interface, are marked **(dynamic)**. A port switched by the CPU rather than the switch chip
has a small chip icon; hover a port for its PVID and spanning tree role.

- **New bridge** creates an empty one, with RSTP unless you choose otherwise. Add ports to it
  on the **Ports** tab (see [Moving ports between bridges](#moving-ports-between-bridges)).
- **Edit** renames it, changes its spanning tree mode or priority (0 to 61440 in steps of
  4096; the lowest wins the root election), changes its comment or MTU, or turns it off.
  Renaming keeps its ports, VLANs and addresses.
- **MTU** is `auto` by default: RouterOS uses the lowest MTU of the bridge's ports. Set a
  number, or `auto` to go back. The bridge's MTU is for the router's own traffic on the bridge:
  its address, routing in and out, and VLAN interfaces on it. Jumbo frames switched between
  ports don't use it; they only need those ports' MTU raised (see
  [A port's MTU](#a-ports-mtu)).

  A bridge's MTU can't be more than the smallest L2 MTU of its ports, and the field says what
  that is. Asked for more, the manager names the ports that are too small, because RouterOS's
  own answer is only "could not set mtu". Raise those ports' MTU on the **Ports** tab first. A
  port whose hardware can't go that high, such as a CRS510's 2028-byte management port, has to
  leave the bridge instead.
- **turn on / turn off** next to VLAN filtering works as it does from the faceplate.
- The bin deletes a bridge with no ports, addresses or VLAN entries.

Everything runs through [Change Guard](change-guard.md). Renaming the bridge the manager
connects through, or changing its spanning tree or MTU, can't be simulated, so it runs with
auto-revert required; turning that bridge off is predicted as a lockout and asks first.

## Routing between VLANs in hardware

On a device whose switch chip supports it (Marvell 98DX: CRS3xx, CRS5xx, CCR2116, CCR2216),
the **VLANs** tab has an **L3 hardware offloading** card (#254). It shows:

- whether offloading is on, and the switch chip;
- which VLAN interfaces have addresses, so which VLANs the device routes between;
- while it's on, how many hosts and routes the chip handles, and how many entries go to the CPU
  (that count always includes the device's own addresses);
- routed VLANs whose bridge doesn't have VLAN filtering on: only VLAN interfaces on a
  hardware-offloaded, VLAN-filtering bridge are routed in hardware;
- how many forward-chain firewall rules and NAT rules the device has.

**Turn on** / **Turn off** sets `/interface/ethernet/switch l3-hw-offloading` under Change Guard,
since the chip reprograms its tables and forwarding can stop briefly. Offloaded traffic
bypasses the CPU, so **firewall filter and NAT rules no longer apply to traffic routed between
the VLANs**. When the device has forward-chain or NAT rules, turning offloading on asks you to
confirm that nothing relies on them for that traffic. FastTracked connections can still be
offloaded on chips that support it.

When a supported device routes between two or more VLANs with offloading off, Config Health
reports *Routing between VLANs runs on the CPU*. There's no one-click fix: whether to trade the
firewall for speed is your call.

## Routes

The **Routing** tab's **IPv4 Routes** lists the device's routes with their routing table (VRF),
and adds or removes static routes through [Change Guard](change-guard.md); a route can be put in
any routing table the device has (#328). **IPv6 Routes** lists the IPv6 routing table (#312):
destination, gateway, table, distance, whether it's active and how it was learned (static,
connected, OSPF, BGP and so on), and blackhole or unreachable routes. It's read-only for now.
Devices with IPv6 turned off, or without the ipv6 package, say so rather than showing an empty table.

### Routing rules

**Rules** lists the device's policy routing rules (`/routing/rule`, or `/ip/route/rule` on
RouterOS 6) in the order RouterOS tries them, from Ron's request in #370. Each shows what it
matches (source, destination, routing mark, in interface) and what it does; for a lookup, click
the action to see that table's routes under the rule. The first rule that matches decides, so
the tab flags:

- a rule that's the **same as an earlier one**, or that an earlier rule **already covers** (for
  example `192.168.52.0/24` after `192.168.0.0/16`): it never applies;
- a lookup in a **table that doesn't exist** (RouterOS 7);
- a lookup in a **table with no active routes**; with *Look up only in table* that traffic is
  unreachable.

A rule with `min-prefix` can pass traffic on to the next rule, so it's never counted as covering
the ones after it. Rules can be added (at the end) and removed through
[Change Guard](change-guard.md), with **Review changes** first if you like.

## Tools

All of these run **on the device**, not from the manager, so they see the network from where
the device sits.

| Tool | Notes |
|---|---|
| Ping | Reachability with RTT and loss |
| Traceroute | Hop-by-hop path |
| IP Scan | ARP sweep of a subnet |
| Wake-on-LAN | Magic packet sent from the device |
| Packet capture | 5–60s sniff, downloaded as `.pcap`. Requires SSH |
| Bandwidth test | Between two managed devices; the target's test server is enabled and disabled for you |
| Torch | Live traffic on one interface, flow by flow, refreshed every second (below) |

### Torch

**Torch** shows who is talking on an interface right now: protocol, source and destination
with ports, and each flow's TX and RX rate, busiest first, refreshed every second. Narrow it
by source, destination (IPv4 or IPv6, a single address or a prefix), port and protocol before
starting. It is RouterOS's own `/tool torch`, read over the API.

Torch costs the router CPU while it runs, so it is bounded: it stops when you press **Stop**
or leave the page, and by itself after 10 minutes. A device runs at most two at once. Traffic
that a switch chip forwards in hardware never reaches the CPU, so on a CRS switch Torch shows
only what the CPU handles. Operators and admins can use it, and each start is in the audit log.

### Web Admin

**Web Admin** at the top of a device's page opens its web interface (WebFig) in a new tab. It
asks the device where WebFig answers: over HTTPS when `www-ssl` is on (even with plain `www`
off, as [WebFig over HTTPS](security.md#webfig-over-https) leaves it), otherwise over HTTP,
each on the port the device uses (#335). If both are off it says so instead, and if `www-ssl`
has no certificate it warns that HTTPS may not answer (the Security tab's **Switch to HTTPS**
sets one up). When the device doesn't answer
the manager, it falls back to `http://` on the device's address.

### Terminal

The terminal opens an SSH shell on the device, for admins in the device's site. Operators
don't get one: a shell skips Change Guard and Review changes, so they make their changes
through the tabs and bulk commands instead.
The audit log records each session's start, who opened it, from which address, and when it
was refused (for example by the rate limit). **What is typed in the shell is not recorded.**
If you need a record of commands, turn on logging on the device itself (`/system logging`), or
use bulk commands, whose commands and output are kept.

Before 0.24.49 the address recorded was the manager's own proxy, not the user's.

## Syncing and polling

Devices are polled on three cadences — see [Polling and scaling](scaling.md) for the model and
for switching individual collectors off.

**Sync** forces a full collection immediately rather than waiting for the next cycle. It
honours the collector settings, so a collector you have switched off stays off.
When it finishes, every tab on the device's page reloads, so what you're looking at reflects
the sync straight away.

A tab's own **Refresh** reads what that tab shows. Most tabs read the device live each time.
The **VLANs** and **Radios** tabs show what the poller stored, so for operators and admins their
Refresh first reads just that part from the device (interfaces and VLANs, or the radios), then
reloads; for read-only accounts it reloads what's stored.
