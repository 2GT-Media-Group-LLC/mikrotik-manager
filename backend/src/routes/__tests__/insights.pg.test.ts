/**
 * Dashboard insights, against a real Postgres: backup freshness (#377) and
 * co-channel overlap (#365).
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

type Item = { category: string; title: string; body: string };

suite('Dashboard insights (#365, #377)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let app: express.Express;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-insights-'));
  const id: Record<string, number> = {};
  const site: Record<string, number> = {};

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_insights';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    process.env.ENCRYPTION_KEY = 'e2e-insights-key-0123456789abcdef0123456';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();

    app = express();
    app.use(express.json());
    app.use('/api/operations', require('../operations').default);
    app.use('/api/wireless', require('../wireless').default);

    for (const s of ['Home', 'Branch']) {
      site[s] = (await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ($1) RETURNING id`, [s]))[0].id;
    }
    const devices: Array<[string, string, string, string, string | null, string]> = [
      // key, name, type, wifi role, site
      ['r1', 'R1', 'router', 'controller', 'Home'],
      ['wap', 'WAP', 'wireless_ap', 'cap', 'Home'],
      ['sw', 'SW', 'switch', null, 'Home'],
      ['apHome', 'AP-HOME', 'wireless_ap', 'standalone', 'Home'],
      ['apBranch', 'AP-BRANCH', 'wireless_ap', 'standalone', 'Branch'],
    ].map(([k, n, t, r, s], i) => [k, n, `10.0.0.${i + 1}`, t, r, s] as [string, string, string, string, string | null, string]);
    for (const [key, n, ip, type, role, s] of devices) {
      id[key] = (await db.query<{ id: number }>(
        `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, wifi_role, status, site_id)
         VALUES ($1, $2, 'u', 'x', $3, $4, 'online', $5) RETURNING id`,
        [n, ip, type, role, site[s]],
      ))[0].id;
    }

    const wi = (d: string, n: string, radioMac: string | null, freq: number | null) =>
      db.query(
        `INSERT INTO wireless_interfaces (device_id, name, ssid, frequency, disabled, radio_mac, managed_by_capsman, config_json)
         VALUES ($1, $2, 'Aura', $3, false, $4, $5, '{}'::jsonb)`,
        [id[d], n, freq, radioMac, d === 'wap'],
      );
    // The reporter's home site: R1 holds copies of the CAP's two radios.
    await wi('wap', 'wifi1_2.4Ghz', 'AA:00:00:00:00:01', 2462);
    await wi('wap', 'wifi2_5Ghz', 'AA:00:00:00:00:02', 5320);
    await wi('r1', 'WAP-2.4Ghz', 'AA:00:00:00:00:01', 2462);
    await wi('r1', 'WAP-5Ghz', 'AA:00:00:00:00:02', 5320);
    for (const [mac, iface, ch] of [['AA:00:00:00:00:01', 'WAP-2.4Ghz', '2462/ax/Ce'], ['AA:00:00:00:00:02', 'WAP-5Ghz', '5320/ax/Ceee']]) {
      await db.query(
        `INSERT INTO capsman_radios (controller_device_id, radio_mac, interface_name, local, matched_device_id, current_channel, registered_peers, ssid)
         VALUES ($1, $2, $3, false, $4, $5, 0, 'Aura')`,
        [id.r1, mac, iface, id.wap, ch],
      );
    }
    // Standalone APs on channel 1 at two different sites.
    await wi('apHome', 'wlan1', 'CC:00:00:00:00:01', 2412);
    await wi('apBranch', 'wlan1', 'CC:00:00:00:00:02', 2412);
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const insights = async (): Promise<Item[]> => {
    const res = await request(app).get('/api/operations/insights');
    expect(res.status).toBe(200);
    return res.body.attention as Item[];
  };
  const backup = (d: string, daysAgo: number) => db.query(
    `INSERT INTO backups (device_id, filename, file_path, backup_type, created_at)
     VALUES ($1, 'x.rsc', '/tmp/x.rsc', 'config-snapshot', NOW() - make_interval(days => $2))`,
    [id[d], daysAgo],
  );
  const checked = (d: string, hoursAgo: number | null) => db.query(
    `UPDATE devices SET config_checked_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() - make_interval(hours => $2::int) END WHERE id = $1`,
    [id[d], hoursAgo],
  );

  it('an unchanged config checked within the week is not a missing backup (#377)', async () => {
    // R1: last copy 10 days old, but checked an hour ago and found unchanged.
    await backup('r1', 10); await checked('r1', 1);
    // SW: last copy 10 days old and never checked since.
    await backup('sw', 10); await checked('sw', null);
    // WAP: checked, but the check is 8 days old.
    await backup('wap', 10); await checked('wap', 8 * 24);
    // AP-HOME: checked an hour ago, but there's no copy at all.
    await checked('apHome', 1);
    // AP-BRANCH: a fresh copy.
    await backup('apBranch', 1);

    const items = (await insights()).filter((i) => i.category === 'backups');
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.body]));
    expect(Object.keys(byTitle).sort()).toEqual([
      'AP-HOME has no recent backup', 'SW has no recent backup', 'WAP has no recent backup',
    ]);
    expect(byTitle['AP-HOME has no recent backup']).toBe('No backup has ever been taken.');
    expect(byTitle['SW has no recent backup']).toBe('Last backup 10d ago.');
    expect(byTitle['WAP has no recent backup']).toBe('Last backup 10d ago; the configuration was last checked 8d ago.');
  });

  it("co-channel overlap leaves out a controller's copies and radios at other sites (#365)", async () => {
    const wifi = (await insights()).filter((i) => i.title.startsWith('Co-channel'));
    expect(wifi).toEqual([]);

    // Channel Usage: each standalone site is its own location.
    const res = await request(app).get('/api/wireless/rf/channels');
    const names = (res.body.locations as Array<{ name: string; radios: number }>).map((l) => `${l.name}:${l.radios}`).sort();
    expect(names).toEqual(['R1:2', 'Standalone access points · Branch:1', 'Standalone access points · Home:1']);
    expect((res.body.radios as Array<{ overlap: string }>).every((r) => r.overlap === 'clear')).toBe(true);
  });

  it('two radios on one channel at the same site are co-channel', async () => {
    const ap2 = (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, device_type, wifi_role, status, site_id)
       VALUES ('AP-HOME-2', '10.0.0.20', 'u', 'x', 'wireless_ap', 'standalone', 'online', $1) RETURNING id`,
      [site.Home],
    ))[0].id;
    await db.query(
      `INSERT INTO wireless_interfaces (device_id, name, ssid, frequency, disabled, radio_mac, config_json)
       VALUES ($1, 'wlan1', 'Aura', 2412, false, 'CC:00:00:00:00:03', '{}'::jsonb)`,
      [ap2],
    );
    const wifi = (await insights()).filter((i) => i.title.startsWith('Co-channel'));
    expect(wifi).toHaveLength(1);
    expect(wifi[0].title).toBe('Co-channel overlap on 1 channel');
    expect(wifi[0].body).toContain('channel 1 (Standalone access points · Home)');
  });
});
