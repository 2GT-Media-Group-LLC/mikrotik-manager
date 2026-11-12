/**
 * Offline alerting and the batched client writes (#442), against a real
 * Postgres. Runs when PG_E2E_URL names a test database (CI and the preflight
 * start one); skipped otherwise. Works in a database of its own.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const PG = process.env.PG_E2E_URL;
const suite = PG ? describe : describe.skip;
jest.setTimeout(120_000);

suite('offline alerts and client writes against Postgres (#442)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  let db: typeof import('../../config/database');
  let alerts: typeof import('../offlineAlerts');
  let upsertClients: typeof import('../mikrotik/DeviceCollector').upsertClients;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtm-e2e-offline-'));

  beforeAll(async () => {
    const base = new URL(PG!);
    if (!/e2e|test/i.test(base.pathname)) throw new Error('PG_E2E_URL must name a test database');
    const name = 'mtm_e2e_offline';
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    base.pathname = `/${name}`;
    process.env.DATABASE_URL = base.toString();
    process.env.SECRETS_DIR = dir;
    process.env.ENCRYPTION_KEY = 'e2e-offline-key-0123456789abcdef01234567';
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    jest.resetModules();
    require('../../utils/secrets').initSecrets();
    db = require('../../config/database');
    await require('../../db/migrate').runMigrations();
    alerts = require('../offlineAlerts');
    upsertClients = require('../mikrotik/DeviceCollector').upsertClients;
  });

  afterAll(async () => {
    await db?.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const addDevice = async (name: string, siteId: number | null, status = 'online') =>
    (await db.query<{ id: number }>(
      `INSERT INTO devices (name, ip_address, api_username, api_password_encrypted, site_id, status)
       VALUES ($1, '10.0.0.1', 'u', 'x', $2, $3) RETURNING id`, [name, siteId, status]))[0].id;
  const fail = (id: number) => db.query(
    `UPDATE devices SET poll_failures = poll_failures + 1, last_poll_failure_at = NOW() WHERE id = $1`, [id]);

  describe('upsertClients', () => {
    type Row = Parameters<typeof upsertClients>[2][number];
    const row = (mac: string, over: Partial<Record<number, unknown>> = {}): Row => {
      const r: unknown[] = [mac, 'host', '10.0.0.5', 'ether2', 20, 1, 2, null, 'wired', null, null];
      for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
      return r as Row;
    };

    it('stores more than one batch, and updates as the one-row statement did', async () => {
      const id = await addDevice('core', null);
      const many = Array.from({ length: 1203 }, (_, i) => row(`aa:bb:cc:dd:${String(Math.floor(i / 256)).padStart(2, '0')}:${(i % 256).toString(16).padStart(2, '0')}`));
      expect(await upsertClients(id, 'core', many)).toHaveLength(1203);
      expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM clients WHERE device_id = $1 AND active`, [id]))[0].n).toBe(1203);

      // No hostname or address this time: the stored ones stay. No port: the VLAN stays.
      const mac = many[0][0];
      await upsertClients(id, 'core', [row(mac, { 1: null, 2: '', 3: null, 4: 99, 5: 500 })]);
      let [c] = await db.query<Record<string, unknown>>(`SELECT * FROM clients WHERE device_id = $1 AND mac_address = $2`, [id, mac]);
      expect(c).toMatchObject({ hostname: 'host', ip_address: '10.0.0.5', interface_name: 'ether2', vlan_id: 20, tx_bytes: '500' });
      // A port given: the VLAN of this sighting, even none.
      await upsertClients(id, 'core', [row(mac, { 3: 'ether9', 4: null })]);
      [c] = await db.query<Record<string, unknown>>(`SELECT * FROM clients WHERE device_id = $1 AND mac_address = $2`, [id, mac]);
      expect(c).toMatchObject({ interface_name: 'ether9', vlan_id: null });
    });

    it('keeps the good rows of a batch with a bad one', async () => {
      const id = await addDevice('edge', null);
      const stored = await upsertClients(id, 'edge', [row('aa:00:00:00:00:01'), row('aa:00:00:00:00:02', { 8: 'x'.repeat(40) }), row('aa:00:00:00:00:03')]);
      expect(stored).toEqual(['aa:00:00:00:00:01', 'aa:00:00:00:00:03']);
    });
  });

  describe('down on purpose', () => {
    it('knows a reboot the manager sent, a rollout in progress and a maintenance window', async () => {
      const [rebooted, upgrading, maint, plain] = await Promise.all(['r', 'u', 'm', 'p'].map((n) => addDevice(`planned-${n}`, null)));
      await alerts.expectReboot(rebooted);
      const [ro] = await db.query<{ id: number }>(`INSERT INTO firmware_rollouts (name, status, started_at) VALUES ('r', 'running', NOW()) RETURNING id`);
      await db.query(`INSERT INTO firmware_rollout_devices (rollout_id, device_id, status, started_at) VALUES ($1, $2, 'rebooting', NOW())`, [ro.id, upgrading]);
      await db.query(`INSERT INTO maintenance_windows (name, device_ids, start_at, end_at) VALUES ('w', $1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour')`, [[maint]]);

      const reasons = await alerts.plannedOutages([rebooted, upgrading, maint, plain]);
      expect(reasons.get(rebooted)).toMatch(/reboot/);
      expect(reasons.get(upgrading)).toMatch(/firmware/);
      expect(reasons.get(maint)).toMatch(/maintenance/);
      expect(reasons.has(plain)).toBe(false);

      // An expected reboot runs out.
      await db.query(`UPDATE devices SET reboot_expected_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [rebooted]);
      expect((await alerts.plannedOutages([rebooted])).has(rebooted)).toBe(false);
    });
  });

  describe('siteGoingQuiet', () => {
    it('is most of a site failing together, counting only devices that could', async () => {
      const [site] = await db.query<{ id: number }>(`INSERT INTO sites (name) VALUES ('Campus') RETURNING id`);
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await addDevice(`campus-${i}`, site.id));
      // Not counted: disabled, never answered, and one already down for a day.
      await addDevice('campus-disabled', site.id, 'disabled');
      await addDevice('campus-new', site.id, 'unknown');
      const longGone = await addDevice('campus-gone', site.id, 'offline');
      await db.query(`INSERT INTO device_availability (device_id, went_offline_at) VALUES ($1, NOW() - INTERVAL '1 day')`, [longGone]);
      await fail(longGone);

      await fail(ids[0]); await fail(ids[1]);
      expect(await alerts.siteGoingQuiet(site.id)).toBeNull();          // 2 of 4
      await fail(ids[2]);
      expect(await alerts.siteGoingQuiet(site.id)).toEqual({ name: 'Campus', failing: 3, total: 4 });

      // A device in a maintenance window is left out of both counts: 2 of 3.
      await db.query(`INSERT INTO maintenance_windows (name, device_ids, start_at, end_at) VALUES ('w2', $1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour')`, [[ids[2]]]);
      expect(await alerts.siteGoingQuiet(site.id)).toBeNull();
    });
  });
});
