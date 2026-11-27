/**
 * A poll's clients go to Postgres in one statement a batch (#442), against a
 * real database: a mocked query can't tell that the SQL itself is refused.
 * The batch statement once named an alias it never declared, so every batch
 * failed and fell back to a statement per client, unnoticed.
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

suite('clients are stored a batch to a statement', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let collector: typeof import('../../services/mikrotik/DeviceCollector');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-clientsbatch-'));

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_clientsbatch';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-clientsbatch-key-0123456789abcdef012345';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../migrate').runMigrations();
    collector = require('../../services/mikrotik/DeviceCollector');
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes every client in one statement, and updates them on the next poll', async () => {
    const [d] = await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted)
       VALUES ('batch-test', '192.0.2.1', 'admin', 'x') RETURNING id`);
    type Row = Parameters<typeof collector.upsertClients>[2][number];
    const rows: Row[] = [
      ['aa:bb:cc:00:00:01', 'laptop', '192.0.2.10', 'ether2', 10, 100, 200, null, 'wired', 1000, 2000],
      ['aa:bb:cc:00:00:02', null, '192.0.2.11', 'wlan1', null, 5, 6, -61, 'wireless', null, null],
      ['aa:bb:cc:00:00:03', 'printer', null, 'ether3', null, 0, 0, null, 'wired', null, null],
    ];
    const spy = jest.spyOn(db, 'query');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await collector.upsertClients(d.id, 'batch-test', rows)).toEqual(rows.map((r) => r[0]));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    const again: Row[] = [['aa:bb:cc:00:00:01', null, '192.0.2.12', 'ether2', 10, 300, 400, null, 'wired', null, null]];
    await collector.upsertClients(d.id, 'batch-test', again);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();

    const stored = await db.query<{ mac_address: string; hostname: string | null; ip_address: string | null; vlan_id: number | null; signal_strength: number | null; tx_bytes: string; active: boolean }>(
      `SELECT mac_address, hostname, ip_address, vlan_id, signal_strength, tx_bytes, active
         FROM clients WHERE device_id = $1 ORDER BY mac_address`, [d.id]);
    expect(stored).toEqual([
      // The hostname stays when the next sighting has none; the address moves.
      { mac_address: 'aa:bb:cc:00:00:01', hostname: 'laptop', ip_address: '192.0.2.12', vlan_id: 10, signal_strength: null, tx_bytes: '300', active: true },
      { mac_address: 'aa:bb:cc:00:00:02', hostname: null, ip_address: '192.0.2.11', vlan_id: null, signal_strength: -61, tx_bytes: '5', active: true },
      { mac_address: 'aa:bb:cc:00:00:03', hostname: 'printer', ip_address: null, vlan_id: null, signal_strength: null, tx_bytes: '0', active: true },
    ]);
  });
});
