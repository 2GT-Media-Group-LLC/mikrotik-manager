import { transaction } from '../config/database';
import { pollJobAborted } from '../utils/pollJobContext';
import { usesApiTls } from '../utils/apiTls';
import { normalizeSerial } from './identityPins';
import type { DeviceRow } from './mikrotik/DeviceCollector';

type Resolution =
  | { action: 'continue' | 'gone' | 'flagged' }
  | { action: 'removed' | 'merged'; deviceId: number; disabled: boolean };

interface Candidate extends DeviceRow {
  site_id: number | null;
  serial_number: string | null;
}

interface Pin {
  device_id: number;
  kind: 'api-tls' | 'ssh-host' | 'serial';
  fingerprint: string | null;
  seen_fingerprint: string | null;
}

/** Reconcile a force-added device before its first collection writes device data. */
export async function resolveUnknownDeviceSerial(device: DeviceRow, reported: string | null): Promise<Resolution> {
  const serial = reported?.trim() || null;
  return transaction(async (client) => {
    if (serial) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [normalizeSerial(serial)]);
    const candidateResult = await client.query<Candidate>(
      'SELECT * FROM devices WHERE id = $1 FOR UPDATE', [device.id],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) return { action: 'gone' };
    if (candidate.status === 'disabled') return { action: 'gone' };
    if (!candidate.force_add_pending) return { action: 'gone' };
    if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
    if (candidate.ip_address !== device.ip_address || candidate.api_port !== device.api_port ||
        candidate.api_username !== device.api_username || candidate.api_password_encrypted !== device.api_password_encrypted ||
        (candidate.api_tls ?? null) !== (device.api_tls ?? null) ||
        candidate.jump_host_id !== device.jump_host_id || candidate.ssh_only !== device.ssh_only ||
        (candidate.ssh_port ?? null) !== (device.ssh_port ?? null) ||
        (candidate.ssh_username ?? null) !== (device.ssh_username ?? null) ||
        (candidate.ssh_password_encrypted ?? null) !== (device.ssh_password_encrypted ?? null)) {
      throw new Error('Device connection settings changed during the first poll; retry the poll.');
    }

    if (!serial) return { action: 'continue' };
    const matches = (await client.query<Candidate>(
      `SELECT d.* FROM devices d
       LEFT JOIN device_identity_pins p ON p.device_id = d.id AND p.kind = 'serial'
       WHERE d.id <> $1 AND (UPPER(BTRIM(d.serial_number)) = $2 OR UPPER(BTRIM(p.fingerprint)) = $2)
       ORDER BY d.id FOR UPDATE OF d`,
      [device.id, normalizeSerial(serial)],
    )).rows;
    if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
    if (!matches.length) {
      await client.query(
        'UPDATE devices SET serial_number = COALESCE($2, serial_number) WHERE id = $1',
        [device.id, serial],
      );
      return { action: 'continue' };
    }

    const flag = async (message: string): Promise<Resolution> => {
      await client.query("UPDATE devices SET status = 'disabled', updated_at = NOW() WHERE id = $1", [device.id]);
      await client.query(
        `INSERT INTO events (device_id, event_time, severity, topic, message)
         VALUES ($1, NOW(), 'warning', 'manager,security', $2)`,
        [device.id, message],
      );
      return { action: 'flagged' };
    };

    if (matches.length !== 1 || candidate.site_id !== matches[0].site_id) {
      return flag('A duplicate serial was found in another site or on multiple devices. Automatic reconciliation was stopped; contact an administrator.');
    }
    const existing = matches[0];
    if (existing.serial_number && normalizeSerial(existing.serial_number) !== normalizeSerial(serial)) {
      return flag('A duplicate serial was found, but the existing device has a conflicting recorded serial. Automatic reconciliation was stopped; contact an administrator.');
    }
    if (existing.status === 'online') {
      await client.query(
        `INSERT INTO events (device_id, event_time, severity, topic, message)
         VALUES ($1, NOW(), 'info', 'manager', $2)`,
        [existing.id, `A force-added duplicate at ${candidate.ip_address} was removed because this device is online.`],
      );
      if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
      await client.query('DELETE FROM devices WHERE id = $1', [candidate.id]);
      return { action: 'removed', deviceId: existing.id, disabled: false };
    }

    const pins = (await client.query<Pin>(
      `SELECT device_id, kind, fingerprint, seen_fingerprint FROM device_identity_pins
       WHERE device_id = ANY($1::int[])`,
      [[candidate.id, existing.id]],
    )).rows;
    const oldPins = pins.filter((pin) => pin.device_id === existing.id);
    const newPins = pins.filter((pin) => pin.device_id === candidate.id);
    const incompatible = oldPins.some((old) => {
      const observed = newPins.find((pin) => pin.kind === old.kind);
      if (old.seen_fingerprint) return true;
      if (old.kind === 'serial' && old.fingerprint && old.fingerprint !== normalizeSerial(serial)) return true;
      if (old.fingerprint && observed?.fingerprint && old.fingerprint !== observed.fingerprint) return true;
      if (old.kind === 'api-tls' && old.fingerprint && !candidate.ssh_only &&
          (!usesApiTls(candidate) || !observed?.fingerprint)) return true;
      if (old.kind === 'api-tls' && old.fingerprint && candidate.ssh_only &&
          (candidate.api_tls === false ||
           (candidate.api_tls == null && ![0, 8728, 8729].includes(candidate.api_port)))) return true;
      return old.kind === 'ssh-host' && !!old.fingerprint && !!candidate.ssh_only && !observed?.fingerprint;
    });
    if (incompatible) {
      return flag('A duplicate serial was found, but its identity does not match the existing device. Automatic reconciliation was stopped; contact an administrator.');
    }
    if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
    await client.query(
      `UPDATE devices AS target SET
         name = source.name, name_locked = source.name_locked, ip_address = source.ip_address,
         api_port = source.api_port, api_tls = source.api_tls, api_username = source.api_username,
         api_password_encrypted = source.api_password_encrypted, ssh_port = source.ssh_port,
         ssh_username = source.ssh_username, ssh_password_encrypted = source.ssh_password_encrypted,
         serial_number = COALESCE(target.serial_number, $3),
         device_type = source.device_type, notes = source.notes, ssh_only = source.ssh_only,
         jump_host_id = source.jump_host_id, updated_at = NOW()
       FROM devices AS source WHERE target.id = $1 AND source.id = $2`,
      [existing.id, candidate.id, serial],
    );
    await client.query(
      `INSERT INTO device_tags (device_id, tag_id)
       SELECT $1, tag_id FROM device_tags WHERE device_id = $2 ON CONFLICT DO NOTHING`,
      [existing.id, candidate.id],
    );
    await client.query(
      `INSERT INTO device_identity_pins (device_id, kind, fingerprint, pinned_at, seen_fingerprint, mismatch_at)
       SELECT $1, kind, fingerprint, pinned_at, seen_fingerprint, mismatch_at
       FROM device_identity_pins WHERE device_id = $2 ON CONFLICT (device_id, kind) DO NOTHING`,
      [existing.id, candidate.id],
    );
    await client.query(
      `INSERT INTO events (device_id, event_time, severity, topic, message)
       VALUES ($1, NOW(), 'info', 'manager', $2)`,
      [existing.id, `A force-added device at ${candidate.ip_address} was merged into this record while it was not online, after its serial matched.`],
    );
    if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
    await client.query('DELETE FROM devices WHERE id = $1', [candidate.id]);
    return { action: 'merged', deviceId: existing.id, disabled: existing.status === 'disabled' };
  });
}
