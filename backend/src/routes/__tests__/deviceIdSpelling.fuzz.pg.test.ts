/**
 * Fuzzing device-id spellings against the real device routers and Postgres.
 * A viewer limited to one site asks for a device in another site under every
 * spelling of its id the generator can think of: encoded spaces and signs,
 * leading zeros, look-alike digits, trailing junk, odd case and slashes.
 * Express decodes the path, Postgres reads the id leniently (" 20" is 20),
 * so a router whose site check and handler read the id differently would
 * hand the device over (GHSA-6xq3-q9m5-7hxp, GHSA-j9x4-qwcj-p8v8). No spelling
 * may.
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one).
 */
let currentUser: Record<string, unknown> = {};
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    // As the real middleware leaves a site-scoped account with no site chosen:
    // its sites as the scope, its highest role.
    requireAuth: (req: { user?: unknown; siteId?: unknown }, _res: unknown, next: () => void) => {
      const user = JSON.parse(JSON.stringify(currentUser)) as { role: string; siteRoles?: Record<string, string> };
      if (user.siteRoles) {
        const roles = Object.values(user.siteRoles);
        user.role = roles.includes('admin') ? 'admin' : roles.includes('operator') ? 'operator' : 'viewer';
        req.siteId = Object.keys(user.siteRoles).map(Number);
      }
      req.user = user;
      next();
    },
  };
});
jest.mock('../../config/redis', () => {
  const stub = (): unknown => new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'status' ? 'ready'
      : () => Promise.resolve(prop === 'set' ? 'OK' : null)),
  });
  return { redis: stub(), limiterRedis: () => stub(), createRedisConnection: () => stub() };
});
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), getWriteApi: jest.fn(), bucket: 'test' }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import request from 'supertest';
import express from 'express';
import fc from 'fast-check';
import { fuzz, FUZZ_RUNS, FUZZ_TIMEOUT_MS, HTTP_RUNS } from '../../test/fuzz';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(Math.max(FUZZ_TIMEOUT_MS, 120_000));

const SECRET = 'fuzz-other-site-router';
const SECRET_PORT = 'fuzz-secret-port';

suite('device id spellings can\'t cross sites (fuzz)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-idfuzz-'));
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_idfuzz';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-idfuzz-key-0123456789abcdef0123456789';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/devices', require('../devices').default);
    app.use('/api/config-history', require('../configHistory').default);

    const siteA = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    const siteB = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    // Fixed ids, so the generator can spell them: 20 in site A, 21 in site B.
    await db.query(`INSERT INTO devices (id, name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
      VALUES (20, $1, '192.0.2.20', 'u', 'x', 'router', $2, 'online'), (21, 'mine', '192.0.2.21', 'u', 'x', 'router', $3, 'online')`, [SECRET, siteA, siteB]);
    await db.query(`INSERT INTO interfaces (device_id, name, type) VALUES (20, $1, 'ether'), (21, 'ether1', 'ether')`, [SECRET_PORT]);
    await db.query(`INSERT INTO device_configs (device_id, config_hash, change_summary, config_json) VALUES (20, 'h', $1, '{}')`, [SECRET]);
    currentUser = { userId: 9, username: 'b-viewer', role: 'viewer', siteRoles: { [siteB]: 'viewer' } };
  });

  afterAll(async () => { await db?.pool?.end?.(); fs.rmSync(dir, { recursive: true, force: true }); });

  const junk = fc.constantFrom('', '+', '-', ' ', '%20', '%2B', '%2D', '%09', '%0A', '%0B', '%0C', '%0D', '%C2%A0', '%00', '0', '%30',
    '.', '%2E', 'x', 'e0', '_', ';', ',', '%3B', '%25', '%');
  const twenty = fc.constantFrom('20', '020', '0020', '2%30', '%32%30', '%32%300', '%EF%BC%92%EF%BC%90', '20.0', '2e1', '0x14', '2_0');
  const seg = fc.tuple(fc.array(junk, { maxLength: 3 }), twenty, fc.array(junk, { maxLength: 3 })).map(([a, t, b]) => a.join('') + t + b.join(''));
  const route = fc.constantFrom('/api/devices/{}', '/api/devices/{}/', '/api/devices/{}/ports', '/api/devices/{}/interfaces',
    '/api/DEVICES/{}/PORTS', '/api/devices/{}/ports/', '/api/config-history/{}', '/api/config-history/{}/');

  it('the plain id is refused, and the viewer\'s own device is not', async () => {
    expect((await request(app).get('/api/devices/20/ports')).status).toBe(404);
    expect((await request(app).get('/api/devices/21/ports')).status).toBe(200);
  });

  it('no spelling of another site\'s device id reaches it', async () => {
    await fc.assert(fc.asyncProperty(seg, route, async (s, r) => {
      const url = r.replace('{}', s);
      const res = await request(app).get(url);
      const body = JSON.stringify(res.body ?? '') + (res.text ?? '');
      expect({ url, status: res.status, leaked: body.includes(SECRET) || body.includes(SECRET_PORT) })
        .toEqual({ url, status: res.status, leaked: false });
      expect({ url, ok: res.status >= 200 && res.status < 300 }).toEqual({ url, ok: false });
    }), fuzz({ numRuns: Math.min(FUZZ_RUNS, HTTP_RUNS) }));
  });
});
