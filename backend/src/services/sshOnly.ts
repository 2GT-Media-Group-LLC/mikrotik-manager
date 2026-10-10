/**
 * Devices added over SSH only (#174). See utils/sshOnly.ts for the pure half.
 *
 * While the API is off the poller calls pollSshOnlyDevice(): it reads the
 * device's basics over SSH (which is also how it knows the device is up), and
 * every so often tries the API. When the API answers, promoteToApi() turns the
 * device into an ordinary one and a full sync starts.
 */
import { query } from '../config/database';
import { decrypt } from '../utils/crypto';
import { fit } from '../utils/fit';
import { logSafe } from '../utils/logSafe';
import { runSshCommand, type SshExecDevice } from './sshExec';
import { RouterOSClient } from './mikrotik/RouterOSClient';
import { connectPreferringSsl, API_PORT, API_SSL_PORT } from './mikrotik/apiConnect';
import { pinIdentity } from './identityPins';
import {
  SSH_INFO_COMMAND, parseSshInfo, looksLikeRouterOs, classifyApiFailure,
  type SshInfo, type ApiFailureKind,
} from '../utils/sshOnly';

export interface SshOnlyDevice extends SshExecDevice {
  api_port: number;
  api_username: string;
  api_password_encrypted: string;
  name_locked?: boolean;
}

/** Read the device's basics over SSH. Throws when SSH fails or the login isn't to RouterOS. */
export async function readSshInfo(
  device: SshExecDevice,
  opts: { timeoutMs?: number; onHostKey?: (fingerprint: string) => void } = {},
): Promise<SshInfo> {
  const { output } = await runSshCommand(device, SSH_INFO_COMMAND, opts.timeoutMs ?? 20_000, { onHostKey: opts.onHostKey });
  const info = parseSshInfo(output);
  if (!looksLikeRouterOs(info)) {
    throw new Error('Logged in over SSH, but the device did not answer like RouterOS.');
  }
  return info;
}

export type ApiCheck =
  | { ok: true; port: number; tlsFingerprint: string | null }
  | { ok: false; kind: ApiFailureKind; message: string };

/**
 * Can the manager log in to the API now? Tries API-SSL then the plain API,
 * unless the device was given another port. Short timeouts: on a fleet where
 * the API is firewalled every attempt waits the full time.
 */
export async function checkApi(device: SshOnlyDevice): Promise<ApiCheck> {
  const password = decrypt(device.api_password_encrypted);
  let client: RouterOSClient | undefined;
  try {
    let port: number;
    if (device.api_port && device.api_port !== API_PORT && device.api_port !== API_SSL_PORT) {
      client = new RouterOSClient(device.ip_address, device.api_port, device.api_username, password, 6_000);
      await client.connect();
      port = device.api_port;
    } else {
      const chosen = await connectPreferringSsl(device.ip_address, device.api_username, password, { sslTimeoutMs: 5_000, plainTimeoutMs: 6_000 });
      client = chosen.client;
      port = chosen.port;
    }
    return { ok: true, port, tlsFingerprint: client.tlsFingerprint ?? null };
  } catch (err) {
    return { ok: false, ...classifyApiFailure(err) };
  } finally {
    client?.disconnect();
  }
}

/** Store the outcome of an API check that failed, for the device page. */
export async function recordApiCheck(deviceId: number, message: string | null): Promise<void> {
  await query(
    `UPDATE devices SET api_checked_at = NOW(), api_check_error = $2 WHERE id = $1`,
    [deviceId, message],
  );
}

/**
 * The API answers: from now on this is an ordinary device. The certificate seen
 * now is pinned (as when a device is added over the API), and the caller
 * schedules the full sync.
 */
export async function promoteToApi(device: SshOnlyDevice, check: Extract<ApiCheck, { ok: true }>): Promise<void> {
  await query(
    `UPDATE devices SET ssh_only = FALSE, api_port = $2, api_checked_at = NOW(), api_check_error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [device.id, check.port],
  );
  if (check.tlsFingerprint) await pinIdentity(device.id, 'api-tls', check.tlsFingerprint).catch(() => {});
  await query(
    `INSERT INTO events (device_id, event_time, severity, topic, message) VALUES ($1, NOW(), 'info', 'manager', $2)`,
    [device.id, `The RouterOS API now answers (port ${check.port}), so ${device.name.trim()} is managed over the API from now on.`],
  ).catch(() => {});
  console.log(`[sshOnly] ${logSafe(device.name)}: API answers on ${check.port}; no longer SSH only`);
}

/**
 * Keep an SSH-only device's details current: identity, version, model,
 * serial, as the API poll would. Marks it online; throws if SSH fails, which
 * the poller records as offline in the usual way.
 */
export async function refreshOverSsh(device: SshOnlyDevice): Promise<SshInfo> {
  const info = await readSshInfo(device);
  const name = !device.name_locked && info.identity ? info.identity : null;
  await query(
    `UPDATE devices SET
       status = 'online', last_seen = NOW(),
       name = COALESCE($2, name),
       model = COALESCE($3, model),
       serial_number = COALESCE(
         (SELECT $4::text WHERE NOT EXISTS (SELECT 1 FROM devices o WHERE o.serial_number = $4::text AND o.id <> $1)),
         serial_number),
       firmware_version = COALESCE($5, firmware_version),
       ros_version = COALESCE($6, ros_version),
       architecture = COALESCE($7, architecture),
       ros_identity = COALESCE($8, ros_identity),
       updated_at = NOW()
     WHERE id = $1`,
    [device.id, fit(name, 100), fit(info.model, 100), fit(info.serial, 50), fit(info.firmware, 50),
     fit(info.rosVersion, 20), fit(info.architecture, 32), fit(info.identity, 255)],
  );
  return info;
}
