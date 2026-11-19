import { query } from '../config/database';
import { decrypt } from '../utils/crypto';
import { usesApiTls } from '../utils/apiTls';
import { pollJobAborted } from '../utils/pollJobContext';
import { classifyApiFailure, type ApiFailureKind } from '../utils/sshOnly';
import { hasPin } from './identityPins';
import { routeOf } from './jumpHosts';
import { connectPreferringSsl, API_PORT, API_SSL_PORT } from './mikrotik/apiConnect';
import { RouterOSClient } from './mikrotik/RouterOSClient';

export interface ApiCheckDevice {
  id: number;
  ip_address: string;
  api_port: number;
  api_tls?: boolean | null;
  api_username: string;
  api_password_encrypted: string;
  jump_host_id: number | null;
}

export type ApiCheck =
  | { ok: true; port: number; tlsFingerprint: string | null }
  | { ok: false; kind: ApiFailureKind; message: string };

/**
 * Can the manager log in to the API now? Tries API-SSL then the plain API,
 * unless the device was given another port or an explicit API-SSL choice. Short timeouts: on a fleet where
 * the API is firewalled every attempt waits the full time.
 */
export async function checkApi(device: ApiCheckDevice): Promise<ApiCheck> {
  const password = decrypt(device.api_password_encrypted);
  let client: RouterOSClient | undefined;
  try {
    let port: number;
    // A port of its own, or an explicit API-SSL choice (#257), is used as given.
    if (typeof device.api_tls === 'boolean' || (device.api_port !== 0 && device.api_port !== API_PORT && device.api_port !== API_SSL_PORT)) {
      const selectedPort = device.api_port || (device.api_tls ? API_SSL_PORT : API_PORT);
      client = new RouterOSClient(device.ip_address, selectedPort, device.api_username, password, 6_000, 30_000,
        usesApiTls({ api_port: selectedPort, api_tls: device.api_tls }),
        routeOf(device));
      await client.connect();
      port = selectedPort;
    } else {
      // A device that has presented an API-SSL certificate before stays on
      // API-SSL: blocking 8729 must not move it to the plain API (GHSA-63v6-w7qf-349f).
      const usedSsl = await hasPin(device.id, 'api-tls');
      const chosen = await connectPreferringSsl(device.ip_address, device.api_username, password,
        { sslTimeoutMs: 5_000, plainTimeoutMs: 6_000, sslOnly: usedSsl, jumpHostId: routeOf(device) });
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

/** Resolve the unspecified port of a force-added device on its first successful poll. */
export async function resolveUnspecifiedApiPort(device: ApiCheckDevice): Promise<number> {
  const check = await checkApi(device);
  if (pollJobAborted()) throw new Error('Poll cancelled: it ran past its time limit');
  if (!check.ok) throw new Error(check.message);
  const rows = await query<{ api_port: number }>(
    `UPDATE devices SET api_port = $2, updated_at = NOW()
      WHERE id = $1 AND api_port = 0 AND ip_address = $3
        AND api_username = $4 AND api_password_encrypted = $5
        AND api_tls IS NOT DISTINCT FROM $6 AND jump_host_id IS NOT DISTINCT FROM $7
      RETURNING api_port`,
    [device.id, check.port, device.ip_address, device.api_username, device.api_password_encrypted,
      device.api_tls ?? null, device.jump_host_id],
  );
  if (rows.length) return rows[0].api_port;
  // Another poll may have resolved the same unchanged device concurrently.
  const resolved = await query<{ api_port: number }>(
    `SELECT api_port FROM devices
      WHERE id = $1 AND api_port IN (8728, 8729) AND ip_address = $2
        AND api_username = $3 AND api_password_encrypted = $4
        AND api_tls IS NOT DISTINCT FROM $5 AND jump_host_id IS NOT DISTINCT FROM $6`,
    [device.id, device.ip_address, device.api_username, device.api_password_encrypted,
      device.api_tls ?? null, device.jump_host_id],
  );
  if (!resolved.length) throw new Error('Device connection settings changed while detecting its API port; retry the poll.');
  return resolved[0].api_port;
}
