jest.mock('../../config/database');
jest.mock('../../utils/siteRoles', () => ({ loadSiteRoles: jest.fn() }));
jest.mock('../../services/cveFeed', () => ({ fleetCveReport: jest.fn() }));
jest.mock('../../middleware/rateLimitRedis', () => ({
  rateLimitRedis: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('openid-client', () => ({ Issuer: { discover: jest.fn() } }));

import express from 'express';
import request from 'supertest';
import { Issuer } from 'openid-client';
import { query, queryOne } from '../../config/database';
import { loadSiteRoles } from '../../utils/siteRoles';
import { fleetCveReport } from '../../services/cveFeed';
import routes, { mcpMetadataRoutes } from '../mcp';
import { safeText, observation } from '../../services/mcp/output';

const introspect = jest.fn();
const resource = 'https://manager.example/api/mcp';
const issuer = 'https://id.example';
const env = { ...process.env };
const db = jest.mocked(query);
const dbOne = jest.mocked(queryOne);
const roles = jest.mocked(loadSiteRoles);
const device = { id: 12, name: 'edge', site_id: 3, ros_version: '7.20', status: 'online', last_seen: new Date().toISOString(), api_password_encrypted: 'NEVER_RETURN' };
let account: Record<string, unknown> | null;
let visibleDevice: Record<string, unknown> | null;

function app() {
  const a = express();
  a.use(express.json({ limit: '16kb' }));
  a.use(mcpMetadataRoutes);
  a.use('/api/mcp', routes);
  return a;
}
function rpc(method: string, params?: unknown) {
  return request(app()).post('/api/mcp').set('Host', 'manager.example')
    .set('Authorization', 'Bearer test-access-token').set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
}
function call(name: string, args: Record<string, unknown> = {}) { return rpc('tools/call', { name, arguments: args }); }
function data(response: request.Response) { return response.body.result.structuredContent; }

beforeEach(() => {
  process.env.MCP_ENABLED = 'true';
  process.env.MCP_RESOURCE_URL = resource;
  process.env.MCP_OAUTH_ISSUER = issuer;
  process.env.MCP_INTROSPECTION_CLIENT_ID = 'resource';
  process.env.MCP_INTROSPECTION_CLIENT_SECRET = 'not-a-real-secret';
  introspect.mockReset().mockResolvedValue({ active: true, sub: 'user-subject', iss: issuer, aud: resource, exp: Math.floor(Date.now() / 1000) + 3600, scope: 'mcp:read' });
  jest.mocked(Issuer.discover).mockResolvedValue({ issuer, metadata: { introspection_endpoint: `${issuer}/introspect` },
    Client: class { introspect = introspect; } } as never);
  account = { id: 7, username: 'reviewer', role: 'admin', must_change_password: false };
  visibleDevice = device;
  dbOne.mockReset().mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) return account as never;
    if (sql.includes('FROM devices')) return visibleDevice as never;
    return null;
  });
  db.mockReset().mockResolvedValue([]);
  roles.mockReset().mockResolvedValue({ 3: 'viewer' });
});
afterAll(() => { process.env = env; });

describe('MCP protocol and authorisation', () => {
  it('is disabled by default and publishes protected-resource discovery only when configured', async () => {
    process.env.MCP_ENABLED = 'false';
    expect((await rpc('tools/list')).status).toBe(404);
    expect((await request(app()).get('/.well-known/oauth-protected-resource/api/mcp')).status).toBe(404);
    process.env.MCP_ENABLED = 'true';
    const res = await request(app()).get('/.well-known/oauth-protected-resource/api/mcp');
    expect(res.body).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ['mcp:read'] });
    expect(res.text).not.toContain('not-a-real-secret');
  });
  it('requires OAuth bearer auth and advertises metadata', async () => {
    const res = await request(app()).post('/api/mcp').set('Host', 'manager.example').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/api/mcp');
  });
  it('initializes and advertises exactly the read-only tools', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('mikrotik-manager');
    const listed = await rpc('tools/list');
    expect(listed.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'get_config_health', 'get_device_overview', 'get_network_context', 'get_security_findings',
      'get_vulnerabilities', 'list_devices', 'list_events', 'list_sites',
    ]);
    for (const tool of listed.body.result.tools) expect(tool.annotations.readOnlyHint).toBe(true);
    expect((await call('execute_command', { command: '/system/reboot' })).body.result.isError).toBe(true);
  });
  it.each([
    { active: false }, { aud: 'https://another.example/api/mcp' }, { exp: 1 }, { nbf: 9999999999 },
    { iss: 'https://attacker.example' }, { sub: '' }, { exp: undefined },
  ])('rejects invalid/revoked tokens %j', async (change) => {
    const valid = await introspect();
    introspect.mockResolvedValue({ ...valid, ...change });
    expect((await rpc('tools/list')).status).toBe(401);
    expect(dbOne).not.toHaveBeenCalled();
  });
  it('checks scope and current account identity', async () => {
    const valid = await introspect();
    introspect.mockResolvedValue({ ...valid, scope: 'other:read' });
    expect((await rpc('tools/list')).status).toBe(403);
    introspect.mockResolvedValue(valid);
    account = null;
    expect((await rpc('tools/list')).status).toBe(403);
    account = { id: 7, username: 'reviewer', role: 'viewer', must_change_password: true };
    expect((await rpc('tools/list')).status).toBe(403);
    expect(dbOne).toHaveBeenCalledWith(expect.stringContaining('oidc_issuer = $1 AND oidc_subject = $2'), [issuer, 'user-subject']);
  });
  it('fails closed on introspection/storage outages without forwarding errors', async () => {
    introspect.mockRejectedValue(new Error('password=DO_NOT_LEAK'));
    const res = await rpc('tools/list');
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('DO_NOT_LEAK');
  });
  it('rejects foreign browser origins and Host headers', async () => {
    const foreign = await rpc('tools/list').set('Origin', 'https://attacker.example');
    expect(foreign.status).toBe(403);
    expect((await rpc('tools/list').set('Host', 'attacker.example')).status).toBe(403);
  });
  it('does not accept an insecure resource configuration', async () => {
    process.env.MCP_RESOURCE_URL = 'http://manager.example/api/mcp';
    expect((await rpc('tools/list')).status).toBe(503);
  });
  it('refuses SSE sessions and batch requests', async () => {
    const get = await request(app()).get('/api/mcp').set('Host', 'manager.example').set('Authorization', 'Bearer token');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await request(app()).post('/api/mcp').set('Host', 'manager.example').set('Authorization', 'Bearer token').send([])).status).toBe(413);
  });
});

describe('review evidence and isolation', () => {
  it('limits list queries to current sites, applies pagination and excludes extra fields', async () => {
    db.mockImplementation(async (sql) => sql.includes('FROM devices') ? [device, { ...device, id: 13 }] as never : []);
    const res = await call('list_devices', { limit: 1 });
    expect(data(res).next_offset).toBe(1);
    expect(data(res).items).toHaveLength(1);
    expect(res.text).not.toContain('NEVER_RETURN');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('d.site_id = 3'), [2, 0]);
    const forbidden = await call('list_devices', { site_id: 9 });
    expect(forbidden.body.result.isError).toBe(true);
  });
  it('an empty site set never becomes fleet-wide access', async () => {
    roles.mockResolvedValue({});
    await call('list_devices');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('d.site_id IN (NULL)'), [51, 0]);
  });
  it.each(['get_device_overview', 'get_security_findings', 'get_config_health', 'get_vulnerabilities', 'get_network_context', 'list_events'])('scopes guessed IDs before reading data in %s', async (tool) => {
    visibleDevice = null;
    const res = await call(tool, { device_id: 999 });
    expect(res.body.result.isError).toBe(true);
    expect(dbOne).toHaveBeenCalledWith(expect.stringContaining('d.id = $1 AND d.site_id = 3'), [999]);
    expect(dbOne).not.toHaveBeenCalledWith(expect.stringContaining('device_live_cache'), expect.anything());
  });
  it('rereads site roles on each request rather than trusting token claims', async () => {
    await call('list_devices');
    roles.mockResolvedValue({ 4: 'viewer' });
    await call('list_devices');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('d.site_id = 4'), [51, 0]);
    expect(introspect).toHaveBeenCalledTimes(2);
  });
  it('reports missing scans as unavailable with no clean score', async () => {
    const res = await call('get_security_findings', { device_id: 12 });
    expect(data(res)).toMatchObject({ score: null, observation: { status: 'unavailable', collected_at: null } });
  });
  it('applies current suppressions and strips cached secrets and unsafe fields', async () => {
    dbOne.mockImplementation(async (sql) => {
      if (sql.includes('FROM users')) return account as never;
      if (sql.includes('device_live_cache')) return { data: { score: 1, password: 'NEVER_RETURN', checks: [
        { id: 'telnet', severity: 'high', title: 'Cleartext service', detail: 'password=HIDDEN', fix: 'execute something' },
      ] }, fetched_at: '2000-01-01T00:00:00Z', error: 'token=HIDDEN' } as never;
      return device as never;
    });
    db.mockImplementation(async (sql) => sql.includes('security_check_suppressions')
      ? [{ check_id: 'telnet', device_id: 12, reason: 'Approved exception' }] as never : []);
    const res = await call('get_security_findings', { device_id: 12 });
    expect(data(res)).toMatchObject({ score: 100, observation: { status: 'partial' }, items: [{ suppressed: true, suppressed_reason: 'Approved exception' }] });
    expect(res.text).not.toMatch(/NEVER_RETURN|HIDDEN|execute something/);
  });
  it('bounds event windows and omits raw messages even if the DB returns extras', async () => {
    expect((await call('list_events', { device_id: 12, hours: 169 })).body.result.isError).toBe(true);
    db.mockImplementation(async (sql) => sql.includes('FROM events')
      ? [{ id: 1, severity: 'warning', message: 'NEVER_RETURN', raw_json: { password: 'NEVER_RETURN' } }] as never : []);
    const res = await call('list_events', { device_id: 12, hours: 24 });
    expect(res.text).not.toContain('NEVER_RETURN');
    expect(db).toHaveBeenCalledWith(expect.stringContaining("INTERVAL '1 hour'"), [12, 24, 51, 0]);
  });
  it('returns only allowlisted config findings and interface fields', async () => {
    db.mockImplementation(async (sql) => sql.includes('device_config_findings')
      ? [{ fingerprint: 'check-1', rule: 'unused-rule', title: 'Review rule', detail: 'token=HIDDEN', objects: ['private text'], password: 'NEVER_RETURN' }] as never
      : sql.includes('FROM interfaces') ? [{ id: 1, name: 'ether1', config_json: { password: 'NEVER_RETURN' }, comment: 'NEVER_RETURN' }] as never : []);
    const findings = await call('get_config_health', { device_id: 12 });
    expect(data(findings).items[0].fingerprint).toBe('check-1');
    expect(data(findings).observation.status).toBe('unavailable');
    expect(findings.text).not.toMatch(/HIDDEN|NEVER_RETURN|private text/);
    const network = await call('get_network_context', { device_id: 12 });
    expect(data(network).interfaces.items[0].name).toBe('ether1');
    expect(network.text).not.toContain('NEVER_RETURN');
  });
  it('preserves CVE uncertainty and limits the shared report to the permitted device', async () => {
    jest.mocked(fleetCveReport).mockResolvedValue({ enabled: true, fetched_at: null, last_error: null, versions: [
      { version: '7.20', cves: [{ id: 'CVE-2026-1234', uncertain: 'hardware dependent', source: 'nvd' }] },
    ] } as never);
    const res = await call('get_vulnerabilities', { device_id: 12 });
    expect(data(res).items[0]).toMatchObject({ uncertain: 'hardware dependent', reference: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1234' });
    expect(fleetCveReport).toHaveBeenCalledWith([3], [12]);
  });
  it('withholds data on audit failure and never records response contents', async () => {
    db.mockRejectedValue(new Error('password=HIDDEN'));
    const res = await call('get_device_overview', { device_id: 12 });
    expect(res.body.result.isError).toBe(true);
    expect(res.text).not.toContain('edge');
    expect(res.text).not.toContain('HIDDEN');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'),
      [7, 'reviewer', 12, 'get_device_overview site=permitted outcome=success', expect.any(String), 200]);
  });
  it('refuses oversized responses and records the failed outcome', async () => {
    const oversized = { ...device, name: 'n'.repeat(2000), model: 'm'.repeat(2000), ip_address: 'i'.repeat(2000), firmware_version: 'f'.repeat(2000) };
    db.mockImplementation(async (sql) => sql.includes('FROM devices') ? Array(50).fill(oversized) as never : []);
    const res = await call('list_devices');
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('smaller page');
    expect(db).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'),
      [7, 'reviewer', null, 'list_devices site=permitted outcome=failed', expect.any(String), 400]);
  });
});

it('redacts credential assignments, bearer tokens, private keys and URL credentials', () => {
  const text = safeText('password="some secret" token=secret Bearer abc123 https://user:pass@host/ -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----');
  expect(text).not.toMatch(/some secret|abc123|user:pass|-----BEGIN|token=secret/);
  expect(observation('2000-01-01T00:00:00Z').status).toBe('stale');
  expect(observation('invalid').status).toBe('unavailable');
});
