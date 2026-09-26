import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { parsePort } from '../utils/parsePort';
import { safeConnectionError } from '../utils/safeClientError';
import { normalizeDeviceAddress } from '../utils/deviceAddress';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import type { PollerService } from './PollerService';
import type { CredentialPresetRow } from '../routes/credentialPresets';
import { DEVICE_BASE_COLUMNS } from './deviceColumns';

export type CreateDeviceContext = {
  /** JWT role of the caller ('admin' | 'operator' | 'viewer'). Preset use may be restricted for operators. */
  requestingUserRole?: string;
  /**
   * Site the device should join (issue #130). A device with no site is invisible
   * the moment any site is selected, so this must never be left unset: when the
   * caller has no active site we fall back to the default site in SQL.
   */
  siteId?: number | null;
};

async function loadCredentialPreset(
  id: number | null | undefined,
  ctx?: CreateDeviceContext
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
  const allowOp = (preset as CredentialPresetRow & { allow_operator_use?: boolean }).allow_operator_use !== false;
  if (ctx?.requestingUserRole === 'operator' && !allowOp) {
    const err = new Error('This credential preset is restricted to administrators');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
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
  /** Existing tag ids to put on the device once it is added (#161). Unknown ids are ignored. */
  tag_ids?: unknown;
}

export type CreateDeviceResult =
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Shared device creation logic used by POST /api/devices and bulk-add worker.
 * Tags are applied after either success path (a new device, or a duplicate
 * serial merged into an existing one).
 */
export async function createDeviceFromBody(
  input: CreateDeviceInput,
  pollerService: PollerService | null,
  ctx?: CreateDeviceContext
): Promise<CreateDeviceResult> {
  const result = await createDevice(input, pollerService, ctx);
  const deviceId = Number(result.body?.id);
  const tagIds = Array.isArray(input.tag_ids)
    ? input.tag_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (result.ok && Number.isInteger(deviceId) && tagIds.length) {
    // Only tags that exist; creating tags stays an admin action.
    await query(
      `INSERT INTO device_tags (device_id, tag_id)
       SELECT $1, t.id FROM tags t WHERE t.id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [deviceId, tagIds]
    ).catch((e) => console.warn(`[deviceCreation] tags not applied to ${deviceId}: ${(e as Error).message}`));
  }
  return result;
}

async function createDevice(
  input: CreateDeviceInput,
  pollerService: PollerService | null,
  ctx?: CreateDeviceContext
): Promise<CreateDeviceResult> {
  const {
    name,
    ip_address,
    device_type = 'router',
    notes,
    credential_preset_id,
  } = input;

  let preset: Awaited<ReturnType<typeof loadCredentialPreset>>;
  try {
    preset = await loadCredentialPreset(credential_preset_id ?? null, ctx);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 400;
    return { ok: false, status, body: { error: (err as Error).message } };
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

  // Accepts an IPv4/IPv6 literal or a hostname (DDNS name, public FQDN, etc.),
  // not only a LAN IP — connecting still happens by resolving at connect time,
  // so a DDNS name that moves keeps working without editing the device.
  const normalizedAddress = normalizeDeviceAddress(ip_address);
  if (!normalizedAddress.ok) {
    return { ok: false, status: 400, body: { error: normalizedAddress.reason } };
  }
  const address = normalizedAddress.address;

  const testClient = new RouterOSClient(address, api_port, api_username, api_password, 10_000);
  let detectedSerial: string | null;
  try {
    await testClient.connect();
    const rb = await testClient.execute('/system/routerboard/print').catch(() => [] as Record<string, string>[]);
    detectedSerial = (rb[0]?.['serial-number'] || '').trim() || null;
  } catch (err) {
    return {
      ok: false,
      status: 422,
      body: { error: safeConnectionError('createDeviceFromBody', err) },
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
              ip_address: address,
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
          address,
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
        `SELECT ${DEVICE_BASE_COLUMNS}, created_at FROM devices WHERE id = $1`,
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
                          ssh_port, ssh_username, ssh_password_encrypted, device_type, notes, status,
                          site_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown',
             COALESCE($11::int, (SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1)))
     RETURNING id`,
    [name, address, api_port, api_username, encryptedPass,
     ssh_port, ssh_username || null, encryptedSshPass, device_type, notes || null,
     ctx?.siteId ?? null]
  );

  const newId = rows[0].id;

  if (pollerService) {
    await pollerService.scheduleDeviceSync(newId, 'full');
  }

  const device = await queryOne(
    `SELECT ${DEVICE_BASE_COLUMNS}, created_at FROM devices WHERE id = $1`,
    [newId]
  );

  return { ok: true, status: 201, body: device as Record<string, unknown> };
}
