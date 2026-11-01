jest.mock('../../config/database');
jest.mock('../../config/redis', () => ({
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
  },
  // The rate limiters' connection: every request is the first in its window.
  limiterRedis: () => ({ eval: jest.fn().mockResolvedValue([1, 60_000]) }),
}));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/crypto', () => ({ encrypt: (s: string) => `enc:${s}` }));
jest.mock('../../services/AlertService', () => ({ alertService: { dispatch: jest.fn() } }));
jest.mock('../../services/jumpHosts', () => ({
  ...jest.requireActual('../../services/jumpHosts'),
  dropJumpHost: jest.fn(),
  jumpHostStatus: jest.fn(() => ({ state: 'idle' })),
  testJumpHost: jest.fn(),
  trustNewJumpHostKey: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import { utils as sshUtils } from 'ssh2';
import jumpHostsRoutes from '../jumpHosts';
import { query, queryOne } from '../../config/database';
import { dropJumpHost, chooseJumpHost } from '../../services/jumpHosts';

const mockedQuery = jest.mocked(query);
const mockedQueryOne = jest.mocked(queryOne);

type User = { userId: number; username: string; role: string; siteRoles?: Record<number, string> };

function makeApp(user: User) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as express.Request & { user?: User }).user = user; next(); });
  app.use('/', jumpHostsRoutes);
  return app;
}
const fleetAdmin: User = { userId: 1, username: 'admin', role: 'admin' };
const operator: User = { userId: 2, username: 'op', role: 'operator' };
const siteAdmin: User = { userId: 3, username: 'sa', role: 'operator', siteRoles: { 5: 'admin' } };

const HEX = 'ab'.repeat(32);
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, name: 'core-rtr', site_id: null, site_name: null, host: '203.0.113.10', port: 22, username: 'jump',
  password_encrypted: 'enc:secret', private_key_encrypted: null, passphrase_encrypted: null,
  credential_preset_id: null, preset_name: null, host_key_fingerprint: HEX, seen_host_key_fingerprint: null,
  host_key_mismatch_at: null, notes: null, device_count: '0', created_at: 'now', updated_at: 'now', ...over,
});

/** queryOne answers by the SQL it's given. */
function answer(map: Array<[RegExp, unknown]>) {
  mockedQueryOne.mockImplementation((async (sql: string) => {
    for (const [re, v] of map) if (re.test(sql)) return v;
    return null;
  }) as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedQuery.mockResolvedValue([] as never);
});

describe('GET /', () => {
  it('never returns a secret, only which ones are set', async () => {
    mockedQuery.mockResolvedValueOnce([row({ private_key_encrypted: 'enc:KEY', passphrase_encrypted: 'enc:PASS' })] as never);
    const res = await request(makeApp(operator)).get('/');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/enc:|secret|KEY|PASS/);
    expect(res.body[0]).toMatchObject({ has_password: true, has_private_key: true, can_manage: false, status: 'idle' });
    expect(res.body[0].host_key_fingerprint).toMatch(/^SHA256:/);
  });

  it("shows a site-scoped account its own site's jump hosts and fleet-wide ones, not another site's", async () => {
    mockedQuery.mockResolvedValueOnce([row({ id: 1 }), row({ id: 2, site_id: 5 }), row({ id: 3, site_id: 6 })] as never);
    const res = await request(makeApp(siteAdmin)).get('/');
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });
});

describe('POST /', () => {
  const base = { name: 'core-rtr', host: '203.0.113.10', username: 'jump' };

  it('is for admins', async () => {
    const res = await request(makeApp(operator)).post('/').send({ ...base, password: 'x' });
    expect(res.status).toBe(403);
  });

  it('takes exactly one login: a password, a key or a preset', async () => {
    const app = makeApp(fleetAdmin);
    expect((await request(app).post('/').send(base)).status).toBe(400);
    const key = sshUtils.generateKeyPairSync('ed25519').private;
    const both = await request(app).post('/').send({ ...base, password: 'x', private_key: key });
    expect(both.status).toBe(400);
    expect(both.body.error).toMatch(/exactly one/);
  });

  it('refuses a private key it cannot read', async () => {
    const res = await request(makeApp(fleetAdmin)).post('/').send({ ...base, private_key: 'not a key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private key could not be read/);
  });

  it('stores the password encrypted and a pasted fingerprint as hex', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    mockedQuery.mockResolvedValueOnce([{ id: 7 }] as never);
    const b64 = Buffer.from(HEX, 'hex').toString('base64').replace(/=+$/, '');
    const res = await request(makeApp(fleetAdmin)).post('/').send({ ...base, password: 'secret', host_key_fingerprint: `SHA256:${b64}` });
    expect(res.status).toBe(201);
    const insert = mockedQuery.mock.calls.find(([sql]) => /INSERT INTO jump_hosts/.test(String(sql)))!;
    expect(insert[1]).toEqual(['core-rtr', null, '203.0.113.10', 22, 'jump', 'enc:secret', null, null, null, HEX, null]);
  });

  it("won't let a site admin make a fleet-wide one", async () => {
    const res = await request(makeApp(siteAdmin)).post('/').send({ ...base, password: 'x', site_id: null });
    expect(res.status).toBe(403);
  });

  it('stores an address as a device address is read: no brackets, and a port in it is the SSH port', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    mockedQuery.mockResolvedValue([{ id: 7 }] as never);
    const app = makeApp(fleetAdmin);
    expect((await request(app).post('/').send({ ...base, host: '[2001:db8::1]', password: 'x' })).status).toBe(201);
    expect((await request(app).post('/').send({ ...base, host: 'GW.example.com:2222', password: 'x' })).status).toBe(201);
    const inserts = mockedQuery.mock.calls.filter(([sql]) => /INSERT INTO jump_hosts/.test(String(sql))).map(([, p]) => (p as unknown[]).slice(2, 4));
    expect(inserts).toEqual([['2001:db8::1', 22], ['gw.example.com', 2222]]);
    const clash = await request(app).post('/').send({ ...base, host: '203.0.113.10:2222', port: 22, password: 'x' });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toMatch(/includes port 2222, but the SSH port is 22/);
    for (const host of ['203.0.113.10:99999', '203.0.113.10:99999999999']) {
      const outOfRange = await request(app).post('/').send({ ...base, host, password: 'x' });
      expect(outOfRange.status).toBe(400);
      expect(outOfRange.body.error).toMatch(/port in the address must be a number from 1 to 65535/);
    }
    expect(mockedQuery.mock.calls.filter(([sql]) => /INSERT INTO jump_hosts/.test(String(sql)))).toHaveLength(2);
  });

  it("refuses another site's credential preset", async () => {
    answer([[/FROM sites WHERE id/, { id: 5 }], [/FROM credential_presets WHERE id/, { site_id: 6, allow_operator_use: true }]]);
    const res = await request(makeApp(siteAdmin)).post('/').send({ name: 'r', host: '10.0.0.1', site_id: 5, credential_preset_id: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/another site/);
  });
});

describe('PUT /:id', () => {
  it('pins the key afresh when the address changes, and drops the open connection', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    const res = await request(makeApp(fleetAdmin)).put('/7').send({ host: '203.0.113.99' });
    expect(res.status).toBe(200);
    const update = mockedQuery.mock.calls.find(([sql]) => /UPDATE jump_hosts SET/.test(String(sql)))!;
    const params = update[1] as unknown[];
    expect(params[13]).toBeNull(); // no fingerprint given
    expect(params[14]).toBe(true); // moved: clear the pin
    expect(dropJumpHost).toHaveBeenCalledWith(7);
  });

  it("won't move into one site while other sites have it as their default", async () => {
    answer([[/default_jump_host_id/, { devices: '0', sites: '1' }], [/FROM sites WHERE id/, { id: 5 }], [/FROM jump_hosts j/, row()]]);
    const res = await request(makeApp(fleetAdmin)).put('/7').send({ site_id: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/other sites have it as their default/);
    expect(mockedQuery.mock.calls.some(([sql]) => /UPDATE jump_hosts SET/.test(String(sql)))).toBe(false);
  });

  it("won't move to another site with the preset it logs in with, if that site can't use it", async () => {
    answer([
      [/default_jump_host_id/, { devices: '0', sites: '0' }], [/FROM sites WHERE id/, { id: 6 }],
      [/FROM credential_presets WHERE id/, { site_id: 5, allow_operator_use: true }],
      [/FROM jump_hosts j/, row({ site_id: 5, credential_preset_id: 3, password_encrypted: null, username: null })],
    ]);
    const res = await request(makeApp(fleetAdmin)).put('/7').send({ site_id: 6 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/another site/);
  });

  it('keeps the pin, and the open connection with the sessions through it, for a change of name or notes', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    // As the form sends it: everything, the address and login unchanged.
    await request(makeApp(fleetAdmin)).put('/7').send({ name: 'edge', notes: 'rack 4', site_id: null, host: '203.0.113.10', port: 22, username: 'jump' });
    const params = mockedQuery.mock.calls.find(([sql]) => /UPDATE jump_hosts SET/.test(String(sql)))![1] as unknown[];
    expect(params[14]).toBe(false);
    expect(dropJumpHost).not.toHaveBeenCalled();
  });

  it('reconnects for a new login', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    await request(makeApp(fleetAdmin)).put('/7').send({ password: 'new-secret' });
    expect(dropJumpHost).toHaveBeenCalledWith(7);
  });
});

describe('DELETE /:id', () => {
  it('is refused while devices are reached through it', async () => {
    answer([[/FROM jump_hosts j/, row({ device_count: '3' })]]);
    const res = await request(makeApp(fleetAdmin)).delete('/7');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('jump_host_in_use');
    expect(mockedQuery.mock.calls.some(([sql]) => /DELETE FROM jump_hosts/.test(String(sql)))).toBe(false);
  });

  it('deletes one nothing uses, and closes its connection', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    const res = await request(makeApp(fleetAdmin)).delete('/7');
    expect(res.status).toBe(200);
    expect(dropJumpHost).toHaveBeenCalledWith(7);
  });

  it("is not found for an account that can't see it", async () => {
    answer([[/FROM jump_hosts j/, row({ site_id: 6 })]]);
    expect((await request(makeApp(siteAdmin)).delete('/7')).status).toBe(404);
  });
});

// GHSA-j9x4-qwcj-p8v8: ids are digits only, as upstream reads them everywhere.
describe('ids are read strictly', () => {
  it('finds no jump host for a path id that only starts with digits', async () => {
    answer([[/FROM jump_hosts j/, row()]]);
    const app = makeApp(fleetAdmin);
    for (const id of ['7abc', '0x7', '7.0', '-7', '1e1']) {
      expect((await request(app).put(`/${id}`).send({ name: 'x' })).status).toBe(404);
      expect((await request(app).delete(`/${id}`)).status).toBe(404);
    }
    expect(mockedQuery.mock.calls.some(([sql]) => /UPDATE jump_hosts|DELETE FROM jump_hosts/.test(String(sql)))).toBe(false);
  });

  it('refuses a site or credential preset id that is not one', async () => {
    answer([[/FROM sites WHERE id/, { id: 5 }], [/FROM credential_presets WHERE id/, { site_id: null, allow_operator_use: true }]]);
    const app = makeApp(fleetAdmin);
    for (const site_id of ['5x', '0x5', true, 5.5]) {
      const res = await request(app).post('/').send({ name: 'r', host: '10.0.0.1', username: 'u', password: 'p', site_id });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Unknown site');
    }
    const preset = await request(app).post('/').send({ name: 'r', host: '10.0.0.1', site_id: 5, credential_preset_id: '9abc' });
    expect(preset.status).toBe(400);
    expect(preset.body.error).toMatch(/credential preset id/);
  });

  it("refuses a device's jump_host_id that is not an id", async () => {
    answer([[/FROM jump_hosts WHERE id/, { site_id: null }]]);
    for (const v of ['7abc', '0x7', '1e0', true, 7.5]) {
      await expect(chooseJumpHost(v, null, { siteDefault: false })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/must be a jump host id/) });
    }
    await expect(chooseJumpHost('7', null, { siteDefault: false })).resolves.toBe(7);
    await expect(chooseJumpHost(7, null, { siteDefault: false })).resolves.toBe(7);
  });
});
