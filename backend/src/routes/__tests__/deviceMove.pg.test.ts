/**
 * Moving a device to another address doesn't send its saved passwords there,
 * against a real Postgres (GHSA-63v6-w7qf-349f).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 *
 * An operator may move a device if they enter its API password, but any value
 * passed, and the saved SSH password then went to the new address. Now only
 * the passwords given with the move are used there.
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
const sshLogins: string[] = [];
const apiLogins: Array<{ host: string; password: string }> = [];
const routes: Array<number | null> = [];
jest.mock('../../services/sshOnly', () => ({
  ...jest.requireActual('../../services/sshOnly'),
  readSshInfo: jest.fn(async (d: { ssh_password_encrypted: string | null; jump_host_id: number | null }) => {
    const { decrypt } = jest.requireActual('../../utils/crypto');
    sshLogins.push(d.ssh_password_encrypted ? decrypt(d.ssh_password_encrypted) : '');
    routes.push(d.jump_host_id);
    return { identity: 'r', version: '7.25' };
  }),
}));
jest.mock('../../services/mikrotik/RouterOSClient', () => ({
  RouterOSClient: jest.fn().mockImplementation((host: string, _port: number, _user: string, password: string,
    _connectMs?: number, _readMs?: number, _tls?: boolean, jumpHostId: number | null = null) => ({
    connect: jest.fn(async () => { apiLogins.push({ host, password }); routes.push(jumpHostId); }),
    disconnect: jest.fn(),
  })),
}));
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

suite('moving a device keeps its saved passwords at the old address (GHSA-63v6-w7qf-349f)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let crypto: typeof import('../../utils/crypto');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-move-'));
  const id: Record<string, number> = {};
  const operator = () => ({ userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } });
  const fleetAdmin = () => ({ userId: 2, username: 'admin', role: 'admin' });

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_move';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-move-key-0123456789abcdef0123456789ab';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    crypto = require('../../utils/crypto');
    await require('../../db/migrate').runMigrations();
    app = express();
    app.use(express.json());
    app.use('/api/devices', require('../devices').default);
    id.A = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('A') RETURNING id`))[0].id;
  });

  afterAll(async () => { await db?.pool?.end?.(); fs.rmSync(dir, { recursive: true, force: true }); });

  beforeEach(async () => {
    sshLogins.length = 0;
    apiLogins.length = 0;
    routes.length = 0;
    await db.query(`DELETE FROM devices`);
    const add = async (n: string, sshOnly: boolean) => (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted, ssh_username, ssh_password_encrypted,
                            device_type, site_id, ssh_only, status)
       VALUES ($1, $2, 8729, 'admin', $3, 'admin', $4, 'router', $5, $6, 'online') RETURNING id`,
      [n, sshOnly ? '192.0.2.2' : '192.0.2.1', crypto.encrypt('API-SECRET'), crypto.encrypt('SSH-SECRET'), id.A, sshOnly]))[0].id;
    id.dev = await add('api', false);
    id.sshOnly = await add('ssh-only', true);
  });

  const sshPassword = async (deviceId: number) => {
    const row = (await db.query<{ p: string | null }>(`SELECT ssh_password_encrypted AS p FROM devices WHERE id = $1`, [deviceId]))[0];
    return row.p ? crypto.decrypt(row.p) : null;
  };

  it.each(['dev', 'sshOnly'])('does not manually sync a pending force-added %s device', async (key) => {
    currentUser = operator();
    await db.query("UPDATE devices SET status = 'unknown', force_add_pending = TRUE WHERE id = $1", [id[key]]);
    const res = await request(app).post(`/api/devices/${id[key]}/sync`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/first successful poll/);
    expect(apiLogins).toEqual([]);
    expect(sshLogins).toEqual([]);
    expect((await db.query<{ force_add_pending: boolean }>(
      'SELECT force_add_pending FROM devices WHERE id = $1', [id[key]],
    ))[0].force_add_pending).toBe(true);
  });

  it('does not check the API before a pending SSH-only device has been polled', async () => {
    currentUser = operator();
    await db.query("UPDATE devices SET status = 'unknown', force_add_pending = TRUE WHERE id = $1", [id.sshOnly]);
    const res = await request(app).post(`/api/devices/${id.sshOnly}/check-api`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/first SSH poll/);
    expect(apiLogins).toEqual([]);
    expect(sshLogins).toEqual([]);
  });

  it('still reports an API-managed device as such while it is pending', async () => {
    currentUser = operator();
    await db.query("UPDATE devices SET status = 'unknown', force_add_pending = TRUE WHERE id = $1", [id.dev]);
    const res = await request(app).post(`/api/devices/${id.dev}/check-api`).send({});
    expect(res.status).toBe(200);
    expect(res.body.api).toBe(true);
    expect(apiLogins).toEqual([]);
  });

  it('an operator must enter a password to move a device', async () => {
    currentUser = operator();
    const res = await request(app).put(`/api/devices/${id.dev}`).send({ ip_address: '10.0.0.66' });
    expect(res.status).toBe(400);
    expect(apiLogins).toEqual([]);
  });

  it("an operator's move sends only the entered password, and drops the saved SSH one", async () => {
    currentUser = operator();
    const res = await request(app).put(`/api/devices/${id.dev}`).send({ ip_address: '10.0.0.66', api_password: 'typed' });
    expect(res.status).toBe(200);
    expect(apiLogins).toEqual([{ host: '10.0.0.66', password: 'typed' }]);
    expect(await sshPassword(id.dev)).toBeNull();
  });

  it("an SSH-only device's move logs in over SSH with the entered password, not the saved one", async () => {
    currentUser = operator();
    const res = await request(app).put(`/api/devices/${id.sshOnly}`).send({ ip_address: '10.0.0.66', api_password: 'typed' });
    expect(res.status).toBe(200);
    expect(sshLogins).toEqual(['typed']);
    expect(await sshPassword(id.sshOnly)).toBeNull();
  });

  it('an SSH password entered with the move is kept', async () => {
    currentUser = operator();
    await request(app).put(`/api/devices/${id.dev}`).send({ ip_address: '10.0.0.66', api_password: 'typed', ssh_password: 'ssh-typed' });
    expect(await sshPassword(id.dev)).toBe('ssh-typed');
  });

  it('a fleet admin may still move a device with its saved passwords', async () => {
    currentUser = fleetAdmin();
    const res = await request(app).put(`/api/devices/${id.dev}`).send({ ip_address: '10.0.0.67' });
    expect(res.status).toBe(200);
    expect(apiLogins).toEqual([{ host: '10.0.0.67', password: 'API-SECRET' }]);
    expect(await sshPassword(id.dev)).toBe('SSH-SECRET');
  });

  it('editing without moving leaves the saved SSH password alone', async () => {
    currentUser = operator();
    await request(app).put(`/api/devices/${id.dev}`).send({ notes: 'hello' });
    expect(await sshPassword(id.dev)).toBe('SSH-SECRET');
  });

  // Jump hosts: the same address behind another jump host can be another
  // router, so a new route is a move too, and the same rules apply.
  describe('moving a device behind a jump host', () => {
    beforeEach(async () => {
      await db.query(`DELETE FROM jump_hosts`);
      id.jump = (await db.query<{ id: number }>(
        `INSERT INTO jump_hosts (name, host, port, username, password_encrypted) VALUES ('gw', '203.0.113.10', 22, 'jump', $1) RETURNING id`,
        [crypto.encrypt('JUMP-SECRET')]))[0].id;
    });
    const route = async (deviceId: number) =>
      (await db.query<{ j: number | null }>(`SELECT jump_host_id AS j FROM devices WHERE id = $1`, [deviceId]))[0].j;

    it('an operator must enter a password for it', async () => {
      currentUser = operator();
      const res = await request(app).put(`/api/devices/${id.dev}`).send({ jump_host_id: id.jump });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_required_for_address_change');
      expect(apiLogins).toEqual([]);
      expect(await route(id.dev)).toBeNull();
    });

    it("an operator's move sends only the entered password, through the jump host, and drops the saved SSH one", async () => {
      currentUser = operator();
      const res = await request(app).put(`/api/devices/${id.dev}`).send({ jump_host_id: id.jump, api_password: 'typed' });
      expect(res.status).toBe(200);
      expect(apiLogins).toEqual([{ host: '192.0.2.1', password: 'typed' }]);
      expect(routes).toEqual([id.jump]);
      expect(await sshPassword(id.dev)).toBeNull();
      expect(await route(id.dev)).toBe(id.jump);
    });

    it('an SSH-only device logs in over SSH through it with the entered password', async () => {
      currentUser = operator();
      const res = await request(app).put(`/api/devices/${id.sshOnly}`).send({ jump_host_id: id.jump, api_password: 'typed' });
      expect(res.status).toBe(200);
      expect(sshLogins).toEqual(['typed']);
      expect(routes).toEqual([id.jump]);
      expect(await sshPassword(id.sshOnly)).toBeNull();
    });

    it('a fleet admin may move it with its saved passwords', async () => {
      currentUser = fleetAdmin();
      const res = await request(app).put(`/api/devices/${id.dev}`).send({ jump_host_id: id.jump });
      expect(res.status).toBe(200);
      expect(apiLogins).toEqual([{ host: '192.0.2.1', password: 'API-SECRET' }]);
      expect(await sshPassword(id.dev)).toBe('SSH-SECRET');
      expect(await route(id.dev)).toBe(id.jump);
    });
  });
});
