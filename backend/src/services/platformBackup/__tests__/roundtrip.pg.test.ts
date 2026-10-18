/**
 * Platform backup, end to end, against a real Postgres (2026-10-18).
 *
 * Runs only when PG_E2E_URL points at a test database (CI starts one; see
 * .github/workflows/ci.yml); its schema is reset each run, so the database's
 * name must contain "e2e" or "test". Skipped otherwise, so the local preflight
 * needs no database.
 *
 * Proves what the unit tests can't: that a backup taken from a migrated
 * database restores into it exactly (configuration only, and everything), that
 * the comparison reports precisely what a restore would change and nothing
 * else, and that a backup restores under a different encryption key, the
 * "new server" case, with every credential still readable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(180_000);

const KEY_A = 'e2e-key-a-0123456789abcdef0123456789';
const KEY_B = 'e2e-key-b-fedcba9876543210fedcba9876';
const PASS = 'correct horse battery staple';
const VERSION = '0.0.0-e2e';

suite('platform backup round trip against Postgres', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-'));
  const file = path.join(dir, 'full.mtmbackup');
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../../config/database');
  let crypto: typeof import('../../../utils/crypto');
  let secrets: typeof import('../../../utils/secrets');
  let engine: typeof import('../engine');
  let format: typeof import('../format');
  let compare: typeof import('../compare');

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];
  const count = async (table: string) => Number((await one<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n);
  const snapshot: Record<string, number> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = PG;
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    secrets = require('../../../utils/secrets');
    secrets.initSecrets();
    db = require('../../../config/database');
    crypto = require('../../../utils/crypto');
    engine = require('../engine');
    format = require('../format');
    compare = require('../compare');
    // Start from an empty schema every run. This wipes the database, so it
    // refuses anything whose name doesn't say it's for tests.
    const dbName = new URL(PG!).pathname.slice(1);
    if (!/e2e|test/i.test(dbName)) throw new Error(`PG_E2E_URL must name a test database (containing "e2e" or "test"); got "${dbName}"`);
    await db.query('DROP SCHEMA public CASCADE');
    await db.query('CREATE SCHEMA public');
    await require('../../../db/migrate').runMigrations();

    // A small fleet: a site, two users, two devices with encrypted logins,
    // settings, an alert rule, a tag, and some history.
    const site = await one<{ id: number }>(`INSERT INTO sites (name) VALUES ('HQ') RETURNING id`);
    await db.query(`INSERT INTO users (username, password_hash, role) VALUES ('alice', 'x', 'operator'), ('bob', 'y', 'viewer')`);
    for (const [name, ip, pw] of [['core-sw', '10.0.0.1', 'pass-one'], ['edge-r', '10.0.0.2', 'pass-two']]) {
      await db.query(
        `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted, site_id, status)
         VALUES ($1, $2, 8729, 'admin', $3, $4, 'online')`, [name, ip, crypto.encrypt(pw), site!.id]);
    }
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('e2e_setting', '"before"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.query(`INSERT INTO tags (name, color) VALUES ('prod', '#ff0000')`);
    const dev = await one<{ id: number }>(`SELECT id FROM devices WHERE name = 'core-sw'`);
    for (let i = 0; i < 50; i++) {
      await db.query(`INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'info', 'system', $2)`, [dev!.id, `event ${i}`]);
    }
    for (const t of ['devices', 'users', 'sites', 'tags', 'app_settings', 'events']) snapshot[t] = await count(t);

    await format.writeBackup(file, PASS, { appVersion: VERSION, contents: 'config+database' }, engine.exportRecords('config+database', VERSION));
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compares identical straight after the backup', async () => {
    const r = await compare.compareWithFile(file, PASS);
    expect(r.identical).toBe(true);
    expect(r.history).toEqual([]);
  });

  it('reports exactly what a restore would change, and never a secret', async () => {
    // Changes made after the backup.
    const edge = await one<{ id: number }>(`SELECT id FROM devices WHERE name = 'edge-r'`);
    await db.query(`INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted, status) VALUES ('new-ap', '10.0.0.9', 8729, 'admin', $1, 'online')`, [crypto.encrypt('pass-new')]);
    await db.query(`DELETE FROM users WHERE username = 'bob'`);
    await db.query(`UPDATE app_settings SET value = '"after"' WHERE key = 'e2e_setting'`);
    await db.query(`UPDATE devices SET api_password_encrypted = $1 WHERE id = $2`, [crypto.encrypt('changed-pass'), edge!.id]);
    // Polling noise, which must not count.
    await db.query(`UPDATE devices SET status = 'offline', last_seen = NOW(), ros_version = '7.99'`);
    for (let i = 0; i < 5; i++) {
      await db.query(`INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'info', 'system', 'later')`, [edge!.id]);
    }

    const r = await compare.compareWithFile(file, PASS);
    const t = (name: string) => r.tables.find((x) => x.table === name);
    expect(t('devices')).toMatchObject({ added: 0, removed: 1, changed: 1 });
    expect(t('devices')!.samples.removed).toEqual(['new-ap (10.0.0.9)']);
    expect(t('devices')!.samples.changed).toEqual([{ row: 'edge-r (10.0.0.2)', fields: ['api_password (secret)'] }]);
    expect(t('users')).toMatchObject({ added: 1, removed: 0, changed: 0, samples: { added: ['bob'] } });
    expect(t('app_settings')!.samples.changed.map((c) => c.row)).toContain('e2e_setting');
    expect(r.history).toContainEqual({ table: 'events', current: snapshot.events + 5, backup: snapshot.events });
    const text = JSON.stringify(r);
    for (const secret of ['pass-one', 'pass-two', 'pass-new', 'changed-pass', '"after"', '"before"']) expect(text).not.toContain(secret);
  });

  it('restores the configuration, keeping history, and then compares identical', async () => {
    const res = await engine.restoreFromFile(file, PASS, 'config', VERSION);
    expect(res.unreadable).toBe(0);
    expect(await count('devices')).toBe(snapshot.devices);
    expect(await count('users')).toBe(snapshot.users);
    // History for devices in the backup stays; the device that wasn't took its own.
    expect(await count('events')).toBe(snapshot.events + 5);
    const edge = await one<{ api_password_encrypted: string }>(`SELECT api_password_encrypted FROM devices WHERE name = 'edge-r'`);
    expect(crypto.decrypt(edge!.api_password_encrypted)).toBe('pass-two');
    expect((await compare.compareWithFile(file, PASS)).identical).toBe(true);
  });

  it('restores everything exactly', async () => {
    await engine.restoreFromFile(file, PASS, 'full', VERSION);
    for (const [table, n] of Object.entries(snapshot)) expect(await count(table)).toBe(n);
    const r = await compare.compareWithFile(file, PASS);
    expect(r.identical).toBe(true);
    expect(r.history).toEqual([]);
    // Sequences carry on past the restored rows.
    const added = await one<{ id: number }>(`INSERT INTO tags (name, color) VALUES ('after-restore', '#00ff00') RETURNING id`);
    expect(added!.id).toBeGreaterThan(0);
    await db.query(`DELETE FROM tags WHERE name = 'after-restore'`);
  });

  it('restores on a "new server" with a different encryption key, every credential readable', async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    secrets._resetSecretsForTest();
    secrets.initSecrets();
    // Key A is gone: this server can't read what's stored now.
    const before = await one<{ api_password_encrypted: string }>(`SELECT api_password_encrypted FROM devices WHERE name = 'core-sw'`);
    expect(() => crypto.decrypt(before!.api_password_encrypted)).toThrow();

    const res = await engine.restoreFromFile(file, PASS, 'full', VERSION);
    expect(res.unreadable).toBe(0);
    expect(res.reencrypted).toBeGreaterThanOrEqual(2);
    for (const [name, pw] of [['core-sw', 'pass-one'], ['edge-r', 'pass-two']]) {
      const row = await one<{ api_password_encrypted: string }>(`SELECT api_password_encrypted FROM devices WHERE name = $1`, [name]);
      expect(crypto.decrypt(row!.api_password_encrypted)).toBe(pw);
      expect(crypto.ciphertextKeyState(row!.api_password_encrypted)).toBe('current');
    }
    expect((await compare.compareWithFile(file, PASS)).identical).toBe(true);
  });
});
