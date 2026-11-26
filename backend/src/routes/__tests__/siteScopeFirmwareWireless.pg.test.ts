/**
 * Firmware and wireless routes keep to the account's role and sites, against a
 * real Postgres (GHSA-mcr6-fpx6-h5p9).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * The account is held to its sites the way requireAuth does it: a site-scoped
 * account's request covers its own sites, under its highest role there.
 */
let currentUser: Record<string, unknown> = {};
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAuth: (req: { user?: unknown; siteId?: unknown }, _res: unknown, next: () => void) => {
      const user = JSON.parse(JSON.stringify(currentUser)) as { role: string; siteRoles?: Record<string, string> };
      if (user.siteRoles) {
        user.role = actual.highestRole(Object.values(user.siteRoles));
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
const fluxSeen: string[] = [];
jest.mock('../../config/influxdb', () => ({
  getQueryApi: () => ({
    queryRows: (flux: string, h: { complete: () => void }) => { fluxSeen.push(flux); h.complete(); },
  }),
  getWriteApi: jest.fn(),
  bucket: 'test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import request from 'supertest';
import express from 'express';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('firmware and wireless keep to role and site (GHSA-mcr6-fpx6-h5p9)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let access: typeof import('../../utils/rolloutAccess');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-mcr6-'));
  const id: Record<string, number> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;

  const operatorInA = () => ({ userId: id.op, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } });
  const adminInA = () => ({ userId: id.sa, username: 'sa', role: 'admin', siteRoles: { [id.A]: 'admin' } });
  const fleetAdmin = () => ({ userId: id.fa, username: 'fa', role: 'admin' });

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_mcr6';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-mcr6-key-0123456789abcdef0123456789ab';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    access = require('../../utils/rolloutAccess');

    app = express();
    app.use(express.json());
    app.use('/api/firmware/mirrors', require('../firmwareMirror').default);
    app.use('/api/firmware', require('../firmware').default);
    app.use('/api/wireless', require('../wireless').default);

    id.A = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    id.B = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    const device = (n: string, site: number, wifiRole: string | null = null) => one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status, wifi_role)
       VALUES ($1, $2, 'u', 'x', 'router', $3, 'offline', $4) RETURNING id`, [n, `192.0.2.${10 + site}`, site, wifiRole]);
    id.devA = await device('in-A', id.A, 'controller');
    id.devB = await device('cap-in-B', id.B);
    const user = (n: string, role: string) => one(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2) RETURNING id`, [n, role]);
    id.op = await user('op', 'operator');
    id.sa = await user('sa', 'admin');
    id.fa = await user('fa', 'admin');
    await db.query(`INSERT INTO user_site_roles (user_id, site_id, role) VALUES ($1, $2, 'operator')`, [id.op, id.A]);
    await db.query(`INSERT INTO user_site_roles (user_id, site_id, role) VALUES ($1, $2, 'admin')`, [id.sa, id.A]);
  });

  afterAll(async () => { await db?.pool?.end?.(); });
  beforeEach(() => { currentUser = operatorInA(); });

  const rollout = async (devices: number[], opts: { post?: string; createdBy?: number | null } = {}) => {
    const r = await one(
      `INSERT INTO firmware_rollouts (name, post_command, created_by_user_id) VALUES ('r', $1, $2) RETURNING id`,
      [opts.post ?? null, opts.createdBy ?? null]);
    for (const d of devices) await db.query(`INSERT INTO firmware_rollout_devices (rollout_id, device_id) VALUES ($1, $2)`, [r, d]);
    return r;
  };
  const statusOf = async (r: number) => (await db.query<{ status: string }>(`SELECT status FROM firmware_rollouts WHERE id = $1`, [r]))[0].status;

  it('an operator cannot start a rollout that holds post-upgrade commands', async () => {
    const r = await rollout([id.devA], { post: '/system identity print' });
    currentUser = operatorInA();
    expect((await request(app).post(`/api/firmware/rollouts/${r}/start`)).status).toBe(403);
    currentUser = { userId: id.op, username: 'op', role: 'operator' };
    expect((await request(app).post(`/api/firmware/rollouts/${r}/start`)).status).toBe(403);
    expect(await statusOf(r)).toBe('pending');
    // An admin of every device in it may, and an operator may start one without commands.
    expect(await access.rolloutRefusal(adminInA() as never, [id.devA], true)).toBeNull();
    expect(await access.rolloutRefusal(operatorInA() as never, [id.devA], false)).toBeNull();
    expect(await access.rolloutRefusal(operatorInA() as never, [id.devA, id.devB], false)).not.toBeNull();
  });

  it('a scheduled rollout is checked against its creator when it comes due', async () => {
    // From before creators were recorded: runs as it always did.
    expect(await access.scheduledRolloutRefusal(await rollout([id.devA]))).toBeNull();
    const mine = await rollout([id.devA], { createdBy: id.op });
    expect(await access.scheduledRolloutRefusal(mine)).toBeNull();
    // The creator is now a viewer in A.
    await db.query(`UPDATE user_site_roles SET role = 'viewer' WHERE user_id = $1 AND site_id = $2`, [id.op, id.A]);
    expect(await access.scheduledRolloutRefusal(mine)).toMatch(/op scheduled it and no longer can/);
    await db.query(`UPDATE user_site_roles SET role = 'operator' WHERE user_id = $1 AND site_id = $2`, [id.op, id.A]);
    // A device in it has moved to a site the creator isn't in.
    expect(await access.scheduledRolloutRefusal(await rollout([id.devA, id.devB], { createdBy: id.op }))).not.toBeNull();
    // Post-upgrade commands from an operator, and a creator since removed.
    expect(await access.scheduledRolloutRefusal(await rollout([id.devA], { createdBy: id.op, post: '/x' }))).toMatch(/admin access/);
    expect(await access.scheduledRolloutRefusal(await rollout([id.devA], { createdBy: 999_999 }))).toMatch(/removed/);
  });

  it('a new rollout records who made it', async () => {
    currentUser = fleetAdmin();
    const fresh = await one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ('fresh', '192.0.2.50', 'u', 'x', 'router', $1, 'offline') RETURNING id`, [id.A]);
    const res = await request(app).post('/api/firmware/rollouts').send({ name: 'n', devices: [{ device_id: fresh, wave: 1 }] });
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBeLessThan(300);
    const rows = await db.query<{ created_by_user_id: number }>(`SELECT created_by_user_id FROM firmware_rollouts WHERE name = 'n'`);
    expect(rows[0].created_by_user_id).toBe(id.fa);
  });

  it('TX quality without a device is held to the account\'s sites', async () => {
    fluxSeen.length = 0;
    expect((await request(app).get('/api/wireless/rf/tx-quality')).status).toBe(200);
    expect(fluxSeen[0]).toContain(`r.device_id == "${id.devA}"`);
    expect(fluxSeen[0]).not.toContain(`"${id.devB}"`);
    currentUser = fleetAdmin();
    fluxSeen.length = 0;
    await request(app).get('/api/wireless/rf/tx-quality');
    expect(fluxSeen[0]).not.toContain('r.device_id ==');
  });

  it('CAPsMAN under a controller in A does not show a CAP that is in B', async () => {
    await db.query(
      `INSERT INTO capsman_radios (controller_device_id, radio_mac, interface_name, local, matched_device_id, ssid)
       VALUES ($1, 'AA:BB:CC:00:00:01', 'cap1', FALSE, $2, 'ctrl-ssid')`, [id.devA, id.devB]);
    await db.query(
      `INSERT INTO wireless_interfaces (device_id, name, ssid, radio_mac, managed_by_capsman)
       VALUES ($1, 'wlan1', 'b-only-ssid', 'AA:BB:CC:00:00:01', TRUE)`, [id.devB]);
    const scoped = await request(app).get('/api/wireless/capsman');
    expect(scoped.status).toBe(200);
    expect(JSON.stringify(scoped.body)).toContain('cap1');
    expect(JSON.stringify(scoped.body)).not.toContain('cap-in-B');
    expect(JSON.stringify(scoped.body)).not.toContain('b-only-ssid');
    currentUser = fleetAdmin();
    expect(JSON.stringify((await request(app).get('/api/wireless/capsman')).body)).toContain('cap-in-B');
  });

  it('a mirror is managed by the sites its server and clients are in now', async () => {
    const mirror = await one(`INSERT INTO firmware_mirrors (device_id, site_id, status) VALUES ($1, $2, 'ready') RETURNING id`, [id.devA, id.A]);
    // A client that has since moved to B is left alone when A's admin changes the address.
    await db.query(`INSERT INTO firmware_mirror_clients (device_id, mirror_id, status) VALUES ($1, $2, 'ok')`, [id.devB, mirror]);
    currentUser = adminInA();
    const put = await request(app).put(`/api/firmware/mirrors/${mirror}`).send({ serve_address: '192.0.2.99' });
    expect(put.status).toBe(200);
    expect(put.body.clients).toBeNull();
    // The server itself moved to B: A's admin can no longer change the mirror.
    await db.query(`UPDATE devices SET site_id = $1 WHERE id = $2`, [id.B, id.devA]);
    expect((await request(app).put(`/api/firmware/mirrors/${mirror}`).send({ keep_versions: 2 })).status).toBe(403);
    expect((await request(app).post(`/api/firmware/mirrors/${mirror}/sync`)).status).toBe(403);
    expect((await request(app).post(`/api/firmware/mirrors/${mirror}/deploy`)).status).toBe(403);
    await db.query(`UPDATE devices SET site_id = $1 WHERE id = $2`, [id.A, id.devA]);
  });
});
