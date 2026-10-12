/**
 * Change the login the manager uses for many devices at once (#259).
 *
 * Only the manager's own records change: the devices are not touched. Each
 * device is logged in to with the new login first (over the API, or SSH for a
 * device added over SSH only) and updated only if that works, so a typo leaves
 * every device as it was rather than locking the manager out of them.
 */
import { query } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { logSafe } from '../utils/logSafe';
import { safeConnectionError } from '../utils/safeClientError';
import { usesApiTls } from '../utils/apiTls';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { loadCredentialPreset } from './deviceCreation';
import { readSshInfo } from './sshOnly';
import { describeSshFailure } from '../utils/sshOnly';
import type { PresetCaller } from '../utils/presetAccess';

export interface BulkCredentialsInput {
  /** A saved preset; or the login below. */
  credential_preset_id?: number | null;
  api_username?: string;
  api_password?: string;
  /** Optional. Given, they replace the SSH login; left out, it stays. */
  ssh_username?: string | null;
  ssh_password?: string | null;
}

export interface BulkCredentialsResult {
  id: number;
  name: string;
  ok: boolean;
  /** Why it wasn't changed. */
  error?: string;
}

interface DeviceRow {
  id: number; name: string; ip_address: string; site_id: number | null;
  api_port: number; api_tls: boolean | null; ssh_only: boolean; ssh_port: number | null;
  ssh_username: string | null; ssh_password_encrypted: string | null;
  api_username: string; api_password_encrypted: string;
}

/** Devices tested at once: each test is a login, and a big fleet shouldn't flood the network. */
const CONCURRENCY = 4;

export async function bulkUpdateCredentials(
  ids: number[], input: BulkCredentialsInput, caller: { role?: string; presetCaller: PresetCaller },
): Promise<BulkCredentialsResult[]> {
  const rows = await query<DeviceRow>(
    `SELECT id, name, ip_address, site_id, api_port, api_tls, ssh_only, ssh_port, ssh_username,
            ssh_password_encrypted, api_username, api_password_encrypted
       FROM devices WHERE id = ANY($1::int[]) ORDER BY name`, [ids]);

  const results: BulkCredentialsResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const d = rows[next++];
      results.push(await updateOne(d, input, caller));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

async function updateOne(
  d: DeviceRow, input: BulkCredentialsInput, caller: { role?: string; presetCaller: PresetCaller },
): Promise<BulkCredentialsResult> {
  const fail = (error: string): BulkCredentialsResult => ({ id: d.id, name: d.name, ok: false, error });

  // The same preset rules as adding and editing: a site's preset only on that
  // site's devices, admin-only presets only for admins.
  let preset: Awaited<ReturnType<typeof loadCredentialPreset>>;
  try {
    preset = await loadCredentialPreset(input.credential_preset_id ?? null,
      { requestingUserRole: caller.role, presetCaller: caller.presetCaller }, d.site_id);
  } catch (err) {
    return fail((err as Error).message);
  }
  const apiUser = preset?.api_username ?? input.api_username ?? '';
  const apiPass = preset?.api_password ?? input.api_password ?? '';
  if (!apiUser.trim() || !apiPass) return fail('No username and password to use.');
  // A preset replaces the SSH login wholesale (as editing does); typed SSH
  // fields replace it when given and leave it alone when not.
  const sshGiven = !!preset || input.ssh_username != null || input.ssh_password != null;
  const sshUser = preset ? preset.ssh_username : (input.ssh_username ?? d.ssh_username);
  const sshPass = preset ? preset.ssh_password
    : input.ssh_password != null ? input.ssh_password
      : d.ssh_password_encrypted ? decrypt(d.ssh_password_encrypted) : null;

  // Log in with the new login before saving anything.
  if (d.ssh_only) {
    try {
      await readSshInfo({
        id: d.id, name: d.name, ip_address: d.ip_address, ssh_port: d.ssh_port ?? 22,
        ssh_username: sshUser || apiUser,
        ssh_password_encrypted: encrypt(sshPass || apiPass),
      });
    } catch (err) {
      return fail(describeSshFailure(err, d.ssh_port ?? 22));
    }
  } else {
    const client = new RouterOSClient(d.ip_address, d.api_port, apiUser, apiPass, 10_000, 30_000, usesApiTls(d));
    try {
      await client.connect();
      await client.execute('/system/identity/print');
    } catch (err) {
      return fail(safeConnectionError('bulk credentials', err));
    } finally {
      client.disconnect();
    }
  }

  await query(
    `UPDATE devices SET api_username = $2, api_password_encrypted = $3,
            ssh_username = CASE WHEN $4 THEN $5 ELSE ssh_username END,
            ssh_password_encrypted = CASE WHEN $4 THEN $6 ELSE ssh_password_encrypted END,
            updated_at = NOW()
      WHERE id = $1`,
    [d.id, apiUser, encrypt(apiPass), sshGiven, sshUser || null, sshPass ? encrypt(sshPass) : null]);
  console.log(`[bulk-credentials] ${logSafe(d.name)}: login updated`);
  return { id: d.id, name: d.name, ok: true };
}
