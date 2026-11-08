/**
 * Scheduled bulk commands (#359) against a real Postgres: what a due schedule
 * runs on, when it's missed instead, maintenance windows, and running as its
 * creator. SSH is faked: a device named "bad…" fails.
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one).
 */
let currentUser: Record<string, unknown> = {};
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      const user = JSON.parse(JSON.stringify(currentUser)) as { role: string; siteRoles?: Record<string, string> };
      if (user.siteRoles) { const r = Object.values(user.siteRoles); user.role = r.includes('admin') ? 'admin' : r.includes('operator') ? 'operator' : 'viewer'; }
      req.user = user;
      next();
    },
  };
});
jest.mock('../../config/redis', () => {
  const stub = (): unknown => new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'status' ? 'ready' : () => Promise.resolve(prop === 'set' ? 'OK' : null)),
  });
  return { redis: stub(), limiterRedis: () => stub(), createRedisConnection: () => stub() };
});
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), getWriteApi: jest.fn(), bucket: 'test' }));
const ran: string[] = [];
jest.mock('../sshExec', () => ({
  ...jest.requireActual('../sshExec'),
  runSshCommand: jest.fn(async (d: { name: string }) => {
    ran.push(d.name);
    return { output: d.name.startsWith('bad') ? 'failure: nope' : 'ok' };
  }),
}));
const alerts: string[] = [];
jest.mock('../AlertService', () => ({ alertService: { dispatch: jest.fn(async (_t: string, msg: string) => { alerts.push(msg); }) } }));

import { Client } from 'pg';
import request from 'supertest';
import express from 'express';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('scheduled bulk commands (#359)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let scheduler: typeof import('../CommandScheduler')['commandScheduler'];
  let app: express.Express;
  const id: Record<string, number> = {};

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_schedules';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.ENCRYPTION_KEY = 'e2e-sched-key-0123456789abcdef0123456789ab';
    jest.resetModules();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    scheduler = require('../CommandScheduler').commandScheduler;
    app = express();
    app.use(express.json());
    app.use('/api/commands', require('../../routes/commands').default);
    id.A = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('A') RETURNING id`))[0].id;
    id.B = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('B') RETURNING id`))[0].id;
    id.tag = (await db.query<{ id: number }>(`INSERT INTO tags (name) VALUES ('core') RETURNING id`))[0].id;
    id.admin = (await db.query<{ id: number }>(`INSERT INTO users (username, password_hash, role) VALUES ('boss', 'x', 'admin') RETURNING id`))[0].id;
    id.op = (await db.query<{ id: number }>(`INSERT INTO users (username, password_hash, role) VALUES ('siteop', 'x', 'viewer') RETURNING id`))[0].id;
    await db.query(`INSERT INTO user_site_roles (user_id, site_id, role) VALUES ($1, $2, 'operator')`, [id.op, id.A]);
    const add = async (n: string, site: number) => (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ($1, '192.0.2.1', 8728, 'admin', 'x', 'router', $2, 'online') RETURNING id`, [n, site]))[0].id;
    id.a1 = await add('a1', id.A);
    id.a2 = await add('bad-a2', id.A);
    id.b1 = await add('b1', id.B);
    await db.query(`INSERT INTO device_tags (device_id, tag_id) VALUES ($1, $2)`, [id.b1, id.tag]);
  });

  afterAll(async () => { await db?.pool?.end?.(); });

  beforeEach(async () => {
    ran.length = 0; alerts.length = 0;
    await db.query(`DELETE FROM command_schedules`);
    await db.query(`DELETE FROM command_runs`);
    await db.query(`DELETE FROM maintenance_windows`);
  });

  const schedule = async (over: Record<string, unknown> = {}) => (await db.query<{ id: number }>(
    `INSERT INTO command_schedules (name, command, device_ids, tag_ids, site_ids, kind, cron, next_run_at, created_by, created_by_user_id,
       use_change_guard, maintenance_only, halt_on_failure, wave_size)
     VALUES ($1, ':put hi', $2, $3, $4, 'cron', '0 3 * * *', $5, $6, $7, FALSE, $8, FALSE, 5) RETURNING id`,
    [over.name ?? 's', over.device_ids ?? [], over.tag_ids ?? [], over.site_ids ?? [], over.next_run_at ?? new Date(Date.now() - 30_000),
      over.created_by ?? 'boss', over.created_by_user_id === undefined ? id.admin : over.created_by_user_id, over.maintenance_only ?? false]))[0].id;
  const runsOf = (sid: number) => db.query<{ id: number; status: string; note: string | null }>(`SELECT id, status, note FROM command_runs WHERE schedule_id = $1 ORDER BY id`, [sid]);
  const settled = async (sid: number) => {
    for (let i = 0; i < 100; i++) {
      const r = await runsOf(sid);
      if (r.length && r.every((x) => !['pending', 'running'].includes(x.status))) return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    return runsOf(sid);
  };
  const lastStatus = async (sid: number) => (await db.query<{ last_status: string; next_run_at: string }>(`SELECT last_status, next_run_at FROM command_schedules WHERE id = $1`, [sid]))[0];

  it('runs a due schedule on its devices, tags and sites, and moves to the next time', async () => {
    const sid = await schedule({ device_ids: [id.a1], tag_ids: [id.tag] });
    await scheduler.tick();
    const [run] = await settled(sid);
    expect(run.status).toBe('completed');
    expect(ran.sort()).toEqual(['a1', 'b1']);
    const s = await lastStatus(sid);
    expect(s.last_status).toBe('completed');
    expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('alerts when a device fails', async () => {
    const sid = await schedule({ site_ids: [id.A] });
    await scheduler.tick();
    await settled(sid);
    await new Promise((ok) => setTimeout(ok, 100));
    expect((await lastStatus(sid)).last_status).toBe('failed');
    expect(alerts.join(' ')).toMatch(/1 of 2 devices failed/);
  });

  it('marks a time that passed while the manager was down as missed, and never runs it late', async () => {
    const sid = await schedule({ device_ids: [id.a1], next_run_at: new Date(Date.now() - 60 * 60_000) });
    await scheduler.tick();
    const runs = await runsOf(sid);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'missed', note: expect.stringMatching(/wasn't running/) });
    expect(ran).toEqual([]);
    expect(alerts.join(' ')).toMatch(/didn't run/);
  });

  it('only runs inside a maintenance window when asked to', async () => {
    await db.query(`INSERT INTO maintenance_windows (name, device_ids, start_at, end_at) VALUES ('mw', $1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour')`, [[id.a1]]);
    const sid = await schedule({ device_ids: [id.a1, id.b1], maintenance_only: true });
    await scheduler.tick();
    const [run] = await settled(sid);
    expect(ran).toEqual(['a1']);
    const devices = await db.query<{ device_id: number; status: string; error: string | null }>(`SELECT device_id, status, error FROM command_run_devices WHERE run_id = $1`, [run.id]);
    expect(devices.find((d) => d.device_id === id.b1)).toMatchObject({ status: 'skipped', error: 'Outside a maintenance window' });
  });

  it('runs as its creator: a removed account runs nothing, a site account only reaches its sites', async () => {
    const gone = await schedule({ device_ids: [id.a1], created_by_user_id: null });
    await scheduler.tick();
    expect((await runsOf(gone))[0]).toMatchObject({ status: 'missed', note: expect.stringMatching(/removed/) });

    const sid = await schedule({ name: 'site', device_ids: [id.a1, id.b1], created_by: 'siteop', created_by_user_id: id.op });
    await scheduler.tick();
    const [run] = await settled(sid);
    expect(ran).toEqual(['a1']);
    expect(run.note).toMatch(/outside siteop's sites/);
  });

  it('refuses an unguarded scheduled command that could cut management, and keeps schedules to their owner', async () => {
    currentUser = { userId: id.admin, username: 'boss', role: 'admin' };
    const body = { command: '/ip address remove [find]', device_ids: [id.a1], kind: 'simple', simple: { freq: 'daily', time: '03:00' } };
    const risky = await request(app).post('/api/commands/schedules').send({ ...body, use_change_guard: false });
    expect(risky.status).toBe(400);
    expect(risky.body.error).toMatch(/Change Guard/);
    const ok = await request(app).post('/api/commands/schedules').send(body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ description: 'Daily at 03:00', target_count: 1, use_change_guard: true });

    // Saving a schedule is for admins (#411).
    currentUser = { userId: id.op, username: 'siteop', role: 'operator', siteRoles: { [id.A]: 'operator' } };
    expect((await request(app).post('/api/commands/schedules').send({ ...body, device_ids: [id.a1] })).status).toBe(403);
    // A site admin sees only its own schedules and can't reach another site.
    currentUser = { userId: id.op, username: 'siteop', role: 'admin', siteRoles: { [id.A]: 'admin' } };
    expect((await request(app).get('/api/commands/schedules')).body.schedules).toEqual([]);
    expect((await request(app).delete(`/api/commands/schedules/${ok.body.id}`)).status).toBe(404);
    const foreign = await request(app).post('/api/commands/schedules').send({ ...body, command: ':put x', device_ids: [id.b1] });
    expect(foreign.status).toBe(404);
  });
});
