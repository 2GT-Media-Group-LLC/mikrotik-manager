jest.mock('../../config/database');
jest.mock('../../utils/siteRoles', () => ({ loadSiteRoles: jest.fn() }));
jest.mock('../../services/cveFeed', () => ({ fleetCveReport: jest.fn() }));
jest.mock('../../middleware/rateLimitRedis', () => ({
  rateLimitRedis: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/sessionState', () => ({ validateSession: jest.fn(), forgetSessionAccount: jest.fn() }));
jest.mock('../../utils/crypto', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
jest.mock('openid-client', () => ({ discovery: jest.fn(), tokenIntrospection: jest.fn(), ClientSecretBasic: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { query, queryOne } from '../../config/database';
import { validateSession } from '../../utils/sessionState';
import mcpRoutes from '../mcp';
import reviewRoutes, { openApiSpec, tidyArguments } from '../review';
import aiConnectionsRoutes from '../aiConnections';
import { forgetAiSettings, settingsProblem, saveAiSettings, DEFAULT_AI_SETTINGS, type AiSettings } from '../../services/mcp/settings';
import { REVIEW_TOOLS } from '../../services/mcp/tools';
import { requireAuth, signToken } from '../../middleware/auth';
import { auditMiddleware } from '../../middleware/auditMiddleware';

const db = jest.mocked(query);
const dbOne = jest.mocked(queryOne);
const TOKEN = `mtm_${'a'.repeat(48)}`;
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const device = { id: 12, name: 'edge', site_id: 3, ros_version: '7.20', status: 'online', last_seen: new Date().toISOString(), api_password_encrypted: 'NEVER_RETURN' };

let settings: AiSettings;
let tokenRow: Record<string, unknown> | null;
let audits: unknown[][];

function app() {
  const a = express();
  a.use(express.json());
  a.use(auditMiddleware);
  a.use('/api/mcp', mcpRoutes);
  a.use('/api/review', reviewRoutes);
  return a;
}
const tool = (name: string, body: unknown = {}) => request(app()).post(`/api/review/${name}`).set('Authorization', `Bearer ${TOKEN}`).send(body as object);
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  forgetAiSettings();
  settings = { ...DEFAULT_AI_SETTINGS, enabled: true, mcp_enabled: true, mcp_auth: 'token', openapi_enabled: true };
  tokenRow = { id: 5, name: 'open-webui', expires_at: null, site_ids: null };
  audits = [];
  dbOne.mockReset().mockImplementation(async (sql) => {
    if (sql.includes('FROM app_settings')) return { value: settings } as never;
    if (sql.includes('FROM devices')) return device as never;
    return null;
  });
  db.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes('FROM api_tokens')) {
      // Only a review-scope token with this hash matches.
      return (params?.[0] === HASH && params?.[1] === 'review' && tokenRow ? [tokenRow] : []) as never;
    }
    if (sql.includes('INSERT INTO audit_log')) { audits.push(params as unknown[]); return [] as never; }
    if (sql.includes('FROM devices')) return [device] as never;
    return [] as never;
  });
});

describe('AI connection settings', () => {
  const ok = { ...DEFAULT_AI_SETTINGS, enabled: true, mcp_enabled: true, mcp_auth: 'oauth' as const, public_url: 'https://manager.example',
    oauth_issuer: 'https://id.example/realms/x', oauth_client_id: 'mtm', oauth_client_secret_encrypted: 'enc:s' };
  it('needs a public https address, issuer, client and secret for OAuth only', () => {
    expect(settingsProblem(ok)).toBeNull();
    expect(settingsProblem({ ...ok, public_url: '' })).toMatch(/public address/);
    expect(settingsProblem({ ...ok, public_url: 'http://manager.example' })).toMatch(/https/);
    expect(settingsProblem({ ...ok, public_url: 'https://manager.example/mtm' })).toMatch(/nothing after the host/);
    expect(settingsProblem({ ...ok, oauth_issuer: 'http://id.example' })).toMatch(/issuer/);
    expect(settingsProblem({ ...ok, oauth_client_secret_encrypted: null })).toMatch(/secret/);
    // Tokens, or MCP off, need none of it.
    expect(settingsProblem({ ...ok, mcp_auth: 'token', public_url: '', oauth_issuer: '' })).toBeNull();
    expect(settingsProblem({ ...ok, mcp_enabled: false, oauth_issuer: '' })).toBeNull();
    expect(settingsProblem({ ...ok, mcp_auth: 'basic' as never })).toMatch(/OAuth or token/);
  });
  it('saves only known fields of the right type, trims the address and encrypts the secret', async () => {
    const saved = await saveAiSettings({ enabled: true, openapi_enabled: true, public_url: 'https://manager.example/ ', extra: 1 } as never, 'shh');
    expect(saved).toMatchObject({ public_url: 'https://manager.example', oauth_client_secret_encrypted: 'enc:shh' });
    expect(saved).not.toHaveProperty('extra');
    expect(await saveAiSettings({ enabled: 'yes' } as never)).toEqual({ error: 'enabled has the wrong type.' });
    expect(await saveAiSettings({ oauth_client_secret_encrypted: 'forged' } as never)).not.toHaveProperty('oauth_client_secret_encrypted', 'forged');
  });
});

describe('AI connection tokens', () => {
  it('are refused by the rest of the API', async () => {
    db.mockImplementation(async (sql) => sql.includes('FROM api_tokens')
      ? [{ id: 5, name: 'open-webui', scope: 'review', expires_at: null }] as never : [] as never);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireAuth({ headers: { authorization: `Bearer ${TOKEN}` } } as never, res as never, next);
    await settle(); await settle();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('are the only tokens the review endpoints take', async () => {
    tokenRow = null; // e.g. an Automation read token: no review-scope match
    expect((await tool('list_devices')).status).toBe(401);
    // Nor a signed-in session.
    jest.mocked(validateSession).mockResolvedValue({ userId: 1, username: 'admin', role: 'admin' } as never);
    const session = signToken({ userId: 1, username: 'admin', role: 'admin', sv: 0 });
    expect((await request(app()).post('/api/review/list_devices').set('Authorization', `Bearer ${session}`).send({})).status).toBe(401);
  });
  it('stop working once expired', async () => {
    tokenRow = { ...tokenRow, expires_at: '2000-01-01T00:00:00Z' };
    expect((await tool('list_devices')).status).toBe(401);
  });
  it('keep to their sites, and a token whose sites are all gone sees nothing', async () => {
    tokenRow = { ...tokenRow, site_ids: [3] };
    await tool('list_devices');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('d.site_id = 3'), [51, 0]);
    expect((await tool('list_devices', { site_id: 4 })).body.error).toBe('Site is unavailable');
    tokenRow = { ...tokenRow, site_ids: [] };
    await tool('list_devices');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('d.site_id IN (NULL)'), [51, 0]);
  });
});

describe('OpenAPI review server', () => {
  it('is not there while switched off', async () => {
    for (const change of [{ enabled: false }, { openapi_enabled: false }]) {
      settings = { ...settings, ...change }; forgetAiSettings();
      expect((await request(app()).get('/api/review/openapi.json')).status).toBe(404);
      expect((await tool('list_devices')).status).toBe(404);
    }
  });
  it('publishes one POST operation per tool, with the schemas MCP uses', async () => {
    const res = await request(app()).get('/api/review/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).sort()).toEqual(REVIEW_TOOLS.map((t) => `/${t.name}`).sort());
    const overview = res.body.paths['/get_device_overview'].post;
    expect(overview.operationId).toBe('get_device_overview');
    const schema = overview.requestBody.content['application/json'].schema;
    expect(schema).toMatchObject({ type: 'object', required: ['device_id'], additionalProperties: false });
    expect(schema).not.toHaveProperty('$schema');
    expect(res.body.paths['/list_events'].post.requestBody.content['application/json'].schema.properties.hours).toMatchObject({ default: 24, maximum: 168 });
    expect(openApiSpec('https://manager.example').servers).toEqual([{ url: 'https://manager.example/api/review' }]);
  });
  it('runs a tool, returns only allowlisted fields and audits it once', async () => {
    const res = await tool('list_devices', { limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ id: 12, name: 'edge' });
    expect(res.text).not.toContain('NEVER_RETURN');
    await settle();
    expect(audits).toEqual([[-5, 'token:open-webui', '/api/review/list_devices', 'openapi', null,
      'list_devices site=permitted outcome=success', expect.any(String), 200]]);
  });
  it('tidies what models send, and explains what it refuses', async () => {
    const t = REVIEW_TOOLS.find((x) => x.name === 'get_device_overview')!;
    expect(tidyArguments(t, { device_id: '12', site_id: null, limit: '' })).toEqual({ device_id: 12 });
    expect((await tool('get_device_overview', { device_id: '12', site_id: null })).status).toBe(200);
    const bad = await tool('get_device_overview', {});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/device_id/);
    expect((await tool('list_devices', { command: '/system/reboot' })).status).toBe(400);
    expect((await request(app()).post('/api/review/list_devices').set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json').send('{"__proto__":{"site_id":4}}')).status).toBe(400);
    expect((await tool('execute_command')).status).toBe(404);
    expect((await request(app()).get('/api/review/list_devices').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(405);
  });
  it('reports a failed tool once in the audit log, with its status', async () => {
    dbOne.mockImplementation(async (sql) => sql.includes('FROM app_settings') ? { value: settings } as never : null);
    const res = await tool('get_device_overview', { device_id: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Device is unavailable');
    await settle();
    expect(audits).toHaveLength(1);
    expect(audits[0][5]).toBe('get_device_overview site=permitted outcome=failed');
  });
  it('refuses requests from other sites in a browser', async () => {
    expect((await tool('list_devices').set('Origin', 'https://attacker.example')).status).toBe(403);
  });
});

describe('MCP with token sign-in', () => {
  const rpc = (method: string, params?: unknown) => request(app()).post('/api/mcp')
    .set('Authorization', `Bearer ${TOKEN}`).set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
  it('lists and runs the same tools with an AI token, and no OAuth hints', async () => {
    const listed = await rpc('tools/list');
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools).toHaveLength(REVIEW_TOOLS.length);
    expect(listed.body.result.tools[0]._meta?.securitySchemes).toBeUndefined();
    const res = await rpc('tools/call', { name: 'get_device_overview', arguments: { device_id: 12 } });
    expect(res.body.result.structuredContent.device.name).toBe('edge');
    await settle();
    expect(audits[0].slice(0, 4)).toEqual([-5, 'token:open-webui', '/api/mcp', 'mcp']);
  });
  it('asks for a token without pointing at OAuth discovery', async () => {
    tokenRow = null;
    const res = await rpc('tools/list');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });
  it('takes no AI token when OAuth is chosen', async () => {
    settings = { ...settings, mcp_auth: 'oauth', public_url: 'https://manager.example', oauth_issuer: 'https://id.example',
      oauth_client_id: 'mtm', oauth_client_secret_encrypted: 'enc:s' };
    forgetAiSettings();
    expect((await rpc('tools/list').set('Host', 'manager.example')).status).toBe(503); // provider discovery mocked away
    expect(db).not.toHaveBeenCalledWith(expect.stringContaining('FROM api_tokens'), expect.anything());
  });
});

describe('Settings → AI Connections route', () => {
  function admin(role = 'admin', site?: boolean) {
    const a = express();
    a.use(express.json());
    jest.mocked(validateSession).mockResolvedValue({ userId: 1, username: 'rich', role, ...(site ? { siteRoles: { 3: 'admin' } } : {}) } as never);
    a.use('/api/ai-connections', aiConnectionsRoutes);
    return { a, auth: `Bearer ${signToken({ userId: 1, username: 'rich', role, sv: 0 })}` };
  }
  it('is for fleet-wide admins only', async () => {
    const viewer = admin('viewer');
    expect((await request(viewer.a).get('/api/ai-connections/config').set('Authorization', viewer.auth)).status).toBe(403);
    const scoped = admin('admin', true);
    expect((await request(scoped.a).get('/api/ai-connections/config').set('Authorization', scoped.auth)).status).toBe(403);
  });
  it('never returns the OAuth secret', async () => {
    settings = { ...settings, oauth_client_secret_encrypted: 'enc:topsecret' };
    const { a, auth } = admin();
    const res = await request(a).get('/api/ai-connections/config').set('Authorization', auth);
    expect(res.body.has_oauth_secret).toBe(true);
    expect(res.text).not.toContain('topsecret');
  });
  it('refuses settings that would not work', async () => {
    const { a, auth } = admin();
    const res = await request(a).put('/api/ai-connections/config').set('Authorization', auth).send({ mcp_auth: 'oauth' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public address/);
  });
  it('creates a review token, shown once and stored hashed, limited to existing sites', async () => {
    const { a, auth } = admin();
    db.mockImplementation(async (sql) => sql.includes('FROM sites') ? [{ id: 3 }] as never : [] as never);
    dbOne.mockImplementation(async () => ({ id: 9 }) as never);
    const res = await request(a).post('/api/ai-connections/tokens').set('Authorization', auth).send({ name: 'open-webui', site_ids: [3] });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^mtm_[0-9a-f]{48}$/);
    const insert = dbOne.mock.calls.find(([sql]) => sql.includes('INSERT INTO api_tokens'))!;
    expect(insert[1]).toEqual(['open-webui', createHash('sha256').update(res.body.token).digest('hex'), res.body.token.slice(0, 12), 'review', 'rich', null, [3]]);
    expect(JSON.stringify(insert[1])).not.toContain(res.body.token.slice(12));
    expect((await request(a).post('/api/ai-connections/tokens').set('Authorization', auth).send({ name: 'x', site_ids: [3, 4] })).status).toBe(400);
    expect((await request(a).post('/api/ai-connections/tokens').set('Authorization', auth).send({ name: 'x', site_ids: [] })).status).toBe(400);
  });
});
