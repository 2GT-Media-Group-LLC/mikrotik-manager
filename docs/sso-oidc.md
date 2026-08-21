# Single sign-on (OIDC)

[← Documentation index](README.md)

Authenticate against any standards-compliant OpenID Connect provider — Microsoft Entra ID,
Okta, Google Workspace, Keycloak, Authentik and others.

Authorization Code flow with PKCE. The server validates the ID token (JWKS signature plus
`iss`, `aud`, `exp` and `nonce`) and then issues the platform's normal session, so SSO
users get the same experience as local ones.

**No environment variables and no redeploy** — everything is configured in the UI, with
the client secret encrypted at rest.

## 1. Register the application with your provider

Create an OIDC/OAuth **web application** and note:

- **Issuer URL** — the base that serves `/.well-known/openid-configuration`
- **Client ID**
- **Client Secret** — optional; public clients with no secret work via PKCE

Set the redirect / callback URI to:

```
https://<your-host>/api/auth/oidc/callback
```

The exact value is shown in the settings panel, which is worth copying from rather than
typing.

## 2. Configure it in the app

As an admin, go to **Settings → SSO / OIDC**.

| Field | Purpose |
|---|---|
| **Issuer URL** | Your provider's base URL. **Test discovery** verifies it is reachable before you save. |
| **Client ID / Secret** | From step 1. The secret is write-only — leave it blank to keep the existing one. |
| **Scopes** | Default `openid profile email`. Add a groups scope if your IdP needs one to emit group membership. |
| **Username claim** | Default `preferred_username` |
| **Email claim** | Default `email` |
| **Groups claim** | Default `groups` |
| **Group → role mapping** | Map IdP groups to admin / operator / viewer, e.g. `net-admins → admin`. Highest-privilege match wins. |
| **Default role** | For users matching no mapping. Defaults to **viewer**. |
| **Auto-provision** | Create a local user automatically on first sign-in. |
| **Link by verified email** | Attach an SSO identity to an existing local account when the IdP's `email_verified` matches. |
| **Allowed email domains** | Optional allowlist restricting who may sign in. |
| **Public base URL** | Pin the redirect URI when your external URL differs from what the backend sees. |
| **Button label** | Text on the login button, e.g. "Sign in with Okta". |

Enable it and save. A **Sign in with SSO** button appears on the login page.

## Behaviour and safety

**Provisioning and linking.** First sign-in creates a user when auto-provision is on, or
links to an existing local account when `email_verified` matches — no duplicate account.
SSO users have no local password and are labelled with an **SSO** badge under
Users & Roles.

**Roles are resolved server-side** from your group mapping on every login. Existing users
are never silently demoted when a login carries no matching group, so a temporary IdP
misconfiguration cannot strip your admins.

**Break-glass.** Local username and password login stays available. The seeded local admin
can always get in, even if the IdP is misconfigured, expired, or unreachable. Do not delete
that account.

**Behind a reverse proxy.** The redirect URI is derived from the request host. If your
external URL differs from what the backend sees — a proxy, a custom domain, a tunnel —
set **Public base URL** to pin it, or the provider will reject the callback.
