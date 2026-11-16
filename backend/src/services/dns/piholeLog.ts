// Pi-hole query log entries (#366 step 3, Pi-hole 6's /api/queries), turned
// into the shape adguardLog.ts counts. Pi-hole's log names the client, the
// query and whether it was blocked, but not the addresses a name answered
// with, so a Pi-hole source counts lookups and leaves naming destinations to
// AdGuard Home sources and the routers' DNS caches.

import type { QueryLogItem } from './adguardLog';

/** A /api/queries item, the fields used. */
export interface PiholeQuery {
  time?: number;
  domain?: string;
  type?: string;
  status?: string | null;
  client?: { ip?: string; name?: string | null };
}

/**
 * Pi-hole statuses that mean the query was blocked: by its lists (gravity,
 * regex, the deny list, including what deep CNAME inspection caught), by an
 * upstream that blocks, or by a special domain. Answered from the cache or
 * forwarded is allowed.
 */
export const PIHOLE_BLOCKED = new Set([
  'GRAVITY', 'REGEX', 'DENYLIST', 'GRAVITY_CNAME', 'REGEX_CNAME', 'DENYLIST_CNAME',
  'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA', 'EXTERNAL_BLOCKED_EDE15',
  'SPECIAL_DOMAIN', 'DBBUSY',
]);

export function fromPihole(items: PiholeQuery[]): QueryLogItem[] {
  return items.map((q) => ({
    time: typeof q.time === 'number' && Number.isFinite(q.time) ? new Date(q.time * 1000).toISOString() : undefined,
    client: q.client?.ip,
    question: { name: q.domain, type: q.type },
    answer: null,
    // In AdGuard's terms, which summarise() reads: Filtered* is blocked.
    reason: q.status && PIHOLE_BLOCKED.has(q.status) ? 'FilteredBlackList' : 'NotFilteredNotFound',
  }));
}
