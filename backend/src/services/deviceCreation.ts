import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { parsePort } from '../utils/parsePort';
import { safeConnectionError } from '../utils/safeClientError';
import { normalizeDeviceAddress, reconcileAddressPort } from '../utils/deviceAddress';
import { logSafe } from '../utils/logSafe';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import type { PollerService } from './PollerService';
import type { CredentialPresetRow } from '../routes/credentialPresets';
import { DEVICE_BASE_COLUMNS } from './deviceColumns';
import { connectPreferringSsl, API_SSL_PORT } from './mikrotik/apiConnect';
import { pinIdentity } from './identityPins';
import { presetUseRefusal, type PresetCaller } from '../utils/presetAccess';
import { fit } from '../utils/fit';
import { parseSshOnlyFlag, classifyApiFailure, describeSshFailure, type SshInfo } from '../utils/sshOnly';
import { readSshInfo } from './sshOnly';

export type CreateDeviceContext = {
  /** JWT role of the caller ('admin' | 'operator' | 'viewer'). Preset use may be restricted for operators. */
  requestingUserRole?: string;
  /**
   * Who is applying a credential preset, for the site and admin-only checks
   * (#228). Without it the caller counts as a fleet admin only when
   * requestingUserRole is 'admin', and as nobody's site admin.
   */
  presetCaller?: PresetCaller;
  /**
   * Site the device should join (issue #130). A device with no site is invisible
   * the moment any site is selected, so this must never be left unset: when the
   * caller has no active site we fall back to the default site in SQL.
   */
  siteId?: number | null;
  /**
   * The sites the caller may touch, for a site-scoped account (P1-7); absent or
   * null for a fleet-wide one. A device already managed in another site is
   * neither revealed nor merged into.
   */
  allowedSites?: number[] | null;
};

export async function loadCredentialPreset(
  id: number | null | undefined,
  ctx?: CreateDeviceContext,
  /** The site of the device the preset is for (#228). */
  deviceSiteId?: number | null,
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
  // A caller that passes nothing gets least privilege: not an admin, and no
  // site's admin (the bulk-add worker once passed no role at all).
  const caller: PresetCaller = ctx?.presetCaller
    ?? { fleetAdmin: ctx?.requestingUserRole === 'admin', adminSites: [], memberSites: null };
  // The device's site: the one it's joining or in, else the default site
  // that a device with no site lands in.
  let deviceSite = deviceSiteId ?? null;
  if (deviceSite == null && preset.site_id != null) {
    deviceSite = (await queryOne<{ id: number }>(`SELECT id FROM sites WHERE is_default ORDER BY id LIMIT 1`))?.id ?? null;
  }
  const refusal = presetUseRefusal(caller, preset, deviceSite);
  if (refusal) {
    const err = new Error(refusal);
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
  /**
   * The API isn't enabled yet (#174): try it briefly, and if it doesn't answer,
   * add the device over SSH. A form checkbox, or an ssh_only CSV column.
   */
  ssh_only?: unknown;
}

export type CreateDeviceResult =
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Whether a newly-created (or duplicate-merged) device's `name` should stop
 * following the router's own /system/identity on every poll (see
 * DeviceCollector.collectSystemInfo) — i.e. whether an operator gave it a
 * name that was clearly a deliberate choice rather than a placeholder.
 *
 * Never locked when:
 *  - `name` is just the address (CSV import / Try All default an unnamed
 *    device to its address as typed — that's not a choice, it's "nothing was
 *    given"; compared case-insensitively, since normalizeDeviceAddress
 *    lowercases a hostname before it ever reaches here, so an unnamed
 *    "Router.Example.com" row must still count as a placeholder),
 *  - or the router's identity couldn't be read (fail open: keep the old
 *    always-follow behaviour rather than guess),
 *  - or `name` already matches the router's identity (nothing to lock —
 *    following it going forward changes nothing).
 * Locked otherwise: the operator typed something else on purpose.
 */
export function computeNameLocked(name: string, address: string, deviceIdentity: string | null): boolean {
  if (name.toLowerCase() === address.toLowerCase()) return false;
  if (!deviceIdentity) return false;
  return name !== deviceIdentity;
}

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
    preset = await loadCredentialPreset(credential_preset_id ?? null, ctx, ctx?.siteId ?? null);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 400;
    return { ok: false, status, body: { error: (err as Error).message } };
  }

  const sshOnlyRequested = parseSshOnlyFlag(input.ssh_only);
  // SSH only: one login is enough. It is used for SSH now and tried on the API
  // later, so the device can become ordinary without being edited (#174).
  const api_username: string | undefined = preset?.api_username ?? input.api_username
    ?? (sshOnlyRequested ? input.ssh_username ?? undefined : undefined);
  const api_password: string | undefined = preset?.api_password ?? input.api_password
    ?? (sshOnlyRequested ? input.ssh_password ?? undefined : undefined);
  let api_port: number = preset?.api_port ?? parsePort(input.api_port, 8728);
  const ssh_username: string | null = preset ? preset.ssh_username : (input.ssh_username ?? null);
  const ssh_password: string | null = preset ? preset.ssh_password : (input.ssh_password ?? null);
  const ssh_port: number = preset?.ssh_port ?? parsePort(input.ssh_port, 22);
  // Whether a port was actually given: a merge with an existing record keeps
  // its SSH port otherwise, instead of resetting it to 22 (outside review C2).
  const sshPortGiven: number | null = preset?.ssh_port
    ?? (input.ssh_port != null && input.ssh_port !== '' ? parsePort(input.ssh_port, 22) : null);
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
  const portCheck = reconcileAddressPort(normalizedAddress.port, preset?.api_port ?? input.api_port);
  if (!portCheck.ok) return { ok: false, status: 400, body: { error: portCheck.reason } };
  if (portCheck.port) api_port = portCheck.port;

  // No port chosen anywhere (form, preset, or written into the address): try
  // API-SSL first and fall back to the plain API (outside review P1-4). A port
  // that was chosen is used as given.
  const portChosen = preset?.api_port != null || (input.api_port != null && input.api_port !== '') || !!portCheck.port;
  let testClient: RouterOSClient | undefined;
  let sslFallbackReason: string | undefined;
  let detectedSerial: string | null;
  let deviceIdentity: string | null;
  // Set when the API didn't answer and the device was reached over SSH (#174).
  let sshInfo: SshInfo | null = null;
  let sshHostKey: string | null = null;
  let apiUnavailable: string | undefined;
  try {
    if (portChosen) {
      testClient = new RouterOSClient(address, api_port, api_username, api_password, sshOnlyRequested ? 6_000 : 10_000);
      await testClient.connect();
    } else {
      const chosen = await connectPreferringSsl(address, api_username, api_password,
        sshOnlyRequested ? { sslTimeoutMs: 5_000, plainTimeoutMs: 6_000 } : {});
      testClient = chosen.client;
      api_port = chosen.port;
      sslFallbackReason = chosen.sslError;
    }
    const rb = await testClient.execute('/system/routerboard/print').catch(() => [] as Record<string, string>[]);
    detectedSerial = (rb[0]?.['serial-number'] || '').trim() || null;
    const identity = await testClient.execute('/system/identity/print').catch((e) => {
      console.warn(`[deviceCreation] /system/identity/print failed for ${logSafe(address)}: ${logSafe((e as Error)?.message)}`);
      return [] as Record<string, string>[];
    });
    deviceIdentity = (identity[0]?.['name'] || '').trim() || null;
  } catch (err) {
    if (!sshOnlyRequested) {
      return {
        ok: false,
        status: 422,
        body: { error: safeConnectionError('createDeviceFromBody', err) },
      };
    }
    // The API is off, as expected: reach the device over SSH instead.
    apiUnavailable = classifyApiFailure(err).message;
    testClient?.disconnect();
    testClient = undefined;
    try {
      sshInfo = await readSshInfo({
        id: 0, name, ip_address: address, ssh_port,
        ssh_username: ssh_username || api_username,
        ssh_password_encrypted: encrypt(ssh_password || api_password),
      }, { onHostKey: (fp) => { sshHostKey = fp; } });
    } catch (sshErr) {
      console.warn(`[deviceCreation] SSH-only add of ${logSafe(address)} failed: ${logSafe((sshErr as Error).message)}`);
      return {
        ok: false,
        status: 422,
        body: { error: `The API didn't answer (${apiUnavailable.replace(/\.$/, '')}), and SSH failed too: ${describeSshFailure(sshErr, ssh_port)}` },
      };
    }
    detectedSerial = sshInfo.serial;
    deviceIdentity = sshInfo.identity?.trim() || null;
  } finally {
    // Unassigned only when connecting threw, and then there is nothing to close.
    testClient?.disconnect();
  }
  const nameLocked = computeNameLocked(name, address, deviceIdentity);
  // Reported with the new device so the UI can say which connection it got.
  const addedOverSsh = sshInfo !== null;
  const connection = addedOverSsh
    ? { ssh_only: true, api_unavailable: apiUnavailable }
    : { api_ssl: api_port === API_SSL_PORT, port: api_port, ...(sslFallbackReason ? { ssl_unavailable: sslFallbackReason } : {}),
        ...(sshOnlyRequested ? { api_answered: true } : {}) };
  // An SSH-only device keeps its SSH login explicitly (config history needs it).
  const sshUserToStore = addedOverSsh ? (ssh_username || api_username) : ssh_username;
  const sshPassToStore = addedOverSsh ? (ssh_password || api_password) : ssh_password;
  // The certificate seen while adding is the one pinned, so there is no gap
  // before the first poll in which a different one would be accepted (P1-4).
  const tlsFingerprint = testClient?.tlsFingerprint ?? null;

  if (detectedSerial) {
    const existingBySerial = await queryOne<{
      id: number;
      name: string;
      ip_address: string;
      serial_number: string;
      site_id: number | null;
    }>(
      `SELECT id, name, ip_address, serial_number, site_id
         FROM devices
        WHERE serial_number = $1`,
      [detectedSerial]
    );

    if (existingBySerial && ctx?.allowedSites && !ctx.allowedSites.includes(existingBySerial.site_id ?? -1)) {
      return {
        ok: false,
        status: 409,
        body: { error: 'This device is already managed in a site you do not have access to.', code: 'duplicate_serial_elsewhere' },
      };
    }

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
            existing_device: { id: existingBySerial.id, name: existingBySerial.name, ip_address: existingBySerial.ip_address, serial_number: existingBySerial.serial_number },
            candidate: {
              serial_number: detectedSerial,
              identity: name,
              ip_address: address,
            },
          },
        };
      }

      const encryptedPass = encrypt(api_password);
      const encryptedSshPass = sshPassToStore ? encrypt(sshPassToStore) : null;
      await query(
        `UPDATE devices SET
           name=COALESCE($1,name),
           name_locked=$2,
           ip_address=$3,
           api_port=$4,
           api_username=$5,
           api_password_encrypted=$6,
           ssh_port=COALESCE($7,ssh_port),
           ssh_username=COALESCE($8,ssh_username),
           ssh_password_encrypted=COALESCE($9,ssh_password_encrypted),
           device_type=COALESCE($10,device_type),
           notes=COALESCE($11,notes),
           ssh_only=$13,
           updated_at=NOW()
         WHERE id = $12`,
        [
          name,
          nameLocked,
          address,
          api_port,
          api_username,
          encryptedPass,
          sshPortGiven,
          sshUserToStore,
          encryptedSshPass,
          device_type,
          notes || null,
          existingBySerial.id,
          addedOverSsh,
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
        body: { ...updatedExisting, merged_from_duplicate: true, connection },
      };
    }
  }

  const encryptedPass = encrypt(api_password);
  const encryptedSshPass = sshPassToStore ? encrypt(sshPassToStore) : null;

  // The detected serial is stored with the new record (outside review C3).
  // It used to wait for the first poll, so adding the same device twice before
  // then, or twice in one batch, made two records. A unique index refuses the
  // second, including two adds racing each other.
  let rows: { id: number }[];
  try {
    rows = await query<{ id: number }>(
      `INSERT INTO devices (name, name_locked, ip_address, api_port, api_username, api_password_encrypted,
                            ssh_port, ssh_username, ssh_password_encrypted, device_type, notes, status,
                            site_id, serial_number, ssh_only, last_seen, model, ros_version, firmware_version,
                            architecture, ros_identity, api_checked_at, api_check_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $14::boolean THEN 'online' ELSE 'unknown' END,
               COALESCE($12::int, (SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1)), $13,
               $14::boolean, CASE WHEN $14::boolean THEN NOW() END, $15, $16, $17, $18, $19,
               CASE WHEN $14::boolean THEN NOW() END, $20)
       RETURNING id`,
      [name, nameLocked, address, api_port, api_username, encryptedPass,
       ssh_port, sshUserToStore || null, encryptedSshPass, device_type, notes || null,
       ctx?.siteId ?? null, detectedSerial, addedOverSsh,
       fit(sshInfo?.model, 100), fit(sshInfo?.rosVersion, 20), fit(sshInfo?.firmware, 50),
       fit(sshInfo?.architecture, 32), fit(sshInfo?.identity, 255), addedOverSsh ? apiUnavailable ?? null : null]
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && /serial/i.test(String((err as { constraint?: string }).constraint ?? ''))) {
      return {
        ok: false,
        status: 409,
        body: { error: 'A device with this serial number was added at the same moment. Refresh the device list.', code: 'duplicate_serial' },
      };
    }
    throw err;
  }

  const newId = rows[0].id;
  if (tlsFingerprint) await pinIdentity(newId, 'api-tls', tlsFingerprint).catch(() => {});
  // The SSH host key seen while adding is pinned the same way (#174).
  if (addedOverSsh && sshHostKey) await pinIdentity(newId, 'ssh-host', sshHostKey).catch(() => {});

  if (pollerService) {
    await pollerService.scheduleDeviceSync(newId, 'full');
  }

  const device = await queryOne(
    `SELECT ${DEVICE_BASE_COLUMNS}, created_at FROM devices WHERE id = $1`,
    [newId]
  );

  return { ok: true, status: 201, body: { ...(device as Record<string, unknown>), connection } };
}
