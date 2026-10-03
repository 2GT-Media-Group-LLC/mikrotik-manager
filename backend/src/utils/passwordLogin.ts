import { loadOidcConfig } from '../services/oidc/oidcConfig';

/**
 * Password sign-in can be turned off for SSO-only installs (#226) with
 * PASSWORD_LOGIN=false in the environment. It's an environment setting rather
 * than an app setting on purpose: if SSO breaks, an admin changes .env and
 * restarts, which nothing in the app can prevent.
 *
 * It only takes effect while SSO is actually configured. With SSO off, turning
 * password sign-in off too would leave no way in at all, so it stays on and the
 * log says why.
 */
const OFF = new Set(['false', '0', 'off', 'no', 'disabled']);
let warned = false;

export function passwordLoginRequestedOff(): boolean {
  return OFF.has((process.env.PASSWORD_LOGIN ?? '').trim().toLowerCase());
}

export async function passwordLoginEnabled(): Promise<boolean> {
  if (!passwordLoginRequestedOff()) return true;
  const sso = await loadOidcConfig().catch(() => null);
  const ssoReady = !!(sso?.enabled && sso.issuer_url && sso.client_id);
  if (!ssoReady) {
    if (!warned) {
      console.warn('[auth] PASSWORD_LOGIN=false is ignored: SSO is not configured, so password sign-in stays on.');
      warned = true;
    }
    return true;
  }
  return false;
}
