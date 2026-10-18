/**
 * Groups and site access against a real Postgres (#306).
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one, so
 * it can run alongside the backup round trip.
 *
 * What the unit tests can't show: that access through groups is read the way
 * the session uses it, that an account limited to a group with no sites sees
 * nothing rather than everything, that deleting a site or group which is
 * someone's only access is caught, and that naming a new site when adding a
 * device makes it (and its group) once.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('site groups and access against Postgres', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let roles: typeof import('../siteRoles');
  let deviceSite: typeof import('../../services/deviceSite');
  const ids: Record<string, number> = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-groups-'));
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0]!;

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_groups';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-groups-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    roles = require('../siteRoles');
    deviceSite = require('../../services/deviceSite');

    for (const s of ['Alpha', 'Beta']) ids[s] = (await one<{ id: number }>(`INSERT INTO sites (name) VALUES ($1) RETURNING id`, [s])).id;
    ids.G = (await one<{ id: number }>(`INSERT INTO site_groups (name) VALUES ('Customer G') RETURNING id`)).id;
    await db.query(`UPDATE sites SET group_id = $1 WHERE id = $2`, [ids.G, ids.Alpha]);
    for (const u of ['onlySite', 'onlyGroup', 'both', 'fleet']) {
      ids[u] = (await one<{ id: number }>(`INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'viewer') RETURNING id`, [u])).id;
    }
    await db.query(`INSERT INTO user_site_roles (user_id, site_id, role) VALUES ($1, $2, 'operator'), ($3, $4, 'viewer')`,
      [ids.onlySite, ids.Alpha, ids.both, ids.Beta]);
    await db.query(`INSERT INTO user_group_roles (user_id, group_id, role) VALUES ($1, $2, 'viewer'), ($3, $2, 'admin')`,
      [ids.onlyGroup, ids.G, ids.both]);
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads access through groups, the higher role winning', async () => {
    expect(await roles.loadSiteRoles(ids.onlyGroup)).toEqual({ [ids.Alpha]: 'viewer' });
    expect(await roles.loadSiteRoles(ids.both)).toEqual({ [ids.Alpha]: 'admin', [ids.Beta]: 'viewer' });
    expect(await roles.loadSiteRoles(ids.fleet)).toBeNull();
  });

  it('an account limited to a group with no sites gets nothing, not the fleet', async () => {
    await db.query(`UPDATE sites SET group_id = NULL WHERE id = $1`, [ids.Alpha]);
    try {
      expect(await roles.loadSiteRoles(ids.onlyGroup)).toEqual({});
    } finally {
      await db.query(`UPDATE sites SET group_id = $1 WHERE id = $2`, [ids.G, ids.Alpha]);
    }
  });

  it('names the accounts a site or group deletion would leave with no access', async () => {
    expect(await roles.accountsOnlyReaching({ siteId: ids.Alpha })).toEqual(['onlySite']);
    expect(await roles.accountsOnlyReaching({ siteId: ids.Beta })).toEqual([]);
    expect(await roles.accountsOnlyReaching({ groupId: ids.G })).toEqual(['onlyGroup']);
  });

  it('adding a device to a new site makes the site and its group once', async () => {
    const fleet = { siteRoles: null };
    const results = await Promise.all([1, 2, 3].map(() =>
      deviceSite.resolveSiteChoice(fleet, { site_name: 'Gamma', group_name: 'Customer H' })));
    const made = results.map((r) => (r.ok ? r.siteId : null));
    expect(new Set(made).size).toBe(1);
    const site = await one<{ n: string; group: string }>(
      `SELECT COUNT(*)::text AS n, MAX(g.name) AS group FROM sites s LEFT JOIN site_groups g ON g.id = s.group_id WHERE LOWER(s.name) = 'gamma'`);
    expect(site).toEqual({ n: '1', group: 'Customer H' });
    // The same name, any case, is the same site.
    const again = await deviceSite.resolveSiteChoice(fleet, { site_name: 'GAMMA' });
    expect(again.ok && again.siteId).toBe(made[0]);
  });

  it('an account limited to sites can use its own, and can make none', async () => {
    const limited = { siteRoles: { [ids.Alpha]: 'operator', [ids.Beta]: 'viewer' } };
    expect(await deviceSite.resolveSiteChoice(limited, { site_name: 'alpha' })).toEqual({ ok: true, siteId: ids.Alpha, named: true });
    expect(await deviceSite.resolveSiteChoice(limited, { site_id: ids.Beta })).toMatchObject({ ok: false, status: 403 });
    expect(await deviceSite.resolveSiteChoice(limited, { site_name: 'Delta' })).toMatchObject({ ok: false, status: 403 });
    expect(await deviceSite.resolveSiteChoice(limited, { site_name: 'Gamma' })).toMatchObject({ ok: false, status: 403 });
    expect(Number((await one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sites WHERE name = 'Delta'`)).n)).toBe(0);
  });
});
