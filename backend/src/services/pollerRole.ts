/**
 * What this process does with polling (#301), from POLLER_ROLE:
 *
 *   all     (default) everything: the API, the schedule, and poll workers.
 *   api     the API and the schedule; polls are left to worker containers.
 *   worker  poll workers only: no API, no schedule, no other timers. Run as
 *           many as the fleet needs, against the same Redis and Postgres.
 *
 * An unknown value is treated as `all`, so a typo can't stop polling.
 */
import { hostname } from 'os';
import { randomBytes } from 'crypto';

export type PollerRole = 'all' | 'api' | 'worker';

export function parsePollerRole(raw: string | undefined): PollerRole {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'api' || v === 'worker' ? v : 'all';
}

export const POLLER_ROLE: PollerRole = parsePollerRole(process.env.POLLER_ROLE);

/** This process, for the worker heartbeat: host name plus a few random bytes, as replicas share a name prefix. */
export const PROCESS_ID = `${hostname()}-${randomBytes(3).toString('hex')}`;

/** Live updates from worker processes reach the browser through the API process on this channel. */
export const EMIT_CHANNEL = 'mtm:poller:emit';
/** Each process running poll workers keeps a key here, so poller health counts them all. */
export const HEARTBEAT_PREFIX = 'mtm:poller:proc:';
