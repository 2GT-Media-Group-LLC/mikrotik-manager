/**
 * Session log (#415 step 2) against a real Postgres: the writer's insert and
 * continuation update, filters, and site scoping of the list and the switch.
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise.
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
import type { SessionRecord } from '../../services/netflow/sessions';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

const T0 = Date.now() - 60 * 60_000;

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    key: 'k', exporter: null, exporterLabel: null, protocol: 6,
    client: { addr: '192.168.1.10', port: 51000 }, server: { addr: '1.1.1.1', port: 443 },
    app: 'HTTPS', start: T0, end: T0 + 60_000,
    bytesOut: 100, bytesIn: 1_000, packetsOut: 2, packetsIn: 3,
    flagsOut: 0x12, flagsIn: 0x12, reason: 'aged-out', seenOut: true, seenIn: true,
    ...over,
  };
}

suite('session log (#415)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let store: typeof import('../../services/netflow/sessionStore');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-sessions-'));
  const id: Record<string, number> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;
  const fleetAdmin = () => ({ userId: 2, username: 'admin', role: 'admin' });

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_sessions';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-sessions-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    store = require('../../services/netflow/sessionStore');

    app = express();
    app.use(express.json());
    app.use('/api/sessions', require('../sessions').default);

    id.A = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    id.B = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    const device = (n: string, site: number) => one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ($1, $2, 'u', 'x', 'router', $3, 'offline') RETURNING id`, [n, `192.0.2.${site}`, site]);
    id.devA = await device('in-A', id.A);
    id.devB = await device('in-B', id.B);

    const ids = await store.writeSessions([
      { rec: rec({ clientNat: { addr: '203.0.113.5', port: 61000 } }), deviceId: id.devA, clientMac: 'aa:bb:cc:00:00:01' },
      { rec: rec({ server: { addr: '8.8.8.8', port: 53 }, protocol: 17, app: 'DNS', reason: 'no-reply', bytesIn: 0, flagsOut: null, flagsIn: null }), deviceId: id.devB, clientMac: null },
      { rec: rec({ exporterLabel: '172.24.1.15', reason: 'fin' }), deviceId: null, clientMac: null },
      // A device that no longer exists is left out, not a failed batch.
      { rec: rec({}), deviceId: 999_999, clientMac: null },
    ]);
    id.sA = ids[0]!;
    id.sB = ids[1]!;
  });

  afterAll(async () => { await db?.pool?.end?.(); });
  beforeEach(() => { currentUser = fleetAdmin(); });

  it('stores new sessions, and adds a later piece to its row', async () => {
    const rows = await db.query<{ device_id: number | null; exporter: string | null }>(`SELECT device_id, exporter FROM netflow_sessions ORDER BY id`);
    expect(rows).toEqual([
      { device_id: id.devA, exporter: null },
      { device_id: id.devB, exporter: null },
      { device_id: null, exporter: '172.24.1.15' },
    ]);
    await store.writeSessions([{ rec: rec({ rowId: id.sA, start: T0 + 60_000, end: T0 + 120_000, bytesOut: 5, bytesIn: 50, flagsOut: 0x13, reason: 'fin' }), deviceId: id.devA, clientMac: null }]);
    const [row] = await db.query<{ bytes_out: string; bytes_in: string; end_reason: string; flags_out: number; ended_at: Date; started_at: Date }>(
      `SELECT bytes_out, bytes_in, end_reason, flags_out, started_at, ended_at FROM netflow_sessions WHERE id = $1`, [id.sA]);
    expect(row).toMatchObject({ bytes_out: '105', bytes_in: '1050', end_reason: 'fin', flags_out: 0x13 });
    expect(row.started_at.getTime()).toBe(T0);
    expect(row.ended_at.getTime()).toBe(T0 + 120_000);
  });

  it('lists newest first, and filters by address (NAT too), port, protocol and ending', async () => {
    const all = await request(app).get('/api/sessions');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.sessions[0].bytes_out).toEqual(expect.any(Number));
    const nat = await request(app).get('/api/sessions').query({ address: '203.0.113.5' });
    expect(nat.body.sessions.map((s: { id: number }) => s.id)).toEqual([id.sA]);
    const dns = await request(app).get('/api/sessions').query({ port: '53', protocol: 'udp', reason: 'no-reply' });
    expect(dns.body.sessions.map((s: { id: number }) => s.id)).toEqual([id.sB]);
    for (const bad of [{ address: "1.1.1.1' OR 1=1" }, { port: '70000' }, { reason: 'gone' }, { protocol: 'nope' }, { limit: '9999' }]) {
      expect([(await request(app).get('/api/sessions').query(bad)).status, bad]).toEqual([400, bad]);
    }
  });

  it("shows a site-scoped account only its sites' sessions", async () => {
    currentUser = { userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } };
    const res = await request(app).get('/api/sessions');
    expect(res.body.sessions.map((s: { device_id: number }) => s.device_id)).toEqual([id.devA]);
    expect(res.body.total).toBe(1);
  });

  it('lets a writer in the device site turn the session log on, nobody else', async () => {
    currentUser = { userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } };
    expect((await request(app).put(`/api/sessions/devices/${id.devB}`).send({ enabled: true })).status).toBe(404);
    expect((await request(app).put(`/api/sessions/devices/${id.devA}`).send({ enabled: 'yes' })).status).toBe(400);
    expect((await request(app).put(`/api/sessions/devices/${id.devA}`).send({ enabled: true })).status).toBe(200);
    currentUser = { userId: 3, username: 'v', role: 'viewer', siteRoles: { [id.A]: 'viewer' } };
    expect((await request(app).put(`/api/sessions/devices/${id.devA}`).send({ enabled: false })).status).toBe(403);
    const flags = await db.query<{ id: number; netflow_sessions: boolean }>(`SELECT id, netflow_sessions FROM devices ORDER BY id`);
    expect(flags).toEqual([{ id: id.devA, netflow_sessions: true }, { id: id.devB, netflow_sessions: false }]);
  });
});
