/**
 * Firewall Logs against a real Postgres: a rule in a chain of the user's own
 * (a jump target) is logged under that chain's name, not input, forward or
 * output. Those lines used to be left off the page; the SQL that picks packet
 * lines and reads their prefix has to take them, as the parser does.
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 */
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 1, username: 'admin', role: 'admin' };
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
// Influx answers every query with no rows.
jest.mock('../../config/influxdb', () => ({
  getQueryApi: () => ({
    queryRows: (_flux: string, h: { complete: () => void }) => h.complete(),
    collectRows: async () => [],
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

suite('Firewall Logs: lines from a chain of your own', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-fwchain-'));

  const LINES = {
    jumpAccept: 'allow web mtm#w4yr LAN-to-WAN: in:bridge out:ether1, connection-state:new src-mac 02:00:00:00:00:01, proto TCP (SYN), 192.168.88.10:51234->1.1.1.1:443, len 60',
    jumpDrop: 'drop scan WAN-to-router: in:ether1 out:(unknown 0), connection-state:new proto TCP (SYN), 203.0.113.10:4000->192.0.2.1:22, len 60',
    builtIn: 'FW-DROP input: in:ether1 out:(unknown 0), connection-state:new proto UDP, 203.0.113.11:5000->192.0.2.1:161, len 60',
  };

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_fwchain';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-fwchain-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/events', require('../events').default);

    const [{ id }] = await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, status)
       VALUES ('r1', '192.0.2.1', 'u', 'x', 'router', 'online') RETURNING id`);
    for (const message of Object.values(LINES)) {
      await db.query(`INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'info', 'firewall,info', $2)`, [id, message]);
    }
  });

  afterAll(async () => { await db?.pool?.end?.(); fs.rmSync(dir, { recursive: true, force: true }); });

  const list = async (qs = '') => {
    const res = await request(app).get(`/api/events/firewall${qs}`);
    expect(res.status).toBe(200);
    return res.body.events as { rawMessage: string; prefix: string; chain: string; ruleChain?: string; action: string }[];
  };

  it('lists lines from a jump chain with the built-in chain and the chain\'s name', async () => {
    const events = await list();
    expect(events.map((e) => e.rawMessage).sort()).toEqual(Object.values(LINES).sort());
    const accept = events.find((e) => e.rawMessage === LINES.jumpAccept)!;
    expect(accept).toEqual(expect.objectContaining({ prefix: 'allow web mtm#w4yr', chain: 'forward', ruleChain: 'LAN-to-WAN', action: 'accept' }));
    const drop = events.find((e) => e.rawMessage === LINES.jumpDrop)!;
    expect(drop).toEqual(expect.objectContaining({ chain: 'input', ruleChain: 'WAN-to-router', action: 'drop' }));
  });

  it('filters them by action, read from their prefix', async () => {
    expect((await list('?action=accept')).map((e) => e.rawMessage)).toEqual([LINES.jumpAccept]);
    expect((await list('?action=drop')).map((e) => e.rawMessage).sort()).toEqual([LINES.builtIn, LINES.jumpDrop].sort());
  });
});
