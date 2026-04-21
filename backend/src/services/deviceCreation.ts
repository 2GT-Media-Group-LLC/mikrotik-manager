import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { parsePort } from '../utils/parsePort';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import type { PollerService } from './PollerService';
import type { CredentialPresetRow } from '../routes/credentialPresets';

async function loadCredentialPreset(
  id: number | null | undefined
): Promise<{
  api_username: string;
  api_password: string;
  api_port: number | null;
  ssh_username: string | null;
  ssh_password: string | null;
  ssh_port: number | null;
} | null> {
  if (id === null || id === undefined) return null;
  const preset = await queryOne<CredentialPresetRow>(
    `SELECT * FROM credential_presets WHERE id = $1`,
    [id]
  );
  if (!preset) throw new Error(`Credential preset ${id} not found`);
  return {
    api_username: preset.api_username,
    api_password: decrypt(preset.api_password_encrypted),
    api_port: preset.api_port,
    ssh_username: preset.ssh_username,
    ssh_password: preset.ssh_password_encrypted ? decrypt(preset.ssh_password_encrypted) : null,
    ssh_port: preset.ssh_port,
  };
}

export interface CreateDeviceInput {
  name?: string;
  ip_address?: string;
  device_type?: string;
  notes?: string;
  credential_preset_id?: number | null;
  api_username?: string;
  api_password?: string;
  api_port?: unknown;
  ssh_username?: string | null;
  ssh_password?: string | null;
  ssh_port?: unknown;
  combine_with_device_id?: number;
  force_replace_existing_by_serial?: boolean;
}

export type CreateDeviceResult =
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Shared device creation logic used by POST /api/devices and bulk-add worker.
 */
export async function createDeviceFromBody(
  input: CreateDeviceInput,
  pollerService: PollerService | null
): Promise<CreateDeviceResult> {
  const {
    name,
    ip_address,
    device_type = 'router',
    notes,
    credential_preset_id,
  } = input;

  let preset: Awaited<ReturnType<typeof loadCredentialPreset>> = null;
  try {
    preset = await loadCredentialPreset(credential_preset_id ?? null);
  } catch (err) {
    return { ok: false, status: 400, body: { error: (err as Error).message } };
  }

  const api_username: string | undefined = preset?.api_username ?? input.api_username;
  const api_password: string | undefined = preset?.api_password ?? input.api_password;
  const api_port: number = preset?.api_port ?? parsePort(input.api_port, 8728);
  const ssh_username: string | null = preset ? preset.ssh_username : (input.ssh_username ?? null);
  const ssh_password: string | null = preset ? preset.ssh_password : (input.ssh_password ?? null);
  const ssh_port: number = preset?.ssh_port ?? parsePort(input.ssh_port, 22);
  const combineWithDeviceId =
    typeof input.combine_with_device_id === 'number' ? input.combine_with_device_id : null;
  const forceReplaceBySerial = input.force_replace_existing_by_serial === true;

  if (!name || !ip_address || !api_username || !api_password) {
    return {
      ok: false,
      status: 400,
      body: { error: 'name, ip_address, api_username, api_password are required' },
    };
  }

  const testClient = new RouterOSClient(ip_address, api_port, api_username, api_password, 10_000);
  let detectedSerial: string | null = null;
  try {
    await testClient.connect();
    const rb = await testClient.execute('/system/routerboard/print').catch(() => [] as Record<string, string>[]);
    detectedSerial = (rb[0]?.['serial-number'] || '').trim() || null;
  } catch (err) {
    return {
      ok: false,
      status: 422,
      body: { error: `Cannot connect to device: ${(err as Error).message}` },
    };
  } finally {
    testClient.disconnect();
  }

  if (detectedSerial) {
    const existingBySerial = await queryOne<{
      id: number;
      name: string;
      ip_address: string;
      serial_number: string;
    }>(
      `SELECT id, name, ip_address, serial_number
         FROM devices
        WHERE serial_number = $1`,
      [detectedSerial]
    );

    if (existingBySerial) {
      const shouldCombine =
        combineWithDeviceId != null && combineWithDeviceId === existingBySerial.id;
      if (!shouldCombine && !forceReplaceBySerial) {
        return {
          ok: false,
          status: 409,
          body: {
            error: 'duplicate_serial',
            code: 'duplicate_serial',
            existing_device: existingBySerial,
            candidate: {
              serial_number: detectedSerial,
              identity: name,
              ip_address,
            },
          },
        };
      }

      const encryptedPass = encrypt(api_password);
      const encryptedSshPass = ssh_password ? encrypt(ssh_password) : null;
      await query(
        `UPDATE devices SET
           name=COALESCE($1,name),
           ip_address=$2,
           api_port=$3,
           api_username=$4,
           api_password_encrypted=$5,
           ssh_port=$6,
           ssh_username=COALESCE($7,ssh_username),
           ssh_password_encrypted=COALESCE($8,ssh_password_encrypted),
           device_type=COALESCE($9,device_type),
           notes=COALESCE($10,notes),
           updated_at=NOW()
         WHERE id = $11`,
        [
          name,
          ip_address,
          api_port,
          api_username,
          encryptedPass,
          ssh_port,
          ssh_username,
          encryptedSshPass,
          device_type,
          notes || null,
          existingBySerial.id,
        ]
      );

      if (pollerService) {
        await pollerService.scheduleDeviceSync(existingBySerial.id, 'full');
      }

      const updatedExisting = await queryOne(
        `SELECT id, name, ip_address, api_port, api_username, model, serial_number,
                firmware_version, ros_version, device_type, status, last_seen, notes, created_at
         FROM devices WHERE id = $1`,
        [existingBySerial.id]
      );
      if (!updatedExisting) {
        return {
          ok: false,
          status: 500,
          body: {
            error: 'Duplicate merge succeeded but device row could not be reloaded',
            device_id: existingBySerial.id,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        body: { ...updatedExisting, merged_from_duplicate: true },
      };
    }
  }

  const encryptedPass = encrypt(api_password);
  const encryptedSshPass = ssh_password ? encrypt(ssh_password) : null;

  const rows = await query<{ id: number }>(
    `INSERT INTO devices (name, ip_address, api_port, api_username, api_password_encrypted,
                          ssh_port, ssh_username, ssh_password_encrypted, device_type, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown') RETURNING id`,
    [name, ip_address, api_port, api_username, encryptedPass,
     ssh_port, ssh_username || null, encryptedSshPass, device_type, notes || null]
  );

  const newId = rows[0].id;

  if (pollerService) {
    await pollerService.scheduleDeviceSync(newId, 'full');
  }

  const device = await queryOne(
    `SELECT id, name, ip_address, api_port, api_username, model, serial_number,
            firmware_version, ros_version, device_type, status, last_seen, notes, created_at
     FROM devices WHERE id = $1`,
    [newId]
  );

  return { ok: true, status: 201, body: device as Record<string, unknown> };
}
