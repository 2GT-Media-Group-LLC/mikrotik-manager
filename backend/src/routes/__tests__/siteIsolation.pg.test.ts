/**
 * Site-scoped accounts stay in their own sites, against a real Postgres
 * (GHSA-j9x4-qwcj-p8v8).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * Each request is one from the advisory: an id written so that the site check
 * and the handler used to read it differently ("20" in a list, 0x14, +5, 5x),
 * a second site check lifting the role, and security-check mutes that weren't
 * scoped at all. Site A is the account's (operator); B is not, or viewer.
 */
let currentUser: Record<string, unknown> = {};
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    // The account the test names, with the role the real middleware would
    // give it on a request that names no site: its highest.
    requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      const user = JSON.parse(JSON.stringify(currentUser)) as { role: string; siteRoles?: Record<string, string> };
      if (user.siteRoles) {
        const roles = Object.values(user.siteRoles);
        user.role = roles.includes('admin') ? 'admin' : roles.includes('operator') ? 'operator' : 'viewer';
      }
      req.user = user;
      next();
    },
  };
});
// No Redis here: every write succeeds (so device write locks are taken) and
// every read finds nothing.
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

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('site-scoped accounts stay in their sites (GHSA-j9x4-qwcj-p8v8)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-isolation-'));
  const id: Record<string, number> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;

  const operatorInA = () => ({ userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } });
  const operatorAViewerB = () => ({ userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator', [id.B]: 'viewer' } });
  const fleetAdmin = () => ({ userId: 2, username: 'admin', role: 'admin' });

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_isolation';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-isolation-key-0123456789abcdef0123456';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/devices', require('../devices').default);
    app.use('/api/backups', require('../backups').default);
    app.use('/api/firmware', require('../firmware').default);
    app.use('/api/wireless', require('../wireless').default);
    app.use('/api/network-services', require('../networkServices').default);
    app.use('/api/user-manager', require('../userManager').default);
    app.use('/api/commands', require('../commands').default);
    app.use('/api/tags', require('../tags').default);

    id.A = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    id.B = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    const device = (n: string, site: number) => one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ($1, $2, 'u', 'x', 'router', $3, 'offline') RETURNING id`, [n, `192.0.2.${site}`, site]);
    id.devA = await device('in-A', id.A);
    id.devB = await device('in-B', id.B);
    id.backupB = await one(`INSERT INTO backups (device_id, filename, file_path) VALUES ($1, 'b.rsc', '/nonexistent/b.rsc') RETURNING id`, [id.devB]);
    id.rolloutB = await one(`INSERT INTO firmware_rollouts (name) VALUES ('B rollout') RETURNING id`);
    await db.query(`INSERT INTO firmware_rollout_devices (rollout_id, device_id) VALUES ($1, $2)`, [id.rolloutB, id.devB]);
    id.tag = await one(`INSERT INTO tags (name) VALUES ('t') RETURNING id`);
    id.fleetMute = await one(`INSERT INTO security_check_suppressions (check_id, device_id) VALUES ('ssh-enabled', NULL) RETURNING id`);
    id.muteB = await one(`INSERT INTO security_check_suppressions (check_id, device_id) VALUES ('ssh-enabled', $1) RETURNING id`, [id.devB]);
  });

  afterAll(async () => { await db?.pool?.end?.(); });
  beforeEach(() => { currentUser = operatorInA(); });

  const hex = (n: number) => `0x${n.toString(16)}`;

  it('commands: running is for admins (#411)', async () => {
    const run = await request(app).post('/api/commands/runs').send({ command: '/system identity print', device_ids: [id.devA], start: false });
    expect(run.status).toBe(403);
  });

  it('commands: a device id sent as a string is still checked', async () => {
    // A site admin, so the site check is what answers, not the role (#411).
    currentUser = { userId: 1, username: 'sa', role: 'admin', siteRoles: { [id.A]: 'admin' } };
    for (const ids of [[String(id.devB)], [id.devB], [` ${id.devB}`], [`+${id.devB}`]]) {
      const run = await request(app).post('/api/commands/runs').send({ command: '/system identity print', device_ids: ids, start: false });
      expect([run.status, ids]).toEqual([404, ids]);
      const preview = await request(app).post('/api/commands/preview').send({ command: '/system identity print', device_ids: ids });
      expect([preview.status, ids]).toEqual([404, ids]);
    }
    const runs = await db.query(`SELECT 1 FROM command_run_devices WHERE device_id = $1`, [id.devB]);
    expect(runs).toHaveLength(0);
  });

  it('commands: a fleet account can still name devices by number or digit string', async () => {
    currentUser = fleetAdmin();
    const res = await request(app).post('/api/commands/preview').send({ command: '/system identity print', device_ids: [String(id.devA), id.devB] });
    expect(res.status).toBe(200);
    const bad = await request(app).post('/api/commands/preview').send({ command: '/system identity print', device_ids: [hex(id.devA)] });
    expect(bad.status).toBe(400);
  });

  it('network services: a hex ?deviceId= is refused, not read as 0', async () => {
    const res = await request(app).get(`/api/network-services/wireguard?deviceId=${hex(id.devB)}`);
    expect(res.status).toBe(400);
    const both = await request(app).post('/api/network-services/wireguard').query({ deviceId: id.devA }).send({ deviceId: id.devB });
    expect(both.status).toBe(400);
  });

  it('wireless: ?deviceId= for a device in A does not lift the role on a device in B', async () => {
    currentUser = operatorAViewerB();
    const res = await request(app).put(`/api/wireless/${id.devB}/interfaces/wlan1?deviceId=${id.devA}`).send({ ssid: 'x' });
    expect(res.status).toBe(403);
  });

  it('backups: a signed id is not found', async () => {
    for (const p of [`/api/backups/+${id.backupB}/download`, `/api/backups/+${id.backupB}/content`, `/api/backups/${id.backupB}/download`]) {
      const res = await request(app).get(p);
      expect([res.status, p]).toEqual([404, p]);
    }
    expect((await request(app).post(`/api/backups/+${id.backupB}/restore`)).status).toBe(404);
  });

  it('firmware: a suffixed rollout id is not found', async () => {
    for (const p of [`/api/firmware/rollouts/${id.rolloutB}x`, `/api/firmware/rollouts/${id.rolloutB}`]) {
      expect([(await request(app).get(p)).status, p]).toEqual([404, p]);
    }
    expect((await request(app).post(`/api/firmware/rollouts/${id.rolloutB}x/start`)).status).toBe(404);
    expect((await request(app).post(`/api/firmware/rollouts/${id.rolloutB}x/cancel`)).status).toBe(404);
    const status = await db.query<{ status: string }>(`SELECT status FROM firmware_rollouts WHERE id = $1`, [id.rolloutB]);
    expect(status[0].status).toBe('pending');
  });

  it('User Manager: a hex or signed device id is refused', async () => {
    for (const p of [`/api/user-manager/${hex(id.devB)}`, `/api/user-manager/+${id.devB}`]) {
      const res = await request(app).get(p);
      expect([[400, 404].includes(res.status), p]).toEqual([true, p]);
    }
  });

  it('tags: a malformed tag id or device list is refused', async () => {
    expect((await request(app).post(`/api/tags/+${id.tag}/devices`).send({ deviceIds: [id.devB] })).status).toBe(404);
    expect((await request(app).post(`/api/tags/${id.tag}/devices`).send({ deviceIds: [hex(id.devB)] })).status).toBe(404);
    expect((await request(app).post(`/api/tags/${id.tag}/devices`).send({ deviceIds: [id.devB] })).status).toBe(404);
    expect(await db.query(`SELECT 1 FROM device_tags WHERE device_id = $1`, [id.devB])).toHaveLength(0);
  });

  it('security-check mutes are scoped to the account\'s sites', async () => {
    const fleetWide = await request(app).post('/api/devices/security/suppressions').send({ check_id: 'api-enabled', device_id: null });
    expect(fleetWide.status).toBe(403);
    const foreign = await request(app).post('/api/devices/security/suppressions').send({ check_id: 'api-enabled', device_id: id.devB });
    expect(foreign.status).toBe(404);
    const own = await request(app).post('/api/devices/security/suppressions').send({ check_id: 'api-enabled', device_id: id.devA });
    expect(own.status).toBe(201);

    expect((await request(app).delete(`/api/devices/security/suppressions/${id.fleetMute}`)).status).toBe(404);
    expect((await request(app).delete(`/api/devices/security/suppressions/${id.muteB}`)).status).toBe(404);
    expect(await db.query(`SELECT 1 FROM security_check_suppressions WHERE id = ANY($1::int[])`, [[id.fleetMute, id.muteB]])).toHaveLength(2);

    const list = await request(app).get('/api/devices/security/suppressions');
    const devices = (list.body as Array<{ device_id: number | null }>).map((r) => r.device_id);
    expect(devices).not.toContain(id.devB);
    expect(devices).toContain(id.devA);

    currentUser = fleetAdmin();
    expect((await request(app).post('/api/devices/security/suppressions').send({ check_id: 'api-enabled', device_id: null })).status).toBe(201);
    expect((await request(app).post('/api/devices/security/suppressions').send({ check_id: 'x', device_id: '0x1' })).status).toBe(400);
  });
});
