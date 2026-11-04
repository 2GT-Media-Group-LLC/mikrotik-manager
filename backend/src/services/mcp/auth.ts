import * as oidc from 'openid-client';
import type { Request, RequestHandler, Response } from 'express';
import { queryOne } from '../../config/database';
import { loadSiteRoles } from '../../utils/siteRoles';
import { loadAiSettings, mcpMode, oauthSecret, openApiOn, settingsProblem, type AiSettings, type McpAuth } from './settings';
import { reviewTokenUser } from './tokens';

export const MCP_SCOPE = 'mcp:read';

export interface McpConfig {
  resource: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * The OAuth resource, from Settings only: never derived from a Host header.
 * Throws when OAuth is chosen but its settings don't hold up.
 */
export function oauthConfig(s: AiSettings): McpConfig | null {
  if (mcpMode(s) !== 'oauth') return null;
  const clientSecret = oauthSecret(s);
  if (settingsProblem(s) || !clientSecret) throw new Error('MCP configuration incomplete');
  return { resource: `${s.public_url}/api/mcp`, issuer: s.oauth_issuer, clientId: s.oauth_client_id, clientSecret };
}

let cached: { key: string; until: number; client: oidc.Configuration } | undefined;
/** The provider, discovered once every five minutes; HTTPS only (openid-client refuses plain HTTP). */
async function introspectionClient(config: McpConfig): Promise<oidc.Configuration> {
  const key = JSON.stringify(config);
  if (cached?.key === key && cached.until > Date.now()) return cached.client;
  const client = await oidc.discovery(new URL(config.issuer), config.clientId, undefined, oidc.ClientSecretBasic(config.clientSecret));
  const meta = client.serverMetadata();
  if (meta.issuer !== config.issuer || typeof meta.introspection_endpoint !== 'string'
      || new URL(meta.introspection_endpoint).protocol !== 'https:') {
    throw new Error('Invalid MCP OAuth issuer');
  }
  cached = { key, until: Date.now() + 300_000, client };
  return client;
}

/** Settings → AI Connections → Test: can the provider be discovered and does it offer introspection? */
export async function testOauthProvider(issuer: string, clientId: string, clientSecret: string): Promise<string | null> {
  try {
    await introspectionClient({ resource: 'https://test.invalid/api/mcp', issuer, clientId, clientSecret });
    return null;
  } catch (e) {
    return e instanceof Error && e.message === 'Invalid MCP OAuth issuer'
      ? 'The provider answered, but its issuer differs or it has no HTTPS introspection endpoint.'
      : 'Could not discover the provider at that issuer address.';
  }
}

/**
 * A browser on another site can't use these endpoints. Bearer tokens are
 * never sent automatically, but refusing foreign Origins costs nothing.
 */
function foreignOrigin(req: Request, allowed: string[]): boolean {
  const origin = req.get('origin');
  return !!origin && !allowed.includes(origin);
}

function sameHostOrigins(req: Request, s: AiSettings): string[] {
  const host = req.get('host');
  return [...(s.public_url ? [new URL(s.public_url).origin] : []), ...(host ? [`https://${host}`] : [])];
}

/** An AI connection token (mtm_…, scope review) in the Authorization header. */
async function tokenCaller(req: Request, res: Response): Promise<boolean> {
  const header = req.get('authorization');
  const user = header?.startsWith('Bearer ') && header.length <= 8192 ? await reviewTokenUser(header.slice(7)) : null;
  if (!user) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Send an AI connection token from Settings → AI Connections as "Authorization: Bearer mtm_…".' });
    return false;
  }
  req.user = user;
  return true;
}

/** Introspect every request: revoked tokens, deleted accounts and changed site roles fail closed. */
async function oauthCaller(req: Request, res: Response, config: McpConfig): Promise<boolean> {
  const metadata = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/api/mcp`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPE}"`;
  // Reject browser requests from other origins (and DNS rebinding Host values).
  if (req.get('host') !== new URL(config.resource).host
      || (req.get('origin') && req.get('origin') !== new URL(config.resource).origin)) {
    res.sendStatus(403); return false;
  }
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 8192) {
    res.setHeader('WWW-Authenticate', challenge); res.sendStatus(401); return false;
  }
  try {
    const client = await introspectionClient(config);
    const token = await oidc.tokenIntrospection(client, header.slice(7), { token_type_hint: 'access_token' });
    const audience = Array.isArray(token.aud) ? token.aud : [token.aud];
    const now = Math.floor(Date.now() / 1000);
    if (token.active !== true || !audience.includes(config.resource)
        || typeof token.exp !== 'number' || token.exp <= now
        || (typeof token.nbf === 'number' && token.nbf > now)
        || (token.iss !== undefined && token.iss !== config.issuer)
        || typeof token.sub !== 'string' || !token.sub) {
      res.setHeader('WWW-Authenticate', challenge); res.sendStatus(401); return false;
    }
    if (!token.scope?.split(' ').includes(MCP_SCOPE)) {
      res.setHeader('WWW-Authenticate', `${challenge}, error="insufficient_scope"`);
      res.sendStatus(403); return false;
    }
    const user = await queryOne<{ id: number; username: string; role: string; must_change_password: boolean }>(
      `SELECT id, username, role, must_change_password FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`,
      [config.issuer, token.sub]);
    if (!user || user.must_change_password || !['admin', 'operator', 'viewer'].includes(user.role)) {
      res.sendStatus(403); return false;
    }
    const roles = await loadSiteRoles(user.id);
    req.user = { userId: user.id, username: user.username, role: 'viewer', ...(roles ? { siteRoles: roles } : {}) };
    return true;
  } catch {
    // Never forward provider errors: they can contain tokens or upstream configuration.
    res.status(503).json({ error: 'MCP authorisation is unavailable' }); return false;
  }
}

/** /api/mcp: 404 while switched off, then OAuth or an AI token as Settings say. */
export const mcpAuth: RequestHandler = async (req, res, next) => {
  let s: AiSettings;
  let config: McpConfig | null;
  try { s = await loadAiSettings(); config = oauthConfig(s); } catch {
    res.status(503).json({ error: 'MCP is not configured correctly' }); return;
  }
  const mode = mcpMode(s);
  if (!mode) { res.sendStatus(404); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.locals.mcpAuth = mode satisfies McpAuth;
  if (mode === 'oauth') {
    if (await oauthCaller(req, res, config!)) next();
    return;
  }
  if (foreignOrigin(req, sameHostOrigins(req, s))) { res.sendStatus(403); return; }
  try { if (await tokenCaller(req, res)) next(); } catch {
    res.status(503).json({ error: 'MCP authorisation is unavailable' });
  }
};

/** /api/review (OpenAPI): 404 while switched off, then an AI token. */
export const openApiAuth: RequestHandler = async (req, res, next) => {
  let s: AiSettings;
  try { s = await loadAiSettings(); } catch {
    res.status(503).json({ error: 'The review API is unavailable' }); return;
  }
  if (!openApiOn(s)) { res.sendStatus(404); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (foreignOrigin(req, sameHostOrigins(req, s))) { res.sendStatus(403); return; }
  try { if (await tokenCaller(req, res)) next(); } catch {
    res.status(503).json({ error: 'The review API is unavailable' });
  }
};
