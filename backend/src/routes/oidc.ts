/**
 * OIDC / SSO endpoints, mounted at /api/auth/oidc.
 *
 * Public:  GET /status, GET /login, GET /callback (the browser-facing flow).
 * Admin:   GET/PUT /config, POST /test (provider configuration).
 *
 * The callback mints the platform's normal session JWT and hands it to the SPA
 * via the URL fragment, matching the existing localStorage/Bearer model.
 */
import { Router, Request, Response } from 'express';
import { Issuer } from 'openid-client';
import { requireAuth, requireAdmin, signToken } from '../middleware/auth';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import {
  loadOidcConfig, saveOidcConfig, maskedConfig, APP_ROLES, type AppRole, type OidcConfig,
} from '../services/oidc/oidcConfig';
import { beginLogin, completeLogin, resetOidcClientCache } from '../services/oidc/OidcService';

const router = Router();

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
      const url = await beginLogin(redirectUriFor(req, config), returnTo);
      res.redirect(url);
    } catch (e) {
      res.redirect(`/login?error=sso&reason=${encodeURIComponent((e as Error).message)}`);
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
      if (params.error) throw new Error(params.error_description || params.error);
      const { user, returnTo } = await completeLogin(params);
      const token = signToken({ userId: user.id, username: user.username, role: user.role });
      const dest = safeReturnTo(returnTo);
      // Hand the token to the SPA via fragment (never sent to the server/logs).
      res.redirect(`/auth/callback#token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(dest)}`);
    } catch (e) {
      res.redirect(`/login?error=sso&reason=${encodeURIComponent((e as Error).message)}`);
    }
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
