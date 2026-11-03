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
import net from 'net';
import type { Duplex } from 'stream';
import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { query, queryOne } from '../config/database';
import { decrypt } from '../utils/crypto';
import { strictId } from '../utils/siteAccess';
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
  const id = strictId(value);
  const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  if (id === null) throw fail('jump_host_id must be a jump host id, or null for a direct connection.');
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
/**
 * How long the jump host may take to open a connection onward, unless whoever
 * asks has less time. A router gives up on a device that doesn't answer only
 * after its own TCP timeout, which can be minutes.
 */
const CHANNEL_OPEN_TIMEOUT_MS = 20_000;
/**
 * RouterOS opens a forwarded channel at once when it forwards, before it
 * tries the device, and never answers when it doesn't. A request left this
 * long unanswered means forwarding is off; one given less time (the rest went
 * on connecting to the jump host) says nothing.
 */
const ROUTEROS_OPENS_WITHIN_MS = 1_000;

/**
 * Noticing a jump host that disappears without closing (a dropped link), so
 * its devices go offline instead of hanging. After `intervalMs` with nothing
 * heard from it, it is asked something it must answer; nothing heard for
 * `misses` intervals more, the connection is closed. Shortened by tests.
 *
 * Not ssh2's keepalive: RouterOS never answers the keepalive@openssh.com
 * requests it sends, so ssh2 would close a working connection to a RouterOS
 * jump host every minute, taking whatever was using it along. What it asks
 * instead is to open a Unix socket channel, which RouterOS refuses at once,
 * forwarding on or off (it forwards none), as does OpenSSH for a socket that
 * isn't there.
 */
export const keepalive = { intervalMs: 15_000, misses: 3 };
const KEEPALIVE_SOCKET = '/nonexistent/mikrotik-manager-keepalive';

/** Time to wait before the next attempt after `failures` failures in a row. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

interface Live {
  configKey: string;
  ready: Promise<SSHClient>;
  client: SSHClient;
  /** Logged in and usable. */
  connected: boolean;
  /** Closed on purpose (changed, removed or idle), which is no failure of the jump host's. */
  closing: boolean;
  /** The host key this connection was accepted with. */
  fingerprint: string | null;
  /**
   * The jump host is RouterOS (it says "SSH-2.0-ROSSSH"). With forwarding
   * off, RouterOS doesn't refuse a forward; it never answers one.
   */
  routerOs: boolean;
  channels: number;
  /** Channels asked for that someone is still waiting on. */
  opening: number;
  /** Handed out no more (it won't forward); closed once nothing is on it. */
  retired: boolean;
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
/** Jump hosts that won't forward, until a forward through them works. */
const refusals = new Map<number, JumpHostError>();

/** Close a connection on purpose. */
function closeLive(id: number, e: Live): void {
  e.closing = true;
  if (live.get(id) === e) live.delete(id);
  e.client.end();
}

/**
 * Hand a connection out no more, so the next use opens another. It closes
 * once nothing is opening or using a channel on it: a channel already asked
 * for gets the jump host's own answer (or runs out of time), not "connection
 * closed".
 */
function retire(id: number, e: Live): void {
  e.retired = true;
  if (live.get(id) === e) live.delete(id);
  closeIfRetired(id, e);
}

function closeIfRetired(id: number, e: Live): void {
  if (e.retired && !e.closing && e.channels === 0 && e.opening === 0) closeLive(id, e);
}

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
    const username = row.username || preset.ssh_username || preset.api_username;
    return { username, password: decrypt(encrypted), presetKey: `${username}|${encrypted}` };
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
    configKey: key, client, connected: false, closing: false, fingerprint: null, routerOs: false, channels: 0, opening: 0,
    retired: false, lastUsed: Date.now(), ready: Promise.resolve(client),
  };
  entry.ready = new Promise<SSHClient>((resolve, reject) => {
    client.once('ready', () => { entry.connected = true; resolve(client); });
    // Kept for the connection's life: an 'error' with no listener would end the process.
    client.on('error', (err: Error & { code?: string; level?: string }) => {
      reject(hostKeyError ?? new JumpHostError(`${label(row)} is unreachable: ${describeSshFailure(err)}`, { cause: err }));
    });
    client.once('close', () => {
      entry.connected = false;
      if (live.get(row.id) === entry) live.delete(row.id);
      reject(hostKeyError ?? new JumpHostError(entry.closing
        ? `${label(row)} was changed or removed while connecting`
        : `${label(row)} closed the connection`));
    });
    // Our own socket, so anything arriving on it shows the jump host is there.
    const sock = net.connect({ host: row.host, port: row.port });
    let heard = Date.now();
    let start = '';
    sock.on('data', (data: Buffer) => {
      heard = Date.now();
      // What the server is comes first, in its identification line.
      if (start.length < 1024) {
        start += data.toString('latin1', 0, 1024);
        entry.routerOs = /^SSH-[\d.]+-ROSSSH/m.test(start);
      }
    });
    const watch = setInterval(() => {
      const quiet = Date.now() - heard;
      if (quiet > keepalive.intervalMs * (keepalive.misses + 1)) {
        sock.destroy(); // gone: its channels close, and the next use connects again
      } else if (quiet >= keepalive.intervalMs && entry.connected) {
        try {
          client.openssh_forwardOutStreamLocal(KEEPALIVE_SOCKET, (_err, ch) => ch?.destroy());
        } catch { /* closing */ }
      }
    }, keepalive.intervalMs);
    watch.unref();
    sock.once('close', () => clearInterval(watch));
    client.connect({
      sock,
      username: auth.username,
      ...(auth.password !== undefined ? { password: auth.password } : {}),
      ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
      ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
      // Only the login it has. ssh2 otherwise tries "none" first, which RouterOS
      // logs as a failed login (critical) every time the manager connects.
      authHandler: [auth.privateKey !== undefined ? 'publickey' : 'password'],
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 0,
      // ssh2 only sends the keepalive's Unix socket request to OpenSSH otherwise.
      strictVendor: false,
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

/**
 * The shared SSH connection to a jump host, opened if need be. Everything
 * awaited comes before the check for an open connection, and the check and
 * opening one happen together, so devices polled all at once (at startup)
 * share the first connection, or its failure, rather than each opening one.
 * A caller that can't wait past `until` stops waiting for the connection
 * then, which carries on for the next use.
 */
async function jumpClient(id: number, until = Infinity): Promise<{ client: SSHClient; entry: Live; row: JumpHostRow }> {
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
      return { client: await inTime(existing.ready, row, until), entry: existing, row };
    }
    closeLive(id, existing);
  }

  const failed = failures.get(id);
  if (failed && failed.configKey === key && Date.now() < failed.retryAt) {
    const wait = Math.ceil((failed.retryAt - Date.now()) / 1000);
    throw new JumpHostError(`${failed.error.message} (next attempt in ${wait}s)`, { cause: failed.error });
  }

  const entry = connectJumpHost(row, auth, key);
  live.set(id, entry);
  // Settled here whether or not anyone is still waiting, so a failure is
  // counted towards the backoff even when every caller gave up first.
  const ready = entry.ready.then(
    (client) => {
      failures.delete(id);
      return client;
    },
    (err: unknown) => {
      if (live.get(id) === entry) live.delete(id);
      entry.client.end();
      const error = err instanceof JumpHostError ? err : new JumpHostError(`${label(row)}: ${(err as Error).message}`, { cause: err });
      if (!entry.closing) {
        const attempts = failed && failed.configKey === key ? failed.attempts + 1 : 1;
        failures.set(id, { configKey: key, error, attempts, retryAt: Date.now() + backoffMs(attempts) });
      }
      throw error;
    },
  );
  return { client: await inTime(ready, row, until), entry, row };
}

/** `ready`, unless `until` comes first: the jump host didn't answer in time for this caller. */
function inTime<T>(ready: Promise<T>, row: JumpHostRow, until: number): Promise<T> {
  if (until === Infinity) return ready;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new JumpHostError(`${label(row)} is unreachable: it did not answer in time`)),
      Math.max(0, until - Date.now()),
    );
    ready.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * A new TCP connection to host:port, opened by the jump host. Each call is a
 * channel of its own, so a check that needs a fresh connection to the device
 * (Change Guard) gets one. Fails `timeoutMs` after the call without one,
 * connecting to the jump host first included, with the jump host's reason
 * where it has one; a channel that opens after that is closed straight away.
 */
export async function openForwardedChannel(
  jumpHostId: number, host: string, port: number, timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<ClientChannel> {
  const until = Date.now() + timeoutMs;
  const { client, entry, row } = await jumpClient(jumpHostId, until);
  // In use from here, so the idle sweep leaves the connection alone while the channel opens.
  entry.lastUsed = Date.now();
  // A device that doesn't take the connection fails with the code it would
  // have directly (ECONNREFUSED, ETIMEDOUT), so callers read the two alike:
  // API-SSL that isn't there falls back to the plain API through the jump host
  // as it does directly (GHSA-63v6-w7qf-349f), whatever words the jump host used.
  const deviceFailure = (message: string, code: string | undefined, cause?: Error) =>
    Object.assign(new Error(message, cause ? { cause } : undefined), code ? { code } : {});
  return new Promise<ClientChannel>((resolve, reject) => {
    entry.opening++;
    let settled = false;
    /** True only for the first answer, the jump host's or the timer's: the one the caller gets. */
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      entry.opening--;
      return true;
    };
    // Forwarding is off. With nothing else open on the connection, the next
    // use opens another: OpenSSH reads the setting as a connection starts, so
    // turning it on never reaches this one, and the requests RouterOS left
    // unanswered stay with it until it closes. With other channels open it
    // stays for them (for OpenSSH it's then only this destination: PermitOpen).
    const notForwarding = (refusal: JumpHostError) => {
      if (entry.channels === 0) {
        refusals.set(jumpHostId, refusal);
        retire(jumpHostId, entry);
      }
      reject(refusal);
    };
    const asked = Date.now();
    const timer = setTimeout(() => {
      if (!settle()) return;
      if (entry.routerOs && Date.now() - asked >= ROUTEROS_OPENS_WITHIN_MS) {
        notForwarding(new JumpHostError(`${label(row)} did not answer a request to forward a connection, which is what ` +
          'RouterOS does while forwarding is off. Allow it on that router with: /ip ssh set forwarding-enabled=local'));
      } else {
        reject(deviceFailure(`${label(row)} could not connect to ${host}:${port}: no answer within ${Math.max(1, Math.round(timeoutMs / 1000))}s`, 'ETIMEDOUT'));
      }
      closeIfRetired(jumpHostId, entry);
    }, Math.max(0, until - Date.now()));
    const failed = (err: Error & { reason?: number | string }) => {
      // RFC 4254 reason codes; the description that comes with them may be empty.
      if (err.reason === OPEN_ADMINISTRATIVELY_PROHIBITED || /prohibited/i.test(err.message)) {
        notForwarding(new JumpHostError(`${label(row)} refused to forward connections. Allow it on that router with: ` +
          '/ip ssh set forwarding-enabled=local', { cause: err }));
      } else {
        // The jump host is up; what it couldn't reach is the device.
        const said = err.message.replace(/^\(SSH\) Channel open failure:\s*/, '').trim();
        const detail = said
          || (err.reason === OPEN_CONNECT_FAILED ? 'nothing accepted the connection' : 'the jump host could not open the connection');
        const code = /timed? ?out/i.test(said) ? 'ETIMEDOUT'
          : /refused/i.test(said) || (!said && err.reason === OPEN_CONNECT_FAILED) ? 'ECONNREFUSED' : undefined;
        reject(deviceFailure(`${label(row)} could not connect to ${host}:${port}: ${detail}`, code, err));
      }
    };
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err, channel) => {
        if (!settle()) {
          channel?.destroy(); // too late: whoever asked has given up
          closeIfRetired(jumpHostId, entry);
          return;
        }
        if (err) {
          failed(err);
          closeIfRetired(jumpHostId, entry);
          return;
        }
        entry.channels++;
        entry.lastUsed = Date.now();
        refusals.delete(jumpHostId);
        channel.once('close', () => {
          entry.channels--;
          entry.lastUsed = Date.now();
          closeIfRetired(jumpHostId, entry);
        });
        // ssh2 emits 'close' only once what arrived has been read, so a channel
        // given up on unread (the device answered too late) would stay counted
        // for good: destroying one drains it.
        const destroy = channel.destroy.bind(channel);
        channel.destroy = () => { channel.resume(); return destroy(); };
        resolve(channel);
      });
    } catch (err) {
      // The connection closed between being handed out and used.
      settle();
      reject(new JumpHostError(`${label(row)} closed the connection`, { cause: err }));
    }
  });
}

/**
 * Spread into ssh2's connect options for a device: nothing for a direct
 * device, or the forwarded channel to its SSH port as `sock`. A caller with
 * less time than a channel may take passes what it has.
 *
 *   conn.connect({ host, port, ...await sshRoute(device, port), ...sshHostCheck(...), ...auth });
 */
export async function sshRoute(
  device: Routed & { ip_address: string }, port: number, timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<{ sock?: Duplex }> {
  const via = routeOf(device);
  if (via == null) return {};
  return { sock: await openForwardedChannel(via, device.ip_address, port, Math.min(timeoutMs, CHANNEL_OPEN_TIMEOUT_MS)) };
}

/**
 * How long Test waits for the jump host to answer a forward. A refusal is at
 * once, and so is RouterOS opening one (it doesn't answer at all with
 * forwarding off). Shortened by tests.
 */
export const forwardCheck = { timeoutMs: 5_000 };

/**
 * Connect to a jump host now, without the backoff (or use its open
 * connection), and report what happened: for "Test". `forwarding` is true
 * when it forwarded a connection to one of its devices, and null when no
 * device uses it to try with.
 */
export async function testJumpHost(id: number): Promise<
  { ok: true; fingerprint: string | null; forwarding: true | null } | { ok: false; error: string }
> {
  // A working connection is kept: the devices behind it are using it.
  failures.delete(id);
  try {
    const { entry } = await jumpClient(id);
    const forwarding = await checkForwarding(id);
    if (forwarding instanceof JumpHostError) return { ok: false, error: forwarding.message };
    return { ok: true, fingerprint: entry.fingerprint, forwarding };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Logging in says nothing about forwarding, which RouterOS has off by
 * default, so ask the jump host for a connection to one of its devices,
 * closed as soon as it opens. True when it forwards (a device that didn't
 * answer is the device's doing), the jump host's error when it doesn't,
 * null with no device to try.
 */
async function checkForwarding(id: number): Promise<true | null | JumpHostError> {
  const device = await queryOne<{ ip_address: string; api_port: number; ssh_port: number | null; ssh_only: boolean }>(
    `SELECT ip_address, api_port, ssh_port, ssh_only FROM devices WHERE jump_host_id = $1 ORDER BY id LIMIT 1`, [id]);
  if (!device) return null;
  const port = device.ssh_only ? (device.ssh_port ?? 22) : device.api_port;
  try {
    (await openForwardedChannel(id, device.ip_address, port, forwardCheck.timeoutMs)).destroy();
    return true;
  } catch (err) {
    return err instanceof JumpHostError ? err : true;
  }
}

/** Close a jump host's connection and forget its failures (it was changed or removed). */
export function dropJumpHost(id: number): void {
  failures.delete(id);
  refusals.delete(id);
  const e = live.get(id);
  if (e) closeLive(id, e);
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

/**
 * The state of each jump host's shared connection, for the settings page:
 * logged in, or refusing to forward through it, until a forward works.
 */
export function jumpHostStatus(id: number): {
  state: 'connected' | 'idle' | 'failing' | 'not_forwarding'; error?: string; retryAt?: number; channels?: number;
} {
  const refused = refusals.get(id);
  const e = live.get(id);
  if (e?.connected && !refused) return { state: 'connected', channels: e.channels };
  const f = failures.get(id);
  if (f) return { state: 'failing', error: f.error.message, retryAt: f.retryAt };
  if (refused) return { state: 'not_forwarding', error: refused.message };
  return { state: 'idle' };
}

/** Close the connections nothing has used for a while. */
export function closeIdleJumpHosts(now = Date.now()): void {
  for (const [id, e] of live) {
    if (e.channels === 0 && now - e.lastUsed > IDLE_MS) closeLive(id, e);
  }
}
setInterval(() => closeIdleJumpHosts(), 60_000).unref();
