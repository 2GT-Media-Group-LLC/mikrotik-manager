/**
 * A site-scoped account sees and changes only its own part of the map, and only
 * the neighbours its own devices heard, against a real Postgres (P1-7). Before,
 * the discovered list was fleet-wide, and the map's saved arrangement, colours
 * and hidden links (which name devices and ports) were shared with every site.
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

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('the map and discovered neighbours stay in their sites', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-topo-'));
  const id: Record<string, number> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(sql, params))[0]!.id;

  const operatorInA = () => ({ userId: 1, username: 'op', role: 'operator', siteRoles: { [id.A]: 'operator' } });
  const viewerInB = () => ({ userId: 1, username: 'op', role: 'viewer', siteRoles: { [id.A]: 'operator', [id.B]: 'viewer' } });
  const fleetAdmin = () => ({ userId: 2, username: 'admin', role: 'admin' });

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_topo_scope';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-topo-scope-key-0123456789abcdef012345';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/devices', require('../devices').default);
    app.use('/api/topology', require('../topology').default);

    id.A = await one(`INSERT INTO sites (name) VALUES ('A') RETURNING id`);
    id.B = await one(`INSERT INTO sites (name) VALUES ('B') RETURNING id`);
    const device = (n: string, site: number, ip: string) => one(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, site_id, status)
       VALUES ($1, $2, 'u', 'x', 'switch', $3, 'online') RETURNING id`, [n, ip, site]);
    id.devA = await device('switch-in-A', id.A, '192.0.2.1');
    id.devA2 = await device('router-in-A', id.A, '192.0.2.2');
    id.devB = await device('secret-switch-in-B', id.B, '198.51.100.1');
    const heard = (from: number, port: string, identity: string, address: string) => db.query(
      `INSERT INTO topology_links (from_device_id, from_interface, neighbor_identity, neighbor_address, neighbor_platform)
       VALUES ($1, $2, $3, $4, 'MikroTik')`, [from, port, identity, address]);
    await heard(id.devA, 'ether5', 'new-in-A', '192.0.2.50');
    await heard(id.devB, 'ether5', 'new-in-B', '198.51.100.50');
    // Heard in A, but already managed in B: not A's to know about.
    await heard(id.devA, 'ether6', 'secret-switch-in-B', '198.51.100.1');

    const cableA = `cable:${id.devA}@ether1|${id.devA2}@ether1`;
    const cableAB = `cable:${id.devA}@ether2|${id.devB}@ether2`;
    Object.assign(keys, { cableA, cableAB });
    await db.query(`INSERT INTO topology_hidden_links (edge_key, label) VALUES ($1, 'A link'), ($2, 'secret-switch-in-B link')`, [cableA, cableAB]);
    await db.query(`INSERT INTO topology_positions (node_key, x, y) VALUES ($1, 1, 1), ($2, 2, 2)`, [String(id.devA), String(id.devB)]);
    await db.query(`INSERT INTO topology_edge_anchors (edge_key, color) VALUES ($1, '#ff0000'), ($2, '#00ff00')`, [cableA, cableAB]);
  });
  const keys: Record<string, string> = {};

  afterAll(async () => { await db?.pool?.end?.(); });
  beforeEach(() => { currentUser = operatorInA(); });

  it('discovered: only what A heard, and nothing managed in B', async () => {
    const res = await request(app).get('/api/devices/discovered');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { identity: string }) => r.identity)).toEqual(['new-in-A']);
    expect(JSON.stringify(res.body)).not.toContain('in-B');
  });

  it('discovered: a fleet account still sees every site, and what is already managed', async () => {
    currentUser = fleetAdmin();
    const res = await request(app).get('/api/devices/discovered');
    const names = res.body.map((r: { identity: string }) => r.identity).sort();
    expect(names).toEqual(['new-in-A', 'new-in-B', 'secret-switch-in-B']);
    expect(res.body.find((r: { identity: string }) => r.identity === 'secret-switch-in-B').duplicate_of_device_id).toBe(id.devB);
  });

  it("topology: A's saved map holds nothing that names B", async () => {
    const res = await request(app).get('/api/topology');
    expect(res.status).toBe(200);
    expect(res.body.hiddenLinks.map((h: { key: string }) => h.key)).toEqual([keys.cableA]);
    expect(Object.keys(res.body.layout.positions)).toEqual([String(id.devA)]);
    expect(Object.keys(res.body.layout.colors)).toEqual([keys.cableA]);
    // A's own switch hears B's over LLDP, so that name is A's to see; what was
    // saved about B's part of the map isn't.
    expect(JSON.stringify(res.body)).not.toContain('secret-switch-in-B link');
  });

  it('topology: a fleet account sees all of it', async () => {
    currentUser = fleetAdmin();
    const res = await request(app).get('/api/topology');
    expect(res.body.hiddenLinks).toHaveLength(2);
    expect(Object.keys(res.body.layout.positions).sort()).toEqual([String(id.devA), String(id.devB)].sort());
  });

  it("topology: A can't rearrange, colour, hide or show B's part of the map", async () => {
    const posB = await request(app).put('/api/topology/layout').send({ positions: { [String(id.devB)]: { x: 9, y: 9 } } });
    expect(posB.status).toBe(403);
    const colB = await request(app).put('/api/topology/layout').send({ colors: { [keys.cableAB]: '#123456' } });
    expect(colB.status).toBe(403);
    const resetB = await request(app).post('/api/topology/layout/reset').send({ keys: [String(id.devB)] });
    expect(resetB.status).toBe(403);
    const hideB = await request(app).post('/api/topology/hidden-links').send({ key: `cable:${id.devB}@ether3|${id.devB}@ether4` });
    expect(hideB.status).toBe(403);
    const showB = await request(app).delete('/api/topology/hidden-links').query({ key: keys.cableAB });
    expect(showB.status).toBe(403);
    const rows = await db.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM topology_positions WHERE node_key = $1 AND x = 2)::int
            + (SELECT COUNT(*) FROM topology_hidden_links WHERE edge_key = $2)::int
            + (SELECT COUNT(*) FROM topology_edge_anchors WHERE edge_key = $2 AND color = '#00ff00')::int AS n`,
      [String(id.devB), keys.cableAB]);
    expect(rows[0].n).toBe(3);
  });

  it('topology: a viewer in B is no writer there', async () => {
    currentUser = viewerInB();
    const posB = await request(app).put('/api/topology/layout').send({ positions: { [String(id.devB)]: { x: 9, y: 9 } } });
    expect(posB.status).toBe(403);
  });

  it("topology: A names only the neighbours on its own part of the map", async () => {
    currentUser = fleetAdmin();
    const all = (await request(app).get('/api/topology')).body.externalNodes as { id: string; name: string }[];
    const inA = all.find((n) => n.name === 'new-in-A')!;
    const inB = all.find((n) => n.name === 'new-in-B')!;
    expect(inA && inB).toBeTruthy();
    currentUser = operatorInA();
    expect((await request(app).put(`/api/topology/neighbours/${inB.id}`).send({ name: 'renamed by A' })).status).toBe(403);
    expect((await request(app).put(`/api/topology/neighbours/${inA.id}`).send({ name: 'our AP' })).status).toBe(200);
    const rows = await db.query<{ ext_id: string }>(`SELECT ext_id FROM topology_neighbour_overrides`);
    expect(rows.map((r) => r.ext_id)).toEqual([inA.id]);
  });

  it('topology: A still arranges its own part', async () => {
    const pos = await request(app).put('/api/topology/layout').send({ positions: { [String(id.devA)]: { x: 5, y: 5 } }, colors: { [keys.cableA]: '#abcdef' } });
    expect(pos.status).toBe(200);
    const hide = await request(app).post('/api/topology/hidden-links').send({ key: `cable:${id.devA}@ether3|${id.devA2}@ether3` });
    expect(hide.status).toBe(200);
    const show = await request(app).delete('/api/topology/hidden-links').query({ key: `cable:${id.devA}@ether3|${id.devA2}@ether3` });
    expect(show.status).toBe(200);
  });
});
