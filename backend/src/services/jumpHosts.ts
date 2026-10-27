/**
 * Reaching devices through an SSH jump host.
 *
 * Some devices can't be reached from the manager at all; a router in front of
 * them can. The manager keeps one SSH connection to that router (the jump
 * host) and asks it to open a TCP connection onward for each session
 * (`forwardOut`, a direct-tcpip channel). The RouterOS API reads and writes
 * the channel as it would a socket, API-SSL runs TLS over it, and SSH to the
 * device runs over it as ssh2's `sock`. The router needs
 * `/ip ssh set forwarding-enabled=local`.
 *
 * Every device has exactly one route: its jump_host_id, or none for direct.
 * Nothing here ever falls back to a direct connection. When the jump host
 * can't be reached the device's connection fails with that reason, and the
 * poller marks it offline with it. A route that wasn't loaded (a query that
 * left out jump_host_id) is an error too, never read as "direct".
 *
 * One SSH connection per jump host is shared by every device behind it. A
 * jump host that fails is not retried until a backoff has passed (5 s,
 * doubling, at most 5 min); until then every device behind it fails at once
 * with the last error rather than each waiting out its own timeout. The
 * connection is opened again on the next use after that, and closed after a
 * quarter of an hour with nothing using it.
 *
 * The jump host's own SSH host key is pinned on its row: the one entered when
 * it was added, or else the first one seen. A different key refuses the
 * connection before the login is sent, and is recorded for an admin to
 * confirm, as for a device (identityPins.ts).
 */
import { createHash } from 'crypto';
import type { Duplex } from 'stream';
import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { query, queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';
import { normalizeFingerprint, sshFingerprintDisplay, sshHostKeyFingerprint } from './identityPins';

export interface JumpHostRow {
  id: number;
  name: string;
  site_id: number | null;
  host: string;
  port: number;
  username: string | null;
  password_encrypted: string | null;
  private_key_encrypted: string | null;
  passphrase_encrypted: string | null;
  credential_preset_id: number | null;
  host_key_fingerprint: string | null;
  seen_host_key_fingerprint: string | null;
}

/** Whatever names a device's route: a row from `devices`, or the form adding one. */
export interface Routed {
  jump_host_id?: number | null;
}

/** The jump host itself failed: down, refusing the login, or a changed host key. */
export class JumpHostError extends Error {
  readonly code = 'jump_host_unreachable';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JumpHostError';
  }
}

/**
 * The jump host a device is reached through, or null for direct.
 *
 * Throws when the row doesn't say: a query that didn't select jump_host_id
 * would otherwise send a device behind a jump host straight at its address.
 */
export function routeOf(device: Routed): number | null {
  if (device.jump_host_id === undefined) {
    throw new Error('The device\'s route was not loaded (jump_host_id), so the manager won\'t guess at a direct connection');
  }
  return device.jump_host_id;
}

/**
 * The route for a device being added or edited, from the request: a jump host
 * id, null (or empty) for direct, or, when the field was left out of a new
 * device, the site's default. Only a jump host of the device's own site, or a
 * fleet-wide one, may be used. Throws (statusCode 400) otherwise.
 */
export async function chooseJumpHost(value: unknown, siteId: number | null, opts: { siteDefault: boolean }): Promise<number | null> {
  if (value === undefined) {
    if (!opts.siteDefault) return null;
    const site = await queryOne<{ default_jump_host_id: number | null }>(
      `SELECT default_jump_host_id FROM sites WHERE id = COALESCE($1::int, (SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1))`,
      [siteId]);
    return site?.default_jump_host_id ?? null;
  }
  if (value === null || value === '') return null;
  const id = Number(value);
  const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  if (!Number.isInteger(id) || id < 1) throw fail('jump_host_id must be a jump host id, or null for a direct connection.');
  const row = await queryOne<{ site_id: number | null }>(`SELECT site_id FROM jump_hosts WHERE id = $1`, [id]);
  if (!row) throw fail(`Jump host ${id} not found.`);
  if (row.site_id != null) {
    const deviceSite = siteId ?? (await queryOne<{ id: number }>(`SELECT id FROM sites ORDER BY is_default DESC, id LIMIT 1`))?.id ?? null;
    if (row.site_id !== deviceSite) throw fail('That jump host belongs to another site.');
  }
  return id;
}

/** A fingerprint as an admin may paste it ("SHA256:…" or hex) as stored hex; null if it isn't one. */
export function parseHostKeyFingerprint(input: string): string | null {
  const s = input.trim();
  if (/^SHA256:/i.test(s)) {
    const raw = Buffer.from(s.slice(7), 'base64');
    return raw.length === 32 ? raw.toString('hex') : null;
  }
  const hex = normalizeFingerprint(s);
  return hex.length === 64 ? hex : null;
}

/** SSH_MSG_CHANNEL_OPEN_FAILURE reason codes (RFC 4254 §5.1). */
const OPEN_ADMINISTRATIVELY_PROHIBITED = 1;
const OPEN_CONNECT_FAILED = 2;

const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const IDLE_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 15_000;

/** Time to wait before the next attempt after `failures` failures in a row. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

interface Live {
  configKey: string;
  ready: Promise<SSHClient>;
  client: SSHClient;
  /** The host key this connection was accepted with. */
  fingerprint: string | null;
  channels: number;
  lastUsed: number;
}

interface Failure {
  configKey: string;
  error: JumpHostError;
  attempts: number;
  retryAt: number;
}

const live = new Map<number, Live>();
const failures = new Map<number, Failure>();

async function loadRow(id: number): Promise<JumpHostRow> {
  const row = await queryOne<JumpHostRow>(`SELECT * FROM jump_hosts WHERE id = $1`, [id]);
  if (!row) throw new JumpHostError(`Jump host #${id} no longer exists`);
  return row;
}

const label = (row: Pick<JumpHostRow, 'name' | 'host' | 'port'>): string => `Jump host "${row.name}" (${row.host}:${row.port})`;

interface JumpAuth {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** The login for a jump host: its own, or its credential preset's (the SSH login, else the API one). */
async function resolveAuth(row: JumpHostRow): Promise<JumpAuth & { presetKey: string }> {
  if (row.credential_preset_id != null) {
    const preset = await queryOne<{
      api_username: string; api_password_encrypted: string;
      ssh_username: string | null; ssh_password_encrypted: string | null;
    }>(
      `SELECT api_username, api_password_encrypted, ssh_username, ssh_password_encrypted
         FROM credential_presets WHERE id = $1`, [row.credential_preset_id]);
    if (!preset) throw new JumpHostError(`${label(row)} uses a credential preset that no longer exists`);
    const encrypted = preset.ssh_password_encrypted || preset.api_password_encrypted;
    return {
      username: row.username || preset.ssh_username || preset.api_username,
      password: decrypt(encrypted),
      presetKey: encrypted,
    };
  }
  if (!row.username) throw new JumpHostError(`${label(row)} has no username`);
  if (row.private_key_encrypted) {
    return {
      username: row.username,
      privateKey: decrypt(row.private_key_encrypted),
      ...(row.passphrase_encrypted ? { passphrase: decrypt(row.passphrase_encrypted) } : {}),
      presetKey: '',
    };
  }
  if (row.password_encrypted) return { username: row.username, password: decrypt(row.password_encrypted), presetKey: '' };
  throw new JumpHostError(`${label(row)} has no password or private key`);
}

/** What a connection was opened with; any difference means a new one. The pinned key is checked separately. */
function configKey(row: JumpHostRow, presetKey: string): string {
  return createHash('sha256').update([
    row.host, row.port, row.username ?? '', row.password_encrypted ?? '', row.private_key_encrypted ?? '',
    row.passphrase_encrypted ?? '', row.credential_preset_id ?? '', presetKey,
  ].join('|')).digest('hex');
}

/** ssh2's errors, in words that say what to fix. */
function describeSshFailure(err: Error & { code?: string; level?: string }): string {
  if (err.code === 'ECONNREFUSED') return 'it refused the SSH connection (is SSH enabled on that port?)';
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return 'it did not answer in time';
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return 'no route to it from the manager';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'its name could not be resolved';
  if (err.level === 'client-authentication') return 'it refused the login';
  return err.message;
}

async function recordHostKeyMismatch(row: JumpHostRow, fp: string): Promise<void> {
  if (row.seen_host_key_fingerprint === fp) return; // already recorded
  await query(
    `UPDATE jump_hosts SET seen_host_key_fingerprint = $2, host_key_mismatch_at = NOW() WHERE id = $1`, [row.id, fp]);
  const message = `${label(row)} presented a different SSH host key, so the manager stopped before sending its ` +
    `login. Devices behind it are offline until an admin checks the new key and trusts it under Operations → Credentials → Jump hosts.`;
  await query(
    `INSERT INTO events (device_id, event_time, severity, topic, message) VALUES (NULL, NOW(), 'critical', 'manager,security', $1)`,
    [message]).catch(() => {});
  // Loaded when needed: the alert service pulls in the whole route tree.
  const { alertService } = await import('./AlertService');
  void alertService.dispatch('device_identity_changed', message, {
    deviceName: row.name, cooldownKey: `jump_host_key_changed:${row.id}:${fp}`,
  });
}

/**
 * Check the jump host's key against its pin, pinning the first one seen.
 * Resolves the fingerprint accepted; rejects with the reason it wasn't.
 */
async function checkHostKey(row: JumpHostRow, key: Buffer): Promise<string> {
  const fp = sshHostKeyFingerprint(key);
  if (!row.host_key_fingerprint) {
    // Another connection may have pinned one meanwhile; only the first counts.
    const pinned = await query<{ id: number }>(
      `UPDATE jump_hosts SET host_key_fingerprint = $2 WHERE id = $1 AND host_key_fingerprint IS NULL RETURNING id`,
      [row.id, fp]);
    if (pinned.length) return fp;
    const now = await loadRow(row.id);
    if (now.host_key_fingerprint === fp) return fp;
    row = now;
  } else if (row.host_key_fingerprint === fp) {
    if (row.seen_host_key_fingerprint) {
      await query(`UPDATE jump_hosts SET seen_host_key_fingerprint = NULL, host_key_mismatch_at = NULL WHERE id = $1`, [row.id]);
    }
    return fp;
  }
  await recordHostKeyMismatch(row, fp);
  throw new JumpHostError(
    `${label(row)} presented SSH host key ${sshFingerprintDisplay(fp)}, not the pinned ` +
    `${sshFingerprintDisplay(row.host_key_fingerprint!)}, so the manager stopped before sending its login. ` +
    'If the router was reset or its host key regenerated, trust the new key under Operations → Credentials → Jump hosts.');
}

function connectJumpHost(row: JumpHostRow, auth: JumpAuth, key: string): Live {
  const client = new SSHClient();
  let hostKeyError: JumpHostError | null = null;
  const entry: Live = {
    configKey: key, client, fingerprint: null, channels: 0, lastUsed: Date.now(),
    ready: Promise.resolve(client),
  };
  entry.ready = new Promise<SSHClient>((resolve, reject) => {
    client.once('ready', () => resolve(client));
    client.once('error', (err: Error & { code?: string; level?: string }) => {
      reject(hostKeyError ?? new JumpHostError(`${label(row)} is unreachable: ${describeSshFailure(err)}`, { cause: err }));
    });
    client.once('close', () => {
      if (live.get(row.id) === entry) live.delete(row.id);
      reject(hostKeyError ?? new JumpHostError(`${label(row)} closed the connection`));
    });
    client.connect({
      host: row.host,
      port: row.port,
      username: auth.username,
      ...(auth.password !== undefined ? { password: auth.password } : {}),
      ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
      ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
      readyTimeout: READY_TIMEOUT_MS,
      // A jump host that disappears without closing (a dropped link) is noticed
      // within a minute, so its devices go offline instead of hanging.
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => {
        checkHostKey(row, hostKey).then(
          (fp) => { entry.fingerprint = fp; verify(true); },
          (err: unknown) => {
            hostKeyError = err instanceof JumpHostError
              ? err
              : new JumpHostError(`${label(row)}'s host key could not be checked: ${(err as Error).message}`);
            verify(false);
          });
      },
    });
  });
  return entry;
}

/** The shared SSH connection to a jump host, opened if need be. */
async function jumpClient(id: number): Promise<{ client: SSHClient; entry: Live; row: JumpHostRow }> {
  const row = await loadRow(id);
  const auth = await resolveAuth(row).catch((err: unknown) => {
    throw err instanceof JumpHostError ? err : new JumpHostError(`${label(row)}: ${(err as Error).message}`, { cause: err });
  });
  const key = configKey(row, auth.presetKey);

  const existing = live.get(id);
  if (existing) {
    // Reused only while nothing about the jump host changed, including the pin
    // the connection was accepted under.
    const pinMoved = existing.fingerprint !== null && row.host_key_fingerprint !== null
      && existing.fingerprint !== row.host_key_fingerprint;
    if (existing.configKey === key && !pinMoved) {
      return { client: await existing.ready, entry: existing, row };
    }
    live.delete(id);
    existing.client.end();
  }

  const failed = failures.get(id);
  if (failed && failed.configKey === key && Date.now() < failed.retryAt) {
    const wait = Math.ceil((failed.retryAt - Date.now()) / 1000);
    throw new JumpHostError(`${failed.error.message} (next attempt in ${wait}s)`, { cause: failed.error });
  }

  const entry = connectJumpHost(row, auth, key);
  live.set(id, entry);
  try {
    const client = await entry.ready;
    failures.delete(id);
    return { client, entry, row };
  } catch (err) {
    if (live.get(id) === entry) live.delete(id);
    entry.client.end();
    const error = err instanceof JumpHostError ? err : new JumpHostError(`${label(row)}: ${(err as Error).message}`, { cause: err });
    const attempts = failed && failed.configKey === key ? failed.attempts + 1 : 1;
    failures.set(id, { configKey: key, error, attempts, retryAt: Date.now() + backoffMs(attempts) });
    throw error;
  }
}

/**
 * A new TCP connection to host:port, opened by the jump host. Each call is a
 * channel of its own, so a check that needs a fresh connection to the device
 * (Change Guard) gets one.
 */
export async function openForwardedChannel(jumpHostId: number, host: string, port: number): Promise<ClientChannel> {
  const { client, entry, row } = await jumpClient(jumpHostId);
  return new Promise<ClientChannel>((resolve, reject) => {
    const failed = (err: Error & { reason?: number | string }) => {
      // RFC 4254 reason codes; the description that comes with them may be empty.
      if (err.reason === OPEN_ADMINISTRATIVELY_PROHIBITED || /prohibited/i.test(err.message)) {
        reject(new JumpHostError(`${label(row)} refused to forward connections. Allow it on that router with: ` +
          '/ip ssh set forwarding-enabled=local', { cause: err }));
      } else {
        // The jump host is up; what it couldn't reach is the device.
        const detail = err.message.replace(/^\(SSH\) Channel open failure:\s*/, '').trim()
          || (err.reason === OPEN_CONNECT_FAILED ? 'nothing accepted the connection' : 'the jump host could not open the connection');
        reject(new Error(`${label(row)} could not connect to ${host}:${port}: ${detail}`, { cause: err }));
      }
    };
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
        if (err) return failed(err);
        entry.channels++;
        entry.lastUsed = Date.now();
        channel.once('close', () => { entry.channels--; entry.lastUsed = Date.now(); });
        resolve(channel);
      });
    } catch (err) {
      // The connection closed between being handed out and used.
      reject(new JumpHostError(`${label(row)} closed the connection`, { cause: err }));
    }
  });
}

/**
 * Spread into ssh2's connect options for a device: nothing for a direct
 * device, or the forwarded channel to its SSH port as `sock`.
 *
 *   conn.connect({ host, port, ...await sshRoute(device, port), ...sshHostCheck(...), ...auth });
 */
export async function sshRoute(device: Routed & { ip_address: string }, port: number): Promise<{ sock?: Duplex }> {
  const via = routeOf(device);
  if (via == null) return {};
  return { sock: await openForwardedChannel(via, device.ip_address, port) };
}

/**
 * Connect to a jump host now, without the backoff, and report what happened:
 * for "Test connection" and after an admin changes or trusts it.
 */
export async function testJumpHost(id: number): Promise<{ ok: true; fingerprint: string | null } | { ok: false; error: string }> {
  failures.delete(id);
  dropJumpHost(id);
  try {
    const { entry } = await jumpClient(id);
    return { ok: true, fingerprint: entry.fingerprint };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Close a jump host's connection and forget its failures (it was changed or removed). */
export function dropJumpHost(id: number): void {
  failures.delete(id);
  const e = live.get(id);
  if (e) { live.delete(id); e.client.end(); }
}

/** Accept the host key last refused as the jump host's pin. Returns false if none was pending. */
export async function trustNewJumpHostKey(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE jump_hosts
        SET host_key_fingerprint = seen_host_key_fingerprint, seen_host_key_fingerprint = NULL,
            host_key_mismatch_at = NULL, updated_at = NOW()
      WHERE id = $1 AND seen_host_key_fingerprint IS NOT NULL
      RETURNING id`, [id]);
  if (rows.length) dropJumpHost(id);
  return rows.length > 0;
}

/** The state of each jump host's shared connection, for the settings page. */
export function jumpHostStatus(id: number): { state: 'connected' | 'idle' | 'failing'; error?: string; retryAt?: number; channels?: number } {
  const e = live.get(id);
  if (e && e.fingerprint !== null) return { state: 'connected', channels: e.channels };
  const f = failures.get(id);
  if (f) return { state: 'failing', error: f.error.message, retryAt: f.retryAt };
  return { state: 'idle' };
}

// Close connections nothing has used for a while.
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of live) {
    if (e.channels === 0 && now - e.lastUsed > IDLE_MS) { live.delete(id); e.client.end(); }
  }
}, 60_000).unref();
