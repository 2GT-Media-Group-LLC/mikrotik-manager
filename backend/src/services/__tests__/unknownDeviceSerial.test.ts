jest.mock('../../config/database', () => ({ transaction: jest.fn() }));
jest.mock('../identityPins', () => ({
  normalizeSerial: (serial: string) => serial.trim().toUpperCase(),
}));

import type { PoolClient } from 'pg';
import { transaction } from '../../config/database';
import { runPollJob } from '../../utils/pollJobContext';
import { resolveUnknownDeviceSerial } from '../unknownDeviceSerial';
import type { DeviceRow } from '../mikrotik/DeviceCollector';

const candidate: DeviceRow & { site_id: number } = {
  id: 2, name: 'new', ip_address: '10.0.0.2', api_port: 8729, api_tls: null,
  api_username: 'admin', api_password_encrypted: 'new-password', ssh_port: 22,
  ssh_username: 'admin', ssh_password_encrypted: 'new-ssh-password',
  jump_host_id: null, device_type: 'router', status: 'unknown', ssh_only: false, force_add_pending: true,
  site_id: 1,
};
const existing = { ...candidate, id: 1, name: 'old', ip_address: '10.0.0.1', status: 'online', force_add_pending: false };

describe('resolveUnknownDeviceSerial', () => {
  let matches: Array<typeof existing>;
  let pins: Array<{ device_id: number; kind: string; fingerprint: string; seen_fingerprint: string | null }>;
  let current: typeof candidate | null;
  let query: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    matches = [];
    pins = [];
    current = { ...candidate };
    query = jest.fn(async (sql: string) => {
      if (sql.includes('WHERE id = $1 FOR UPDATE')) return { rows: current ? [current] : [] };
      if (sql.includes('UPPER(BTRIM(d.serial_number))')) return { rows: matches };
      if (sql.includes('SELECT device_id, kind, fingerprint')) return { rows: pins };
      return { rows: [] };
    });
    jest.mocked(transaction).mockImplementation(async (fn) => fn({ query } as unknown as PoolClient));
  });

  const statements = () => query.mock.calls.map(([sql]) => String(sql));

  it('stores a new serial and completes the first-poll check', async () => {
    await expect(resolveUnknownDeviceSerial(candidate, ' ab12 ')).resolves.toEqual({ action: 'continue' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPPER(BTRIM(d.serial_number))'), [2, 'AB12']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('serial_number = COALESCE'), [2, 'ab12']);
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
  });

  it('finishes without a duplicate when the device reports no serial', async () => {
    await expect(resolveUnknownDeviceSerial(candidate, null)).resolves.toEqual({ action: 'continue' });
    expect(statements().some((sql) => sql.includes('UPPER(BTRIM(d.serial_number))'))).toBe(false);
    expect(statements().some((sql) => sql.startsWith('UPDATE devices'))).toBe(false);
  });

  it('does not reconcile a device that is no longer pending, even if its status is unknown', async () => {
    current = { ...candidate, force_add_pending: false };
    matches = [existing];
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).resolves.toEqual({ action: 'gone' });
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
  });

  it('reconciles a pending device even when its status is offline', async () => {
    current = { ...candidate, status: 'offline' };
    matches = [existing];
    await expect(resolveUnknownDeviceSerial(current, 'AB12')).resolves.toEqual({ action: 'removed', deviceId: 1, disabled: false });
  });

  it('removes the new record when the existing device is online', async () => {
    matches = [existing];
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).resolves.toEqual({ action: 'removed', deviceId: 1, disabled: false });
    expect(query).toHaveBeenCalledWith('DELETE FROM devices WHERE id = $1', [2]);
    expect(statements().some((sql) => sql.includes('UPDATE devices AS target'))).toBe(false);
    expect(statements().some((sql) => sql.includes('INSERT INTO events'))).toBe(true);
  });

  it.each(['offline', 'unknown', 'disabled'])('merges into a %s record while preserving its identity and tags', async (status) => {
    matches = [{ ...existing, status }];
    pins = [
      { device_id: 1, kind: 'api-tls', fingerprint: 'same', seen_fingerprint: null },
      { device_id: 2, kind: 'api-tls', fingerprint: 'same', seen_fingerprint: null },
    ];
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).resolves.toEqual({
      action: 'merged', deviceId: 1, disabled: status === 'disabled',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE devices AS target'), [1, 2, 'AB12']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO device_tags'), [1, 2]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO device_identity_pins'), [1, 2]);
    expect(query).toHaveBeenCalledWith('DELETE FROM devices WHERE id = $1', [2]);
  });

  it.each([
    [{ ...existing, site_id: 2 }],
    [existing, { ...existing, id: 3 }],
  ])('flags cross-site or ambiguous matches without deleting or merging', async (...found) => {
    matches = found;
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).resolves.toEqual({ action: 'flagged' });
    expect(statements().some((sql) => sql.includes("status = 'disabled'"))).toBe(true);
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
    expect(statements().some((sql) => sql.includes('UPDATE devices AS target'))).toBe(false);
  });

  it('flags conflicting pins rather than moving an existing record', async () => {
    matches = [{ ...existing, status: 'offline' }];
    pins = [
      { device_id: 1, kind: 'api-tls', fingerprint: 'old', seen_fingerprint: null },
      { device_id: 2, kind: 'api-tls', fingerprint: 'new', seen_fingerprint: null },
    ];
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).resolves.toEqual({ action: 'flagged' });
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
  });

  it('does not downgrade an existing pinned API-SSL connection', async () => {
    current = { ...candidate, api_port: 8728 };
    matches = [{ ...existing, status: 'offline' }];
    pins = [{ device_id: 1, kind: 'api-tls', fingerprint: 'old', seen_fingerprint: null }];
    await expect(resolveUnknownDeviceSerial(current, 'AB12')).resolves.toEqual({ action: 'flagged' });
  });

  it.each([
    { api_port: 0, api_tls: false },
    { api_port: 18728, api_tls: null },
  ])('does not give an SSH-only merge a plaintext API retry with a pinned certificate: %j', async (settings) => {
    current = { ...candidate, ...settings, ssh_only: true };
    matches = [{ ...existing, status: 'offline' }];
    pins = [{ device_id: 1, kind: 'api-tls', fingerprint: 'old', seen_fingerprint: null }];
    await expect(resolveUnknownDeviceSerial(current, 'AB12')).resolves.toEqual({ action: 'flagged' });
  });

  it('refuses to act on a connection whose settings changed during polling', async () => {
    current = { ...candidate, ip_address: '10.0.0.3' };
    await expect(resolveUnknownDeviceSerial(candidate, 'AB12')).rejects.toThrow(/settings changed/);
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
  });

  it('does not change anything after poll cancellation', async () => {
    let unlock!: () => void;
    const waiting = new Promise<void>((resolve) => { unlock = resolve; });
    query.mockImplementationOnce(async () => { await waiting; return { rows: [] }; });
    const job = runPollJob(() => resolveUnknownDeviceSerial(candidate, 'AB12'));
    job.abortJob();
    unlock();
    await expect(job.promise).rejects.toThrow(/Poll cancelled/);
    expect(statements().some((sql) => sql.startsWith('DELETE FROM devices'))).toBe(false);
  });
});
