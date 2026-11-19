/**
 * Firewall Logs' From Zone and To Zone filters (#415) against a real Postgres:
 * the zone is read from each zone-managed device's interface map, so the SQL
 * that picks a line's interfaces out of the RouterOS message has to agree
 * with the parser, and the site scope has to hold for the zone choices too.
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

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('Firewall Logs zone filters (#415)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-fwzones-'));
  const id: Record<string, number> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;
  const fleetAdmin = () => ({ userId: 2, username: 'admin', role: 'admin' });

  // The line each test expects back, by name.
  const lines: Record<string, [string, string]> = {
    lanToRouter: ['r1', 'zone drop in mtm#u53n input: in:bridge out:(unknown 0), connection-state:new src-mac 00:11:22:33:44:55, proto UDP, 192.168.62.15:39148->192.168.62.1:53, len 60'],
    wanToLan: ['r1', 'dst-nat mtm#a1b2 forward: in:ether1 out:bridge, connection-state:new src-mac 00:11:22:33:44:56, proto TCP (SYN), 203.0.113.9:40000->192.168.62.20:443, len 60'],
    lanToWan: ['r1', 'allow out mtm#c3d4 forward: in:bridge out:ether1, connection-state:new src-mac 00:11:22:33:44:57, proto TCP (SYN), 192.168.62.21:50000->198.51.100.7:443, len 60'],
    routerToWan: ['r1', 'router out mtm#e5f6 output: in:(unknown 0) out:ether1, connection-state:new proto UDP, 192.0.2.1:123->198.51.100.8:123, len 76'],
    // Its name starts like a zone's interface but isn't in a zone.
    guestToWan: ['r1', 'guest mtm#g7h8 forward: in:bridge-guest out:ether1, connection-state:new src-mac 00:11:22:33:44:58, proto UDP, 192.168.70.5:5353->198.51.100.9:53, len 60'],
    // Logged by a custom rule's log rule, in the pair's own chain (#369).
    lanToWanLogged: ['r1', 'zone accept mtm#w4yr LAN-to-WAN: in:bridge out:ether1, connection-state:new src-mac 00:11:22:33:44:61, proto TCP (SYN), 192.168.62.22:50003->1.1.1.1:443, len 60'],
    wanToRouterLogged: ['r1', 'zone accept mtm#x9y8 WAN-to-router: in:ether1 out:(unknown 0), connection-state:new src-mac 00:11:22:33:44:62, proto ICMP (type 8, code 0), 203.0.113.10->192.0.2.1, len 84'],
    // A router without zones: the same interface names, no zones.
    plainLanToWan: ['r2', 'fwd forward: in:bridge out:ether1, connection-state:new src-mac 00:11:22:33:44:59, proto TCP (SYN), 192.168.88.10:50001->198.51.100.7:443, len 60'],
    // Another site's router.
    siteBLanToGuest: ['r3', 'b fwd mtm#j9k0 forward: in:ether2 out:ether5, connection-state:new src-mac 00:11:22:33:44:60, proto TCP (SYN), 10.0.0.5:50002->10.0.5.5:22, len 60'],
  };
  const byMessage = new Map(Object.entries(lines).map(([k, [, m]]) => [m, k]));

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_fwzones';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-fwzones-key-0123456789abcdef012345678';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/events', require('../events').default);

    id.A = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    id.B = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    const device = (n: string, site: number, ip: string) => one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ($1, $2, 'u', 'x', 'router', $3, 'online') RETURNING id`, [n, ip, site]);
    id.r1 = await device('r1', id.A, '192.0.2.1');
    id.r2 = await device('r2', id.A, '192.0.2.2');
    id.r3 = await device('r3', id.B, '192.0.2.3');
    const zones = (deviceId: number, map: Record<string, string>, enabled = true) => db.query(
      `INSERT INTO firewall_zone_configs (device_id, config, desired, enabled, interface_zones) VALUES ($1, '{}', '{}', $2, $3)`,
      [deviceId, enabled, JSON.stringify(map)]);
    await zones(id.r1, { bridge: 'LAN', ether1: 'WAN', wg0: 'VPN' });
    await zones(id.r3, { ether2: 'LAN', ether5: 'GUEST' });
    for (const [device, message] of Object.values(lines)) {
      await db.query(
        `INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'info', 'firewall,info', $2)`,
        [id[device], message]);
    }
  });

  afterAll(async () => { await db?.pool?.end?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { currentUser = fleetAdmin(); });

  const raw = async (qs: string) => {
    const res = await request(app).get(`/api/events/firewall?${qs}`);
    expect(res.status).toBe(200);
    const names = (res.body.events as { rawMessage: string }[]).map((e) => byMessage.get(e.rawMessage)).sort();
    expect(res.body.total).toBe(names.length);
    return names;
  };

  it('filters by the zone a line came from, on every zone-managed device', async () => {
    expect(await raw('fromZone=LAN')).toEqual(['lanToRouter', 'lanToWan', 'lanToWanLogged', 'siteBLanToGuest']);
    expect(await raw('fromZone=WAN')).toEqual(['wanToLan', 'wanToRouterLogged']);
  });

  it('filters by the zone a line went to', async () => {
    // bridge-guest is in no zone, but it went out ether1, which is WAN.
    expect(await raw('toZone=WAN')).toEqual(['guestToWan', 'lanToWan', 'lanToWanLogged', 'routerToWan']);
    expect(await raw('toZone=GUEST')).toEqual(['siteBLanToGuest']);
  });

  it('reads the router itself as the Router zone', async () => {
    expect(await raw('toZone=Router')).toEqual(['lanToRouter', 'wanToRouterLogged']);
    expect(await raw('fromZone=Router')).toEqual(['routerToWan']);
  });

  it('takes both at once, one direction', async () => {
    expect(await raw('fromZone=LAN&toZone=WAN')).toEqual(['lanToWan', 'lanToWanLogged']);
    expect(await raw('fromZone=WAN&toZone=LAN')).toEqual(['wanToLan']);
  });

  it('matches whole interface names, and nothing on a router without zones', async () => {
    const lan = await raw('fromZone=LAN');
    expect(lan).not.toContain('guestToWan');
    expect(lan).not.toContain('plainLanToWan');
    expect(await raw('fromZone=Nowhere')).toEqual([]);
  });

  it('works with one device picked, and in the grouped view', async () => {
    expect(await raw(`fromZone=LAN&deviceId=${id.r1}`)).toEqual(['lanToRouter', 'lanToWan', 'lanToWanLogged']);
    const res = await request(app).get('/api/events/firewall?view=grouped&fromZone=LAN');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect((res.body.groups as { fromZone: string }[]).every((g) => g.fromZone === 'LAN')).toBe(true);
  });

  it('keeps to the account\'s sites, for the lines and for the zone choices', async () => {
    currentUser = { userId: 3, username: 'a-viewer', role: 'viewer', siteRoles: { [id.A]: 'viewer' } };
    expect(await raw('fromZone=LAN')).toEqual(['lanToRouter', 'lanToWan', 'lanToWanLogged']);
    const rules = await request(app).get('/api/events/firewall/rules');
    expect(rules.status).toBe(200);
    expect(rules.body.zones).toEqual(['Router', 'LAN', 'VPN', 'WAN']);

    currentUser = fleetAdmin();
    const all = await request(app).get('/api/events/firewall/rules');
    expect(all.body.zones).toEqual(['Router', 'GUEST', 'LAN', 'VPN', 'WAN']);
    const none = await request(app).get(`/api/events/firewall/rules?deviceId=${id.r2}`);
    expect(none.body.zones).toEqual([]);
  });

  it('shows lines logged in a chain of their own, as accepted, with their rule (#369)', async () => {
    expect(await raw('action=accept')).toEqual(['lanToWan', 'lanToWanLogged', 'wanToRouterLogged']);
    const res = await request(app).get(`/api/events/firewall?deviceId=${id.r1}&action=accept`);
    const logged = (res.body.events as { rawMessage: string; chain: string; ruleChain?: string; prefix: string; fromZone?: string; toZone?: string }[])
      .filter((e) => byMessage.get(e.rawMessage)?.endsWith('Logged'))
      .map((e) => ({ chain: e.chain, ruleChain: e.ruleChain, prefix: e.prefix, from: e.fromZone, to: e.toZone }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));
    expect(logged).toEqual([
      { chain: 'forward', ruleChain: 'LAN-to-WAN', prefix: 'zone accept mtm#w4yr', from: 'LAN', to: 'WAN' },
      { chain: 'input', ruleChain: 'WAN-to-router', prefix: 'zone accept mtm#x9y8', from: 'WAN', to: 'Router' },
    ]);
    const rules = await request(app).get(`/api/events/firewall/rules?deviceId=${id.r1}`);
    expect((rules.body.rules as { prefix: string }[]).map((r) => r.prefix)).toEqual(expect.arrayContaining(['zone accept mtm#w4yr', 'zone accept mtm#x9y8']));
    const grouped = await request(app).get(`/api/events/firewall?view=grouped&deviceId=${id.r1}&prefix=${encodeURIComponent('zone accept mtm#w4yr')}`);
    expect(grouped.body.total).toBe(1);
  });

  it('refuses an over-long zone', async () => {
    const res = await request(app).get(`/api/events/firewall?fromZone=${'z'.repeat(65)}`);
    expect(res.status).toBe(400);
  });
});
