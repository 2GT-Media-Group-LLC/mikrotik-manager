/**
 * OIDC / SSO endpoints, mounted at /api/auth/oidc.
 *
 * Public:  GET /status, GET /login, GET /callback (the browser-facing flow).
 * Admin:   GET/PUT /config, POST /test (provider configuration).
 *
 * The login is bound to the browser that starts it by an HttpOnly cookie, and
 * the callback hands the SPA a single-use code, not the session itself; the SPA
 * exchanges the code (same browser, same cookie) for the normal session JWT.
 * The token used to travel in the URL fragment, where it stayed in history for
 * its whole life, and any token there was accepted (outside review S2, S4).
 */
import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { redis } from '../config/redis';
import { queryOne } from '../config/database';
import { sessionResponse } from '../utils/sessionResponse';
import { Issuer } from 'openid-client';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import {
  loadOidcConfig, saveOidcConfig, maskedConfig, APP_ROLES, type AppRole, type OidcConfig,
} from '../services/oidc/oidcConfig';
import { beginLogin, completeLogin, resetOidcClientCache, bindingHash } from '../services/oidc/OidcService';
import { logSafe } from '../utils/logSafe';

const router = Router();

/**
 * The reason a sign-in failed, as a fixed code for the login page (outside
 * review U8). The page used to print the message from the URL, which the
 * provider (or anyone crafting a link) controlled; now it shows its own
 * wording for each code and ignores anything else.
 */
export function ssoErrorCode(message: string, fromProvider = false): string {
  if (fromProvider) return 'provider';
  const rules: Array<[RegExp, string]> = [
    [/different browser|expired or invalid|has expired/i, 'expired'],
    [/turned off|not enabled/i, 'disabled'],
    [/not verified|did not confirm/i, 'unverified'],
    [/domain is not permitted/i, 'domain'],
    [/no account exists/i, 'no_account'],
    [/not fully configured/i, 'not_configured'],
  ];
  for (const [re, code] of rules) if (re.test(message)) return code;
  return 'failed';
}

// ─── Browser binding and the single-use code (S2, S4) ───────────────────────────
const BIND_COOKIE = 'mtm_oidc';
const BIND_TTL_S = 600;          // as long as a login may take at the provider
const CODE_TTL_S = 60;           // the SPA exchanges the code straight away
const codeKey = (code: string): string => `oidc:code:${createHash('sha256').update(code).digest('hex')}`;

function bindingCookie(req: Request): string | null {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === BIND_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setBindingCookie(req: Request, res: Response, value: string, maxAgeS: number): void {
  // Only the SSO endpoints receive it. Lax, because the provider's redirect
  // back is a top-level navigation from another site.
  const attrs = [`${BIND_COOKIE}=${encodeURIComponent(value)}`, 'Path=/api/auth/oidc', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  if (req.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function redirectUriFor(req: Request, config: OidcConfig): string {
  const base = config.public_base_url
    ? config.public_base_url.replace(/\/$/, '')
    : `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/oidc/callback`;
}

// Only accept same-site relative paths for post-login navigation. Rejects
// absolute URLs and protocol-relative values (//host) to avoid open redirects.
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?!\/)[^\\\s]*$/.test(value) ? value : '/dashboard';
}

// ─── Public: is SSO available? (drives the login button) ────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  const config = await loadOidcConfig();
  res.json({
    enabled: !!(config.enabled && config.issuer_url && config.client_id),
    button_label: config.button_label || 'Sign in with SSO',
  });
});

// ─── Public: start the login flow ───────────────────────────────────────────────
router.get(
  '/login',
  rateLimitRedis({ windowSec: 60, max: 20, keyPrefix: 'oidc-login', allMethods: true }),
  async (req: Request, res: Response) => {
    try {
      const config = await loadOidcConfig();
      const returnTo = safeReturnTo(req.query.returnTo);
      const binding = randomBytes(24).toString('base64url');
      const url = await beginLogin(redirectUriFor(req, config), returnTo, binding);
      setBindingCookie(req, res, binding, BIND_TTL_S);
      res.redirect(url);
    } catch (e) {
      console.warn('[OIDC] login could not start:', (e as Error).message);
      res.redirect(`/login?error=sso&code=${ssoErrorCode((e as Error).message)}`);
    }
  }
);

// ─── Public: IdP redirect target ────────────────────────────────────────────────
router.get(
  '/callback',
  rateLimitRedis({ windowSec: 60, max: 30, keyPrefix: 'oidc-callback', allMethods: true }),
  async (req: Request, res: Response) => {
    try {
      const params = req.query as Record<string, string>;
      if (params.error) {
        // Provider-supplied text, so made log-safe (CodeQL #110/#111).
        console.warn('[OIDC] the provider returned an error:', logSafe(params.error), logSafe(params.error_description || ''));
        res.redirect('/login?error=sso&code=provider');
        return;
      }
      const { user, returnTo, bindHash } = await completeLogin(params, bindingCookie(req));
      // A single-use code, good for a minute and only in this browser. The
      // session itself is issued when the SPA exchanges it.
      const code = randomBytes(32).toString('base64url');
      await redis.set(codeKey(code), JSON.stringify({ userId: user.id, bindHash }), 'EX', CODE_TTL_S);
      const dest = safeReturnTo(returnTo);
      res.redirect(`/auth/callback#code=${encodeURIComponent(code)}&returnTo=${encodeURIComponent(dest)}`);
    } catch (e) {
      console.warn('[OIDC] sign-in failed:', (e as Error).message);
      res.redirect(`/login?error=sso&code=${ssoErrorCode((e as Error).message)}`);
    }
  }
);

// ─── Public: exchange the single-use code for a session (S4) ────────────────────
router.post(
  '/exchange',
  rateLimitRedis({ windowSec: 60, max: 30, keyPrefix: 'oidc-exchange', allMethods: true }),
  async (req: Request, res: Response) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const binding = bindingCookie(req);
    setBindingCookie(req, res, '', 0); // done with it either way
    const raw = code ? await redis.getdel(codeKey(code)) : null;
    const rec = raw ? JSON.parse(raw) as { userId: number; bindHash: string } : null;
    // A code from a login this browser didn't start is refused: that is the
    // login-CSRF the fragment token allowed.
    if (!rec || !binding || bindingHash(binding) !== rec.bindHash) {
      return res.status(400).json({ error: 'This sign-in link has expired or belongs to another browser. Sign in again.' });
    }
    const user = await queryOne<{ id: number; username: string; role: string; must_change_password: boolean; session_version: number }>(
      `SELECT id, username, role, must_change_password, session_version FROM users WHERE id = $1`, [rec.userId]);
    if (!user) return res.status(400).json({ error: 'Account not found' });
    return res.json(await sessionResponse(user));
  }
);

// ─── Admin: read config (secret masked) ─────────────────────────────────────────
router.get('/config', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const config = await loadOidcConfig();
  res.json({ ...maskedConfig(config), redirect_uri: redirectUriFor(req, config) });
});

// ─── Admin: update config ───────────────────────────────────────────────────────
router.put('/config', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Partial<OidcConfig> & { client_secret?: string };

  const validRole = (r: unknown): r is AppRole => APP_ROLES.includes(r as AppRole);
  if (body.default_role !== undefined) {
    if (!validRole(body.default_role)) {
      return res.status(400).json({ error: 'Invalid default_role' });
    }
    // Auto-provisioning strangers straight to admin is almost never intended —
    // admin must be granted via an explicit group mapping, not the fallback.
    if (body.default_role === 'admin') {
      return res.status(400).json({ error: 'default_role cannot be admin — grant admin via an explicit group → role mapping instead' });
    }
  }
  if (body.group_role_map !== undefined) {
    if (typeof body.group_role_map !== 'object' || body.group_role_map === null) {
      return res.status(400).json({ error: 'group_role_map must be an object' });
    }
    for (const r of Object.values(body.group_role_map)) {
      if (!validRole(r)) return res.status(400).json({ error: `Invalid role in group_role_map: ${String(r)}` });
    }
  }
  if (body.enabled && body.issuer_url !== undefined) {
    try { new URL(body.issuer_url); } catch { return res.status(400).json({ error: 'issuer_url must be a valid URL' }); }
  }

  // client_secret handling: undefined = keep, '' = clear, string = set.
  const { client_secret, ...patch } = body;
  delete (patch as Record<string, unknown>).client_secret_encrypted; // never accept ciphertext from the client
  delete (patch as Record<string, unknown>).has_secret;

  const saved = await saveOidcConfig(patch, client_secret);
  resetOidcClientCache();
  res.json({ ...maskedConfig(saved), redirect_uri: redirectUriFor(req, saved) });
});

// ─── Admin: validate discovery against the configured issuer ────────────────────
router.post('/test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const issuerUrl = (req.body?.issuer_url as string) || (await loadOidcConfig()).issuer_url;
  if (!issuerUrl) return res.status(400).json({ error: 'issuer_url is required' });
  try {
    const issuer = await Issuer.discover(issuerUrl);
    res.json({
      ok: true,
      issuer: issuer.metadata.issuer,
      authorization_endpoint: issuer.metadata.authorization_endpoint,
      token_endpoint: issuer.metadata.token_endpoint,
      userinfo_endpoint: issuer.metadata.userinfo_endpoint,
      scopes_supported: issuer.metadata.scopes_supported,
      claims_supported: issuer.metadata.claims_supported,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: `Discovery failed: ${(e as Error).message}` });
  }
});

export default router;
