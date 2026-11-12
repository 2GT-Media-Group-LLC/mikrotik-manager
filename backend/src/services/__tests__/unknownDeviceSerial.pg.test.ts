import { randomBytes } from 'crypto';
import { Client } from 'pg';
import type { DeviceRow } from '../mikrotik/DeviceCollector';

const pgUrl = process.env.PG_E2E_URL;
const suite = pgUrl ? describe : describe.skip;

suite('force-added serial reconciliation (PostgreSQL)', () => {
  const database = `mtm_e2e_force_serial_${randomBytes(6).toString('hex')}`;
  let db: typeof import('../../config/database');
  let resolve: typeof import('../unknownDeviceSerial').resolveUnknownDeviceSerial;
  let admin: Client;
  let siteId: number;
  let otherSiteId: number;

  beforeAll(async () => {
    const url = new URL(pgUrl!);
    if (!/test|e2e/i.test(url.pathname)) throw new Error('PG_E2E_URL must name a test database');
    admin = new Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    url.pathname = `/${database}`;
    process.env.DATABASE_URL = url.toString();
    jest.resetModules();
    db = await import('../../config/database');
    await (await import('../../db/migrate')).runMigrations();
    resolve = (await import('../unknownDeviceSerial')).resolveUnknownDeviceSerial;
    siteId = (await db.query<{ id: number }>('SELECT id FROM sites WHERE is_default'))[0].id;
    otherSiteId = (await db.query<{ id: number }>("INSERT INTO sites (name) VALUES ('Other site') RETURNING id"))[0].id;
  }, 120_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query('DELETE FROM devices');
    await db.query('DELETE FROM tags');
  });

  async function addDevice(opts: {
    name: string; serial?: string; status?: string; site?: number; candidate?: boolean; port?: number;
  }): Promise<DeviceRow> {
    return (await db.query<DeviceRow>(
      `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted,
                            ssh_port, ssh_username, ssh_password_encrypted, status, site_id,
                            serial_number, jump_host_id)
       VALUES ($1, $2, $3, 'admin', $4, 22, 'admin', $5, $6, $7, $8, NULL) RETURNING *`,
      [opts.name, opts.candidate ? '192.0.2.2' : '192.0.2.1', opts.port ?? 8729,
        `${opts.name}-api`, `${opts.name}-ssh`, opts.status ?? 'unknown', opts.site ?? siteId,
        opts.serial ?? null],
    ))[0];
  }

  it('migrates pending offline devices to unknown and removes the old column', async () => {
    const pending = await addDevice({ name: 'pending', status: 'offline' });
    const ordinary = await addDevice({ name: 'ordinary', status: 'offline' });
    const disabled = await addDevice({ name: 'disabled', status: 'disabled' });
    await (await import('../../db/migrate')).runMigrations();

    const rows = await db.query<{ id: number; status: string }>(
      'SELECT id, status FROM devices WHERE id = ANY($1::int[]) ORDER BY id', [[pending.id, ordinary.id, disabled.id]],
    );
    expect(rows).toEqual([
      { id: pending.id, status: 'unknown' },
      { id: ordinary.id, status: 'offline' },
      { id: disabled.id, status: 'disabled' },
    ]);
    expect(await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'devices' AND column_name = 'force_add_pending'`,
    )).toHaveLength(0);
  });

  it('removes a new duplicate of an online device, retaining its record and event', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'Ab12', status: 'online' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });

    await expect(resolve(candidate, 'ab12')).resolves.toEqual({ action: 'removed', deviceId: existing.id, disabled: false });
    expect(await db.query('SELECT id FROM devices WHERE id = $1', [candidate.id])).toHaveLength(0);
    expect(await db.query('SELECT id FROM devices WHERE id = $1', [existing.id])).toHaveLength(1);
    expect(await db.query('SELECT id FROM events WHERE device_id = $1', [existing.id])).toHaveLength(1);
  });

  it('keeps a failed first poll unknown, records its error, and detects a duplicate on retry', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'AB12', status: 'online' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    const { PollerService } = await import('../PollerService');
    const poller = Object.assign(Object.create(PollerService.prototype) as {
      recordPollOutcome(id: number, kind: string, duration: number, error: string): Promise<void>;
      recordDeviceFailure(id: number, message: string): Promise<void>;
    }, {
      getDevice: async (id: number) => (await db.query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [id]))[0],
      phases: new Map(),
    });

    await poller.recordPollOutcome(candidate.id, 'full', 100, 'connection failed');
    await poller.recordDeviceFailure(candidate.id, 'connection failed');
    const [row] = await db.query<{ status: string }>('SELECT status FROM devices WHERE id = $1', [candidate.id]);
    expect(row.status).toBe('unknown');
    const [stats] = await db.query<{ last_error: string }>(
      'SELECT last_error FROM device_poll_stats WHERE device_id = $1 AND kind = $2', [candidate.id, 'full'],
    );
    expect(stats.last_error).toBe('connection failed');
    await expect(resolve(candidate, 'AB12')).resolves.toEqual({ action: 'removed', deviceId: existing.id, disabled: false });
  });

  it('merges connection settings and tags into an offline record without losing history', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'AB12', status: 'offline' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    const tag = (await db.query<{ id: number }>("INSERT INTO tags (name) VALUES ('candidate-tag') RETURNING id"))[0].id;
    await db.query('INSERT INTO device_tags (device_id, tag_id) VALUES ($1, $2)', [candidate.id, tag]);
    await db.query("INSERT INTO events (device_id, severity, topic, message) VALUES ($1, 'info', 'test', 'history')", [existing.id]);

    await expect(resolve(candidate, 'AB12')).resolves.toEqual({ action: 'merged', deviceId: existing.id, disabled: false });
    const [updated] = await db.query<{ ip_address: string; api_password_encrypted: string; ssh_password_encrypted: string; serial_number: string }>(
      'SELECT ip_address, api_password_encrypted, ssh_password_encrypted, serial_number FROM devices WHERE id = $1', [existing.id],
    );
    expect(updated).toMatchObject({
      ip_address: '192.0.2.2', api_password_encrypted: 'candidate-api',
      ssh_password_encrypted: 'candidate-ssh', serial_number: 'AB12',
    });
    expect(await db.query('SELECT id FROM devices WHERE id = $1', [candidate.id])).toHaveLength(0);
    expect(await db.query('SELECT tag_id FROM device_tags WHERE device_id = $1 AND tag_id = $2', [existing.id, tag])).toHaveLength(1);
    expect(await db.query("SELECT id FROM events WHERE device_id = $1 AND message = 'history'", [existing.id])).toHaveLength(1);
  });

  it('flags a cross-site match without changing or identifying the other record', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'AB12', status: 'offline', site: otherSiteId });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    await expect(resolve(candidate, 'AB12')).resolves.toEqual({ action: 'flagged' });
    const [row] = await db.query<{ status: string }>('SELECT status FROM devices WHERE id = $1', [candidate.id]);
    expect(row.status).toBe('disabled');
    expect(await db.query("SELECT id FROM devices WHERE id = $1 AND name = 'existing'", [existing.id])).toHaveLength(1);
  });

  it('finds and preserves a previously pinned serial even if the serial column was never populated', async () => {
    const existing = await addDevice({ name: 'existing', status: 'offline' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    await db.query(
      "INSERT INTO device_identity_pins (device_id, kind, fingerprint) VALUES ($1, 'serial', 'AB12')",
      [existing.id],
    );
    await expect(resolve(candidate, 'AB12')).resolves.toEqual({ action: 'merged', deviceId: existing.id, disabled: false });
    const [row] = await db.query<{ serial_number: string }>('SELECT serial_number FROM devices WHERE id = $1', [existing.id]);
    expect(row.serial_number).toBe('AB12');
  });

  it('flags a conflicting pinned TLS identity instead of merging', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'AB12', status: 'offline' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    await db.query(
      "INSERT INTO device_identity_pins (device_id, kind, fingerprint) VALUES ($1, 'api-tls', 'aaaa'), ($2, 'api-tls', 'bbbb')",
      [existing.id, candidate.id],
    );
    await expect(resolve(candidate, 'AB12')).resolves.toEqual({ action: 'flagged' });
    const rows = await db.query<{ id: number; status: string }>(
      'SELECT id, status FROM devices WHERE id = ANY($1::int[]) ORDER BY id', [[existing.id, candidate.id]],
    );
    expect(rows).toEqual([{ id: existing.id, status: 'offline' }, { id: candidate.id, status: 'disabled' }]);
  });

  it('rolls back the merge if the duplicate cannot be removed', async () => {
    const existing = await addDevice({ name: 'existing', serial: 'AB12', status: 'offline' });
    const candidate = await addDevice({ name: 'candidate', candidate: true });
    await db.query(`CREATE FUNCTION fail_force_serial_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test delete failure'; END; $$ LANGUAGE plpgsql`);
    await db.query('CREATE TRIGGER fail_force_serial_delete BEFORE DELETE ON devices FOR EACH ROW EXECUTE FUNCTION fail_force_serial_delete()');
    try {
      await expect(resolve(candidate, 'AB12')).rejects.toThrow('test delete failure');
      const rows = await db.query<{ name: string; ip_address: string }>(
        'SELECT name, ip_address FROM devices WHERE id = ANY($1::int[]) ORDER BY id', [[existing.id, candidate.id]],
      );
      expect(rows).toEqual([
        { name: 'existing', ip_address: '192.0.2.1' },
        { name: 'candidate', ip_address: '192.0.2.2' },
      ]);
      expect(await db.query('SELECT id FROM events WHERE device_id = $1', [existing.id])).toHaveLength(0);
    } finally {
      await db.query('DROP TRIGGER fail_force_serial_delete ON devices');
      await db.query('DROP FUNCTION fail_force_serial_delete()');
    }
  });

  it('serializes simultaneous force-adds with the same serial', async () => {
    const first = await addDevice({ name: 'first', candidate: true });
    const second = await addDevice({ name: 'second', candidate: true });
    const results = await Promise.all([resolve(first, 'AB12'), resolve(second, 'AB12')]);
    expect(results.map((r) => r.action).sort()).toEqual(['continue', 'merged']);
    const rows = await db.query<{ serial_number: string }>('SELECT serial_number FROM devices');
    expect(rows).toEqual([{ serial_number: 'AB12' }]);
  });
});
