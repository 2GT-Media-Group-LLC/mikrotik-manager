import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuth, mcpConfig, MCP_SCOPE } from '../services/mcp/auth';
import { createReviewServer } from '../services/mcp/server';
import { rateLimitRedis } from '../middleware/rateLimitRedis';

export const mcpMetadataRoutes = Router();
// RFC 9728 path-specific metadata for the /api/mcp resource.
mcpMetadataRoutes.get('/.well-known/oauth-protected-resource/api/mcp', (_req, res) => {
  try {
    const config = mcpConfig();
    if (!config) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ resource: config.resource, authorization_servers: [config.issuer],
      scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'], resource_name: 'MikroTik Manager read-only review' });
  } catch { return res.status(503).json({ error: 'MCP is not configured correctly' }); }
});

const router = Router();
router.use(rateLimitRedis({ windowSec: 60, max: 120, keyPrefix: 'mcp-preauth', allMethods: true }));
router.use(mcpAuth);
router.use(rateLimitRedis({ windowSec: 60, max: 60, keyPrefix: 'mcp-user', allMethods: true }));
let active = 0;
router.post('/', async (req, res) => {
  if (active >= 8) { res.setHeader('Retry-After', '5'); res.sendStatus(429); return; }
  if (Buffer.byteLength(JSON.stringify(req.body) ?? '') > 16_384 || Array.isArray(req.body)) {
    res.sendStatus(413); return;
  }
  active++;
  const server = createReviewServer(req.user!, (req.ip ?? '').replace(/^::ffff:/, ''));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
  } finally {
    active--;
    await server.close().catch(() => {});
  }
});
router.all('/', (_req, res) => { res.setHeader('Allow', 'POST'); res.sendStatus(405); });
export default router;
