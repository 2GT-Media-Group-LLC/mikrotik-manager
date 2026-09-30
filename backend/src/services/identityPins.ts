/**
 * Device identity pinning (outside review P1-4).
 *
 * The manager accepts any certificate on API-SSL and any SSH host key, so
 * someone who can intercept the connection could pose as the device and
 * collect its admin password. Now the certificate and host key a device
 * presents the first time are remembered ("pinned"), and every later
 * connection must present the same one. A different one stops the connection
 * before any credentials are sent, is recorded, and raises an alert; an admin
 * then confirms the change ("trust the new certificate") after checking it on
 * the device. The usual legitimate cause is a device reset or a regenerated
 * certificate.
 *
 * Pins are looked up by the address and port being connected to, which is how
 * every connection in the manager names its device, so no call site needs to
 * know about pinning.
 */
import { createHash } from 'crypto';
import { query } from '../config/database';
import { alertService } from './AlertService';
import { siteScopeDevices, type SiteScope } from '../utils/siteScope';

export type IdentityKind = 'api-tls' | 'ssh-host';

const KIND_LABEL: Record<IdentityKind, string> = {
  'api-tls': 'API-SSL certificate',
  'ssh-host': 'SSH host key',
};

export class IdentityMismatchError extends Error {
  readonly code = 'identity_changed';
  constructor(readonly kind: IdentityKind, deviceName: string) {
    super(
      `${deviceName}'s ${KIND_LABEL[kind]} has changed since the manager first connected, so the manager ` +
      `stopped before sending its login. If the device was reset or its ${kind === 'api-tls' ? 'certificate' : 'host key'} ` +
      `was replaced, check the new one and choose "Trust new ${kind === 'api-tls' ? 'certificate' : 'host key'}" on the device's page.`
    );
  }
}

/** Lowercase hex, no separators: how RouterOS prints a certificate fingerprint. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

/** "SHA256:…" base64, as `ssh-keygen -l` prints a host key fingerprint. */
export function sshFingerprintDisplay(hex: string): string {
  return `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`;
}

/** SHA-256 of a raw SSH host key, as hex. */
export function sshHostKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

interface PinRow {
  device_id: number;
  name: string;
  fingerprint: string | null;
  seen_fingerprint: string | null;
}

/**
 * Check the identity presented at host:port against the pin. Resolves if it
 * matches, or if nothing was pinned yet (it is pinned now); throws
 * IdentityMismatchError if it differs. An address the manager doesn't manage
 * yet (a device being added) passes unpinned.
 */
export async function verifyDeviceIdentity(
  kind: IdentityKind, host: string, port: number, presented: string,
): Promise<void> {
  const fp = normalizeFingerprint(presented);
  const portColumn = kind === 'api-tls' ? 'd.api_port' : 'COALESCE(d.ssh_port, 22)';
  const rows = await query<PinRow>(
    `SELECT d.id AS device_id, d.name, p.fingerprint, p.seen_fingerprint
       FROM devices d
       LEFT JOIN device_identity_pins p ON p.device_id = d.id AND p.kind = $1
      WHERE d.ip_address = $2 AND ${portColumn} = $3`,
    [kind, host, port],
  );
  for (const row of rows) {
    if (!row.fingerprint) {
      await pin(row.device_id, kind, fp);
      continue;
    }
    if (row.fingerprint === fp) {
      if (row.seen_fingerprint) {
        await query(
          `UPDATE device_identity_pins SET seen_fingerprint = NULL, mismatch_at = NULL WHERE device_id = $1 AND kind = $2`,
          [row.device_id, kind]);
      }
      continue;
    }
    await recordMismatch(row, kind, fp);
    throw new IdentityMismatchError(kind, row.name);
  }
}

/** Pin an identity seen before the device existed in the manager (while adding it). */
export async function pinIdentity(deviceId: number, kind: IdentityKind, presented: string): Promise<void> {
  await pin(deviceId, kind, normalizeFingerprint(presented));
}

async function pin(deviceId: number, kind: IdentityKind, fp: string): Promise<void> {
  await query(
    `INSERT INTO device_identity_pins (device_id, kind, fingerprint) VALUES ($1, $2, $3)
     ON CONFLICT (device_id, kind) DO NOTHING`,
    [deviceId, kind, fp]);
}

async function recordMismatch(row: PinRow, kind: IdentityKind, fp: string): Promise<void> {
  if (row.seen_fingerprint === fp) return; // already recorded and alerted
  await query(
    `UPDATE device_identity_pins SET seen_fingerprint = $3, mismatch_at = NOW() WHERE device_id = $1 AND kind = $2`,
    [row.device_id, kind, fp]);
  const message = `${row.name}'s ${KIND_LABEL[kind]} has changed. The manager has stopped connecting to it ` +
    `over ${kind === 'api-tls' ? 'API-SSL' : 'SSH'} until an admin confirms the new one.`;
  await query(
    `INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'critical', 'manager,security', $2)`,
    [row.device_id, message]).catch(() => {});
  void alertService.dispatch('device_identity_changed', message, {
    deviceId: row.device_id, deviceName: row.name, cooldownKey: `device_identity_changed:${row.device_id}:${kind}:${fp}`,
  });
}

/** Accept the changed identity as the device's pin. Returns false if there was none pending. */
export async function trustNewIdentity(deviceId: number, kind: IdentityKind): Promise<boolean> {
  const rows = await query<{ device_id: number }>(
    `UPDATE device_identity_pins
        SET fingerprint = seen_fingerprint, pinned_at = NOW(), seen_fingerprint = NULL, mismatch_at = NULL
      WHERE device_id = $1 AND kind = $2 AND seen_fingerprint IS NOT NULL
      RETURNING device_id`,
    [deviceId, kind]);
  return rows.length > 0;
}

/** Forget a pin, so the next connection pins afresh (the manager replaced it itself). */
export async function forgetIdentity(deviceId: number, kind: IdentityKind): Promise<void> {
  await query(`DELETE FROM device_identity_pins WHERE device_id = $1 AND kind = $2`, [deviceId, kind]);
}

export interface IdentityPinView {
  kind: IdentityKind;
  label: string;
  fingerprint: string;
  display: string;
  pinned_at: string;
  seen_fingerprint: string | null;
  seen_display: string | null;
  mismatch_at: string | null;
}

function view(r: { kind: IdentityKind; fingerprint: string; pinned_at: string; seen_fingerprint: string | null; mismatch_at: string | null }): IdentityPinView {
  const show = (fp: string) => (r.kind === 'ssh-host' ? sshFingerprintDisplay(fp) : fp);
  return {
    kind: r.kind,
    label: KIND_LABEL[r.kind],
    fingerprint: r.fingerprint,
    display: show(r.fingerprint),
    pinned_at: r.pinned_at,
    seen_fingerprint: r.seen_fingerprint,
    seen_display: r.seen_fingerprint ? show(r.seen_fingerprint) : null,
    mismatch_at: r.mismatch_at,
  };
}

export async function devicePins(deviceId: number): Promise<IdentityPinView[]> {
  const rows = await query<{ kind: IdentityKind; fingerprint: string; pinned_at: string; seen_fingerprint: string | null; mismatch_at: string | null }>(
    `SELECT kind, fingerprint, pinned_at, seen_fingerprint, mismatch_at FROM device_identity_pins WHERE device_id = $1 ORDER BY kind`,
    [deviceId]);
  return rows.map(view);
}

/** Every device with a changed identity waiting for an admin, for the Security page. */
export async function pendingIdentityChanges(siteId: SiteScope): Promise<Array<IdentityPinView & { device_id: number; device_name: string }>> {
  const scope = siteScopeDevices(siteId, 'd');
  const rows = await query<{ device_id: number; device_name: string; kind: IdentityKind; fingerprint: string; pinned_at: string; seen_fingerprint: string | null; mismatch_at: string | null }>(
    `SELECT p.device_id, d.name AS device_name, p.kind, p.fingerprint, p.pinned_at, p.seen_fingerprint, p.mismatch_at
       FROM device_identity_pins p JOIN devices d ON d.id = p.device_id
      WHERE p.seen_fingerprint IS NOT NULL${scope ? ` AND ${scope}` : ''}
      ORDER BY p.mismatch_at DESC`);
  return rows.map((r) => ({ ...view(r), device_id: r.device_id, device_name: r.device_name }));
}
