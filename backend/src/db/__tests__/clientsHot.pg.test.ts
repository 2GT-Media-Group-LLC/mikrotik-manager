/**
 * A poll's rewrite of a client row is a HOT update: no index entry for it.
 *
 * Runs when PG_E2E_URL names a test database (CI and the preflight start one);
 * skipped otherwise. Works in a database of its own, made next to that one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('client rows are updated in place (HOT)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-clientshot-'));

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_clientshot';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-clientshot-key-0123456789abcdef0123456';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    // Twice, as every restart does: the second run must leave things as they are.
    await require('../migrate').runMigrations();
    await require('../migrate').runMigrations();
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes nothing a poll changes, and leaves room on each page', async () => {
    const indexed = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'clients'`);
    expect(indexed.map((i) => i.indexdef).join('\n')).not.toMatch(/last_seen|active/);
    const [t] = await db.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE oid = 'clients'::regclass`);
    expect(t.reloptions).toContain('fillfactor=70');
  });

  it("rewrites a client's sighting without touching an index", async () => {
    const [d] = await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted)
       VALUES ('hot-test', '192.0.2.1', 'admin', 'x') RETURNING id`);
    await db.query(
      `INSERT INTO clients (device_id, mac_address, active, last_seen) VALUES ($1, 'aa:bb:cc:00:00:01', TRUE, NOW())`, [d.id]);
    const hot = await db.transaction(async (c) => {
      // What a fast poll writes, and what a vendor lookup and going offline write.
      await c.query(`UPDATE clients SET last_seen = NOW() + INTERVAL '30 seconds', tx_bytes = 100, rx_bytes = 200,
                       signal_strength = -60, active = TRUE WHERE device_id = $1`, [d.id]);
      await c.query(`UPDATE clients SET vendor = '' WHERE device_id = $1`, [d.id]);
      await c.query(`UPDATE clients SET active = FALSE WHERE device_id = $1`, [d.id]);
      const r = await c.query<{ n: string }>(`SELECT pg_stat_get_xact_tuples_hot_updated('clients'::regclass) AS n`);
      return Number(r.rows[0].n);
    });
    expect(hot).toBe(3);
  });
});
