# Sites

[← Documentation index](README.md)

A **site** is a named collection of devices whose data — clients, events, topology,
backups, statistics — is viewed separately from every other site's.

This is multi-*site*, not multi-tenancy. Sites separate what you **see**; they do not
separate who you **are**. There is deliberately no per-site access control: the existing
admin / manage / read-only roles are unchanged, and every user can see every site.

## If you run one network, ignore this page

On upgrade, a single site named **Default Site** is created and every existing device is
assigned to it. Nothing moves, no figure changes, and the site selector does not appear.
You will never meet the concept unless you create a second site.

## Creating and switching

The selector sits under the logo in the top-left, below the brand block. It lists your
sites and offers **New site**, **rename** (the pencil, on hover) and **All sites**.

Switching site reloads the data you are looking at. This is intentional and not a
performance bug: every cached figure belonged to the site you just left, and showing it
under another site's name would be worse than a brief reload.

## Moving devices

A device belongs to exactly one site. Move it from **Device → Physical Details → Site**;
the picker only appears when more than one site exists.

Moving a device takes its history with it — clients, events, backups, interface
statistics. Nothing is copied or lost, because none of that data carries a site of its
own: it hangs off the device, and the device carries the site.

Devices added through the UI or API join whichever site you were viewing, falling back
to the default site. A device belonging to no site would be invisible the moment any
site is selected, so the field is always set rather than left empty.

## The all-sites view

**All sites** in the selector opens a table of every site with its address and device
count, plus a world map with a pin per geocoded site. Selecting a row switches to that
site.

Choosing **All sites** also makes every other page fleet-wide, which is the honest reading
of "all sites" — useful for a fleet-wide search, less so for a dashboard that averages
several unrelated networks.

Pins require an address, which is geocoded via Nominatim when you save it. If
**Settings → Maps enabled** is off, no geocoding or tile request is made and the map is
hidden; addresses are still stored and shown as text.

## What sites scope, and what they do not

Scoped to the selected site:

- Devices, clients, events, topology, search
- Dashboard and Operations insights, metrics summary
- Wireless (APs, CAPsMAN, RF channels and signals)
- Backups, Firmware, Bulk commands

Also scoped: the Operations feed (Things to Handle, Recent Activity, capacity), Config
Health findings, anomaly detection, and the Connected Clients chart.

Deliberately **not** scoped:

- **Polling.** Collection always runs across the whole fleet. Sites are a view over data
  already gathered, not a change to how it is gathered — a device does not stop being
  monitored because you are looking at another site.
- **The audit log**, in Recent Activity. Audit rows record who changed the install; they
  carry no device and so belong to no site. Repeating "admin changed a setting" into every
  site would misattribute it, so the audit feed appears only in the all-sites view.
- **NetFlow collector health**, which is one service for the install.
- **Rogue AP detection.** The scans are site-scoped, but the "these access points are
  ours" set stays fleet-wide. An AP of yours in another site is still yours, and scoping
  that set would report your own hardware as a rogue.
- **Install-wide configuration**: users, alert rules, webhooks, config templates,
  credential presets, tags, maintenance windows and settings.

Bulk actions — Backup all, Sync all, firmware check-all, bulk commands — obey the
selector. A bulk operation that silently spanned two customers is precisely the blast
radius the wave and halt-on-failure guards exist to contain.

## Deleting a site

Deleting a site never deletes the devices in it. If devices remain, the deletion is
refused and you are asked to move them first, so their destination is a decision rather
than a side effect.

## API

The active site travels as an `X-Site-Id` header, or a `?site_id=` query parameter.

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Site-Id: 2" https://mtm.example.com/api/devices
```

**Omitting the header means unscoped**, returning the whole fleet exactly as the API did
before sites existed. Existing scripts and API tokens keep working untouched.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sites` | List sites with device counts |
| `POST` | `/api/sites` | Create a site |
| `PUT` | `/api/sites/:id` | Rename, set address or notes |
| `DELETE` | `/api/sites/:id` | Delete (refused while devices remain) |
| `POST` | `/api/sites/:id/devices` | Move devices into the site |

## The Connected Clients chart

Client totals are deduplicated — a client seen by two access points is one client — so the
chart cannot be a sum of per-device series. A per-site deduplicated series is recorded
alongside the fleet-wide one, and it starts accumulating from the upgrade.

That would have cost every existing install its chart history, so there is one shortcut,
and it is an identity rather than an approximation: **when a site contains every device,
its total is the fleet total**, and the chart reads the fleet-wide series with all of its
history. Single-site installs therefore lose nothing. Once you genuinely split the fleet,
each site's chart builds its own history from that point.

## A note on client counts

A client is counted in a site when a device in that site has seen it. On genuinely
separate networks the sites do not overlap. If two sites share one broadcast domain —
common in a lab — the same MAC is legitimately seen by hardware in both, and appears in
both counts.
