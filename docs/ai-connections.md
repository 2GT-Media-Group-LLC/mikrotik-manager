# AI connections

AI tools can review what MikroTik Manager has already stored: sites, devices,
security findings, config health, CVE matches, interfaces and event metadata. They
can't change anything. There are no write or command tools, and nothing connects to
a device, runs a scan or refreshes a feed. Passwords, keys, notes, raw configuration
and backups are never included. No AI provider API key is needed by the manager.

The same eight tools are offered two ways:

- **MCP** (Model Context Protocol) at `/api/mcp`, for Claude, ChatGPT, LM Studio,
  Open WebUI's MCP connections and other MCP clients.
- **OpenAPI** at `/api/review`, for Open WebUI's tool servers and other tools that
  read an OpenAPI spec.

Both are off until an admin turns them on.

## Turning it on

Open **Settings → AI Connections** (admins with fleet-wide access only). Switch
**AI Connections** on, then switch on **MCP**, **OpenAPI** or both. Each one lists its
addresses, with a Copy button, once it's switched on. Press **Save**: nothing changes
until you do, and switching a service off makes its addresses answer 404 at once.

**Public address** is the address AI tools reach the manager at, such as
`https://manager.example.com`. Leave it blank to use the address you're browsing
from. OAuth needs it set, because it becomes the token audience.

| Service | Address |
| --- | --- |
| MCP server | `https://manager.example.com/api/mcp` |
| OAuth discovery (MCP with OAuth only) | `https://manager.example.com/.well-known/oauth-protected-resource/api/mcp` |
| OpenAPI server | `https://manager.example.com/api/review` |
| OpenAPI spec | `https://manager.example.com/api/review/openapi.json` |

## Signing in

MCP takes one of two kinds of sign-in, chosen under **Sign-in**. OpenAPI always uses
a token.

### AI connection tokens

The simplest choice for a tool on your own network. Make one under **AI connection
tokens** on the same page, one per tool so each can be revoked alone. A token can see
all sites or only the sites you tick, and can expire after a number of days. It's
shown once; only a hash is kept. The tool sends it as `Authorization: Bearer mtm_…`.

These tokens reach the AI connection endpoints and nothing else: the rest of the API
refuses them. API tokens from **Settings → Automation** don't work here either. Calls
are recorded in the audit log as `token:<name>`. A token whose sites have all been
deleted sees nothing, never the whole fleet.

### OAuth

For hosted services such as ChatGPT, and for people who should see only their own
sites. Each person signs in through your identity provider; the manager checks the
token with the provider on every request and applies that person's current site and
group roles.

Use the same issuer and subject identities as [single sign-on](sso-oidc.md). People
must already have a MikroTik Manager account they've signed in to with SSO. The
connector never makes accounts or matches them by email. Configure your provider to:

1. Publish OIDC discovery and an HTTPS RFC 7662 token introspection endpoint.
2. Define an API resource whose exact audience is the MCP server address, such as
   `https://manager.example.com/api/mcp`, and a delegated scope named `mcp:read`.
3. Permit an authorisation-code flow with PKCE for the AI tool's client. For ChatGPT,
   register its current callback URL as OpenAI's connection documentation says; use a
   predefined client or supported dynamic registration. Require consent for the scope.
4. Register a separate confidential client allowed to introspect tokens, using
   `client_secret_basic`. Enter its ID and secret under **OAuth**, never in the AI tool.
5. Return `active`, `sub`, `aud`, `exp` and a space-separated `scope` from
   introspection. `sub` must match the person's SSO identity. If `iss` is returned it
   must match the issuer exactly. Revoking a token must make introspection say inactive.

**Test provider** checks that the issuer can be discovered and offers an HTTPS
introspection endpoint. Providers that can't issue this audience and scope, or can't
introspect access tokens, aren't supported. Setting up SSO alone doesn't create the
MCP resource.

The manager needs outbound HTTPS to the provider. Any reverse proxy in front of the
manager must pass on both `/api/mcp` and `/.well-known/oauth-protected-resource/api/mcp`
and keep the public Host header, including a nonstandard port. The bundled nginx does.

## Connecting a tool

### Open WebUI

Open WebUI can use either service. With **OpenAPI**: in **Admin Settings → External
Tools**, add an OpenAPI connection with the OpenAPI server address
(`https://manager.example.com/api/review`), keep the spec path `openapi.json`, choose
Bearer and paste an AI connection token. With **MCP**: add an MCP (Streamable HTTP)
connection with the MCP server address and the token as a Bearer key.

If the manager still has its self-signed certificate, Open WebUI refuses it. Either
put a trusted certificate on the manager (**Settings → TLS Certificate**), or give
Open WebUI the manager's certificate: mount it into the container and set
`AIOHTTP_CLIENT_SESSION_TOOL_SERVER_SSL` to its path. That setting covers both its
OpenAPI and MCP connections.

### ChatGPT

Choose OAuth. Add the MCP server address as a custom MCP connection with OAuth, set
up your provider's client for ChatGPT, then sign in and install the connection. Your
account or workspace policy decides whether connections are available. ChatGPT must
reach the manager over trusted HTTPS or a supported private tunnel; keep the tunnel's
Host header and address the same as the public address. Never expose RouterOS
management ports. See [ChatGPT custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [OAuth authentication](https://developers.openai.com/plugins/build/auth).

### Claude, LM Studio and other MCP clients

Choose token sign-in, add the MCP server address as a Streamable HTTP server and send
the token as `Authorization: Bearer mtm_…`. The server is stateless and answers with
JSON; there's no GET event stream (GET and DELETE answer 405).

### Other OpenAPI tools

Each tool is `POST /api/review/<tool>` with its arguments as a JSON object, described
in the spec. The spec itself needs no token, so tools can read it before they're given
one; it holds only the tool list. Arguments a model leaves empty (`null` or `""`) are
dropped, and whole numbers sent as text (`"12"`) are accepted.

## Review tools and evidence

| Tool | Data |
| --- | --- |
| `list_sites` | Permitted site IDs and names |
| `list_devices` | Stored inventory, versions, status and last-seen time |
| `get_device_overview` | One permitted device's stored inventory |
| `get_security_findings` | Cached posture, score and current suppression reasons |
| `get_config_health` | Stored audit findings and remediation guidance |
| `get_vulnerabilities` | Stored CVE version matches, uncertainty and NVD references |
| `get_network_context` | Stored interface state, speed and MTU |
| `list_events` | Event IDs, timestamps, severity and topic; no message bodies |

Device tools need `device_id`. `site_id` narrows to one permitted site. List tools take
`limit` (1–100, default 50) and `offset` (0–10000, default 0); follow `next_offset`
until it's null. Events take `hours` (1–168, default 24). Results over 256 KiB are
refused; ask for a smaller page. Request bodies are limited to 16 KiB, calls to 60 a
minute per caller, and to eight running at once on each service. A limit per address
applies before sign-in too.

Examples: "Review each device at site 3, citing finding IDs and evidence times", or
"Which known vulnerabilities match device 12, and what uncertainty remains?"

Inventory and posture count as stale after 15 minutes, config audits after an hour and
CVE feed evidence after a day. These are reporting thresholds, not scan schedules.
Missing observations are `unavailable`; a failed cached refresh is `partial`. Offline
status and unknown RouterOS versions don't make a clean review, and a version match
doesn't prove a device is exploitable. Suppressed posture checks stay visible and
don't count against the score. Nothing collects missing evidence on its own.

## Access, privacy and revocation

Explicit IDs can't get round site limits, and an account or token with no sites gets
no fleet data. Even administrators get only the read-only tools and allowlisted fields.
With OAuth, deleted accounts and accounts that must change their password are refused.

What a tool returns leaves the manager for the AI tool and its model. Inventory
includes private IP addresses and device names. Free text is shortened and common
credential formats are redacted, but that can't guarantee arbitrary text holds nothing
sensitive, so keep secrets out of names, finding text and suppression reasons. Treat
everything returned as untrusted evidence, never instructions.

Each tool call is recorded in the audit log with the caller, tool, requested site,
device ID and outcome. Tokens, raw arguments and results are not recorded. If the
audit log can't be written, no data is returned.

To cut a tool off, revoke its AI connection token, or with OAuth revoke the access
token at the provider or remove the person's manager account. Signing out of the
manager doesn't revoke a provider's access token. Switching a service off in
**Settings → AI Connections** stops all access through it within a few seconds.

401 means a missing, unknown, expired or (OAuth) inactive or wrong-audience token. 403
means a browser request from another site, a Host mismatch (OAuth), a missing scope or
no usable manager account. 503 means the OAuth settings, the provider or the audit log
is unavailable; provider errors are not passed on.

## Limits

This release gives inventory and finding evidence. It leaves out raw firewall and
routing configuration, VLAN and topology exports, event messages, historical
comparisons and scheduled reports. Any future tool that changes things would need its
own permissions, approval and Change Guard design.
