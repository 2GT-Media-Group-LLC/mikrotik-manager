import { Issuer, type Client } from 'openid-client';
import type { RequestHandler } from 'express';
import { queryOne } from '../../config/database';
import { loadSiteRoles } from '../../utils/siteRoles';

export const MCP_SCOPE = 'mcp:read';

export interface McpConfig {
  resource: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** Explicit configuration only: never derive an OAuth resource from a Host header. */
export function mcpConfig(): McpConfig | null {
  if (process.env.MCP_ENABLED !== 'true') return null;
  const resource = process.env.MCP_RESOURCE_URL;
  const issuer = process.env.MCP_OAUTH_ISSUER;
  const clientId = process.env.MCP_INTROSPECTION_CLIENT_ID;
  const clientSecret = process.env.MCP_INTROSPECTION_CLIENT_SECRET;
  if (!resource || !issuer || !clientId || !clientSecret) throw new Error('MCP configuration incomplete');
  for (const value of [resource, issuer]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('MCP requires canonical HTTPS URLs');
    }
  }
  if (new URL(resource).pathname !== '/api/mcp') throw new Error('MCP resource must end in /api/mcp');
  return { resource, issuer, clientId, clientSecret };
}

let cached: { key: string; until: number; client: Client } | undefined;
async function introspectionClient(config: McpConfig): Promise<Client> {
  const key = JSON.stringify(config);
  if (cached?.key === key && cached.until > Date.now()) return cached.client;
  const issuer = await Issuer.discover(config.issuer);
  if (issuer.issuer !== config.issuer || typeof issuer.metadata.introspection_endpoint !== 'string'
      || new URL(issuer.metadata.introspection_endpoint).protocol !== 'https:') {
    throw new Error('Invalid MCP OAuth issuer');
  }
  const client = new issuer.Client({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    token_endpoint_auth_method: 'client_secret_basic',
    introspection_endpoint_auth_method: 'client_secret_basic',
  });
  cached = { key, until: Date.now() + 300_000, client };
  return client;
}

/** Introspect every request: revoked tokens, deleted accounts and changed site roles fail closed. */
export const mcpAuth: RequestHandler = async (req, res, next) => {
  let config: McpConfig | null;
  try { config = mcpConfig(); } catch {
    res.status(503).json({ error: 'MCP is not configured correctly' }); return;
  }
  if (!config) { res.sendStatus(404); return; }
  res.setHeader('Cache-Control', 'no-store');
  const metadata = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/api/mcp`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPE}"`;
  // Reject browser requests from other origins (and DNS rebinding Host values).
  if (req.get('host') !== new URL(config.resource).host
      || (req.get('origin') && req.get('origin') !== new URL(config.resource).origin)) {
    res.sendStatus(403); return;
  }
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 8192) {
    res.setHeader('WWW-Authenticate', challenge); res.sendStatus(401); return;
  }
  try {
    const client = await introspectionClient(config);
    const token = await client.introspect(header.slice(7), 'access_token');
    const audience = Array.isArray(token.aud) ? token.aud : [token.aud];
    const now = Math.floor(Date.now() / 1000);
    if (token.active !== true || !audience.includes(config.resource)
        || typeof token.exp !== 'number' || token.exp <= now
        || (typeof token.nbf === 'number' && token.nbf > now)
        || (token.iss !== undefined && token.iss !== config.issuer)
        || typeof token.sub !== 'string' || !token.sub) {
      res.setHeader('WWW-Authenticate', challenge); res.sendStatus(401); return;
    }
    if (!token.scope?.split(' ').includes(MCP_SCOPE)) {
      res.setHeader('WWW-Authenticate', `${challenge}, error="insufficient_scope"`);
      res.sendStatus(403); return;
    }
    const user = await queryOne<{ id: number; username: string; role: string; must_change_password: boolean }>(
      `SELECT id, username, role, must_change_password FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`,
      [config.issuer, token.sub]);
    if (!user || user.must_change_password || !['admin', 'operator', 'viewer'].includes(user.role)) {
      res.sendStatus(403); return;
    }
    const roles = await loadSiteRoles(user.id);
    req.user = { userId: user.id, username: user.username, role: 'viewer', ...(roles ? { siteRoles: roles } : {}) };
    next();
  } catch {
    // Never forward provider errors: they can contain tokens or upstream configuration.
    res.status(503).json({ error: 'MCP authorisation is unavailable' });
  }
};
