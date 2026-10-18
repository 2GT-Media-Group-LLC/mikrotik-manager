/**
 * API sessions kept open between polls (#301).
 *
 * Every poll used to open its own connection: TCP, a TLS handshake that costs
 * the router an RSA signature, and a login, then a few millisecond-scale
 * commands, then a disconnect. Measured on the reference fleet, the setup was
 * 150-300 ms of a poll whose commands took 3-25 ms, paid three times a minute
 * per device (two fast polls and a log poll); over a WAN each round trip adds
 * the link's latency on top.
 *
 * Now a device keeps up to three sessions, one per lane: fast polls, log polls
 * and slow (or full) polls. They run on separate queues and often at the same
 * moment, so sharing one session would mostly mean waiting for it; a long slow
 * poll never holds up a fast one. A session is only reused when:
 *   - it is still connected and its reply stream is trusted (any error, timeout
 *     or cancelled command closes it rather than hand it on);
 *   - the device's address, port, login and TLS setting are what they were when
 *     it was opened (editing a device starts a fresh session);
 *   - no other poll is using it right now (that poll gets its own short-lived
 *     connection, the old way, so one job's timeout can't break another's).
 * The serial number is re-checked every ten minutes on a reused session, as it
 * is at every connect. Sessions idle for eleven minutes are closed.
 */
import { createHash } from 'crypto';
import { RouterOSClient } from './RouterOSClient';

export type SessionLane = 'fast' | 'logs' | 'slow';

interface Pooled {
  client: RouterOSClient;
  credKey: string;
  busy: boolean;
  lastUsed: number;
  lastVerified: number;
}

// Longer than the default slow poll interval (5 minutes) with room for a
// skipped cycle, or the slow lane's session would be closed just before each use.
const IDLE_MS = 11 * 60_000;
const REVERIFY_MS = 10 * 60_000;
const pool = new Map<string, Pooled>();

export interface SessionDevice {
  id: number; ip_address: string; api_port: number; api_username: string; api_password_encrypted: string;
}

/** What a session was opened for; any difference means a new one. */
function credentialKey(d: SessionDevice, tls: boolean): string {
  return createHash('sha256').update([d.ip_address, d.api_port, d.api_username, d.api_password_encrypted, tls ? 'tls' : 'plain'].join('|')).digest('hex');
}

export interface Lease {
  client: RouterOSClient;
  /** True when the session was opened just now and still needs connecting and checking. */
  fresh: boolean;
  /** True when a reused session is due its periodic serial-number check. */
  needsVerify: boolean;
  /** Give it back: kept for the next poll when `ok`, closed otherwise. */
  release(ok: boolean): void;
  markVerified(): void;
}

/**
 * A session for this device and lane, or null when the pooled one is in use
 * (the caller then connects on its own, as before).
 */
export function lease(d: SessionDevice, lane: SessionLane, tls: boolean, make: () => RouterOSClient): Lease | null {
  const k = `${d.id}:${lane}`;
  const credKey = credentialKey(d, tls);
  let entry = pool.get(k);
  if (entry && entry.busy) return null;
  if (entry && (entry.credKey !== credKey || !entry.client.isUsable())) {
    entry.client.disconnect();
    pool.delete(k);
    entry = undefined;
  }
  const fresh = !entry;
  if (!entry) {
    entry = { client: make(), credKey, busy: false, lastUsed: 0, lastVerified: 0 };
    pool.set(k, entry);
  }
  const e = entry;
  e.busy = true;
  return {
    client: e.client,
    fresh,
    needsVerify: !fresh && Date.now() - e.lastVerified > REVERIFY_MS,
    markVerified: () => { e.lastVerified = Date.now(); },
    release: (ok) => {
      e.busy = false;
      e.lastUsed = Date.now();
      if (!ok || !e.client.isUsable()) {
        e.client.disconnect();
        if (pool.get(k) === e) pool.delete(k);
      }
    },
  };
}

/** Close a device's pooled sessions (it was removed, or its connection settings changed). */
export function dropSessions(deviceId: number): void {
  for (const lane of ['fast', 'logs', 'slow'] as const) {
    const e = pool.get(`${deviceId}:${lane}`);
    if (e && !e.busy) { e.client.disconnect(); pool.delete(`${deviceId}:${lane}`); }
  }
}

export function pooledSessionCount(): number { return pool.size; }

// Close sessions nobody has used for a while.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pool) {
    if (!e.busy && now - e.lastUsed > IDLE_MS) { e.client.disconnect(); pool.delete(k); }
  }
}, 60_000).unref();
