# API and automation

[← Documentation index](README.md)

The web UI is a client of the same REST API you can drive yourself. Anything the interface
does is available to a script.

## Scoped API tokens

Issue tokens under **Settings → Automation**.

- Prefix `mtm_…`, with **read** or **write** scope and an optional expiry
- Shown **once** on creation — only a SHA-256 hash is stored
- Mapped onto the role model: no token can perform admin actions or manage other tokens,
  regardless of scope

```bash
curl -sk https://manager.example.com/api/devices \
  -H "Authorization: Bearer mtm_your_token_here"
```

A token with `read` scope is rejected on any mutating request, so a monitoring integration
cannot change your network even if the token leaks. It is also refused on requests that make
a device do something, such as a firmware check or a wireless scan, and it gets device secrets
masked (see below).

### What read-only access can see

Viewers and `read` tokens see configuration, but not the secrets inside it. Wi-Fi keys,
WireGuard private keys, SNMP communities and hotspot user passwords come back as
`••••••••`, as do Slack and Discord webhook URLs for everyone. Operators and admins get the
real values, because the edit forms need them.

## Session authentication

The UI authenticates with a JWT obtained from `/api/auth/login`, optionally followed by
`/api/auth/totp/verify` when two-factor is enabled. Tokens are bearer credentials and are
sent in the same `Authorization` header. The short-lived token `/login` returns while waiting
for the two-factor code only works for `/api/auth/totp/verify`; it isn't a session.

Setting up two-factor again (`/api/auth/totp/setup`) doesn't touch the authenticator in use:
the new secret replaces it only when `/api/auth/totp/confirm` accepts a code from it. Before
0.24.50 starting setup and abandoning it locked the user out.

For scripting, prefer an API token — it is scoped, revocable, and unaffected by password
or 2FA changes.

## Endpoints worth knowing

| Endpoint | Purpose |
|---|---|
| `GET /api/devices` | Fleet inventory with status, model, versions and serials |
| `POST /api/devices/:id/sync` | Force an immediate full collection for one device |
| `GET /api/devices/:id/management-path` | How the manager reaches a device, with the reason for each hop |
| `POST /api/devices/:id/preflight` | Analyse a change **without applying it** |
| `POST /api/devices/:id/change-guard/check` | Can this device arm auto-revert right now? (`ready`, `reason`) |
| `POST /api/devices/:id/change-guard/probe` | Report which safety mechanisms the device supports |
| `GET /api/devices/:id/config-health` | Latest standing-audit findings |
| `GET /api/topology` | Graph of devices, links, external nodes, and distrusted identifiers |
| `GET /api/operations/insights` | The dashboard's "things to handle" feed |
| `GET /api/sites` | Sites with device counts (see [Sites](sites.md)) |

### Scoping a request to one site

Collection endpoints accept an `X-Site-Id` header (or `?site_id=`) that limits the
response to devices in that site:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Site-Id: 2" \
     https://mtm.example.com/api/devices
```

**Omitting it means unscoped**, returning the whole fleet exactly as before sites
existed — existing scripts and tokens need no change. Per-device endpoints
(`/api/devices/:id/...`) are already scoped by the device itself and ignore the header.

One thing to know if you create devices via the API: a device joins the site the
request was scoped to, falling back to the default site. A device belonging to no site
is invisible whenever a site is selected, so this is set rather than left null.

`preflight` is the useful one for automation: it returns the same verdict the UI shows,
so a pipeline can refuse its own change before touching the device. See
[Change Guard](change-guard.md#lockout-prediction).

## Applying a guarded change from a script

Guarded endpoints return **409** with `lockout: true` and a verdict when a change is
predicted to sever management. To proceed anyway, resend with `confirm_lockout: true` —
the change then runs under Change Guard, so a mistake still recovers itself.

```bash
# Refused, with an explanation
curl -sk -X PUT https://manager.example.com/api/devices/8/ports/ether1/vlan \
  -H "Authorization: Bearer mtm_…" -H 'Content-Type: application/json' \
  -d '{"pvid":99,"tagged_vlans":[],"untagged_vlans":[99]}'

# Accepted, relying on auto-revert
curl -sk -X PUT https://manager.example.com/api/devices/8/ports/ether1/vlan \
  -H "Authorization: Bearer mtm_…" -H 'Content-Type: application/json' \
  -d '{"pvid":99,"tagged_vlans":[],"untagged_vlans":[99],"confirm_lockout":true}'
```

A confirmed override requires auto-revert. If the device can't arm it, the request fails
with **422** and `code: "guard_required"`, and nothing is applied. The same applies when
the prediction flagged a warning or couldn't read the device.

For a DELETE, which has no body, send `?confirm_lockout=true` instead.

Writes to one device run one at a time. While another change to the same device is being
applied or verified, a write returns **409** with `code: "device_busy"`; retry after a few
seconds. It is told apart from a lockout by `code`, and a lockout always carries
`lockout: true`.

Firewall, NAT, address-list, routing and WireGuard writes return a short `message` and the
`guard` block rather than the updated table; read the table again with the matching GET.

A successful guarded change returns a `guard` block describing what happened:
`confirmed`, `auto_reverting`, an `unprotected_reason` when a routine change ran without
the safety net, or `revert_may_fire_at` when the change was kept but its revert couldn't be
confirmed removed. Check it rather than relying on the HTTP status alone.

Restores (`POST /api/backups/:id/restore`, and Config History rollback) return a `status`
of `applied`, `reverting`, `nothing_applied` or `partial`, with a `message`. The last two
come with HTTP 422, plus `failedLine` and `error` saying where RouterOS stopped. See
[Backups → Restoring](backups.md#restoring).

## Webhooks

For push rather than poll, see [Alerting → outbound webhooks](alerting.md#outbound-webhooks).
Deliveries are HMAC-SHA256 signed and respect alert rules, cooldowns and maintenance
windows.
