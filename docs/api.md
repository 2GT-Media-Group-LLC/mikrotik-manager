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
cannot change your network even if the token leaks.

## Session authentication

The UI authenticates with a JWT obtained from `/api/auth/login`, optionally followed by
`/api/auth/totp/verify` when two-factor is enabled. Tokens are bearer credentials and are
sent in the same `Authorization` header.

For scripting, prefer an API token — it is scoped, revocable, and unaffected by password
or 2FA changes.

## Endpoints worth knowing

| Endpoint | Purpose |
|---|---|
| `GET /api/devices` | Fleet inventory with status, model, versions and serials |
| `POST /api/devices/:id/sync` | Force an immediate full collection for one device |
| `GET /api/devices/:id/management-path` | How the manager reaches a device, with the reason for each hop |
| `POST /api/devices/:id/preflight` | Analyse a change **without applying it** |
| `POST /api/devices/:id/change-guard/probe` | Report which safety mechanisms the device supports |
| `GET /api/devices/:id/config-health` | Latest standing-audit findings |
| `GET /api/topology` | Graph of devices, links, external nodes, and distrusted identifiers |
| `GET /api/operations/insights` | The dashboard's "things to handle" feed |

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

A successful guarded change returns a `guard` block describing what happened —
`confirmed`, `auto_reverting`, or an `unprotected_reason` when the safety net could not be
armed. Check it rather than relying on the HTTP status alone.

## Webhooks

For push rather than poll, see [Alerting → outbound webhooks](alerting.md#outbound-webhooks).
Deliveries are HMAC-SHA256 signed and respect alert rules, cooldowns and maintenance
windows.
