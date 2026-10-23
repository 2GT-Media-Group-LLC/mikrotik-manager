# MCP review connector

The optional MCP endpoint lets ChatGPT and other MCP clients review stored inventory,
security posture, configuration audits, CVE matches, interfaces and event metadata.
It makes no device connections, runs no scans, refreshes no feeds and exposes no write
or command tools. No OpenAI API key is needed by Manager.

The endpoint is **off by default**. Enabling it requires an established OAuth provider
with token introspection; Manager does not implement a new authorisation server.

## Configure the identity provider

Use the same issuer and subject identities as [Manager SSO](sso-oidc.md). Users must
already have an SSO-linked Manager account. The connector never provisions accounts
or matches them by email. Local password accounts and Manager API tokens cannot be
used at this endpoint.

Configure your provider to:

1. Publish OIDC discovery and an HTTPS RFC 7662 token introspection endpoint.
2. Define an API resource whose exact audience is `https://manager.example.com/api/mcp`
   and a delegated scope named `mcp:read`.
3. Permit an OAuth authorisation-code flow with PKCE for the ChatGPT client. Register
   its current callback URL using OpenAI's connection documentation; use a predefined
   client or supported dynamic registration. Require user consent for this read scope.
4. Register a separate confidential client allowed to introspect tokens, using
   `client_secret_basic`. Give its credentials to Manager, never to the agent.
5. Return `active`, `sub`, `aud`, `exp`, and space-separated `scope` from introspection.
   `sub` must match the existing Manager SSO identity. If `iss` is returned it must match
   the configured issuer exactly. Revocation must make introspection return inactive.

Providers which cannot issue this audience/scope or introspect access tokens are not
supported by this first release. Merely configuring SSO does not create an MCP resource.

## Configure Manager

Set these variables in `.env` and recreate the backend container:

```dotenv
MCP_ENABLED=true
MCP_RESOURCE_URL=https://manager.example.com/api/mcp
MCP_OAUTH_ISSUER=https://identity.example.com/realms/network
MCP_INTROSPECTION_CLIENT_ID=manager-mcp-resource
MCP_INTROSPECTION_CLIENT_SECRET=replace-with-your-provider-client-secret
```

Use canonical HTTPS URLs with no query strings or fragments. The resource path must
be `/api/mcp`. The proxy must preserve the public Host header, including any nonstandard
port. The bundled nginx configuration proxies both MCP and its discovery document.
An additional reverse proxy must forward `/.well-known/oauth-protected-resource/api/mcp`
as well as `/api/mcp`. The backend needs outbound HTTPS access to the configured IdP.

Connect using Streamable HTTP at the resource URL. The implementation is stateless,
returns JSON responses, and does not offer a GET SSE stream (GET/DELETE return 405).
Unauthenticated requests receive a `WWW-Authenticate` discovery challenge. Metadata
is also available at `https://manager.example.com/.well-known/oauth-protected-resource/api/mcp`.

In ChatGPT, add the endpoint as a custom MCP connection with OAuth, configure your
provider's ChatGPT client credentials if using a predefined client, then authenticate
and install the connection. Account/workspace policy determines connection availability.
Use trusted HTTPS connectivity or a supported private tunnel. Never expose RouterOS
management ports to ChatGPT. Configure any tunnel to preserve the configured resource
identity and Host header; verify discovery and audience handling before use.

Official setup references: [ChatGPT custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [OAuth authentication](https://developers.openai.com/plugins/build/auth).

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

Device tools require `device_id`. `site_id` optionally narrows the permitted scope.
List tools accept `limit` (1–100, default 50) and `offset` (0–10000, default 0); follow
`next_offset` until null. Events accept `hours` (1–168, default 24). Large responses
are refused above 256 KiB; request a smaller page. Request bodies are limited to 16 KiB,
requests to 60 per authenticated user per minute, and active MCP requests to eight per
backend process. A pre-authentication IP limit also applies.

Examples: "Review each device at site 3, citing finding IDs and evidence times", or
"Which known vulnerabilities match device 12, and what uncertainty remains?"

Inventory and posture become stale after 15 minutes, configuration audits after one
hour, and CVE feed evidence after one day. These are reporting thresholds, not scan
schedules. Missing observations are `unavailable`; failed cached refreshes are `partial`.
Offline status and unknown RouterOS versions must not be interpreted as a clean review.
Version matches do not confirm exploitability. Suppressed posture checks stay visible
and do not count against the score. No endpoint automatically collects missing evidence.

## Access, privacy and revocation

Every request introspects the token and reloads the linked account's current site/group
roles. Deleted accounts and accounts requiring a password change are refused. A user
with access to no sites gets no fleet data. Explicit IDs cannot bypass site restrictions.
Even administrators receive only the read-only tool catalog and allowlisted fields.

Selected data leaves Manager for the connected client/model. Inventory includes private
IP addresses and device names. Raw logs, notes, arbitrary configurations, backups,
credential fields, command execution and fixes are excluded. Selected free text is
bounded and common credential assignment formats are redacted; this cannot guarantee
that arbitrary text contains no sensitive information. Keep secrets out of names,
finding text and suppression reasons. Treat all returned text as untrusted evidence.

Each executed tool is recorded in the audit log with the user, tool, requested site,
device ID and outcome; tokens, raw arguments and result contents are not recorded.
An unavailable audit store prevents delivery of tool data. Revoke the connection's
access token at the IdP to terminate access, or set `MCP_ENABLED=false` and recreate
the backend to disable all MCP access. Removing the user's Manager account also blocks
the connection. Manager's ordinary session logout does not revoke an IdP access token.

401 indicates a missing, inactive, expired or wrong-audience token; 403 indicates an
origin/Host mismatch, missing scope or unavailable Manager account. 503 indicates
configuration, discovery/introspection or authorisation-store failure. Provider errors
are deliberately not passed to the client. Ensure your provider supports the exact
resource audience, PKCE and introspection contract above when troubleshooting.

## Initial release limits

This release supplies inventory and finding evidence. It omits raw firewall/routing
configuration, VLAN/topology exports, event messages, historical comparisons and
scheduled reports. Live ChatGPT and provider setup must be verified in your deployment;
the repository tests exercise the protocol and mocked OAuth/provider boundaries.
Any future remediation tool needs its own permissions, approval and Change Guard design.
