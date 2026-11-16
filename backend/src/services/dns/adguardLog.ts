// AdGuard Home query log entries (#366 step 3), turned into what MikroTik
// Manager keeps: lookups per hour, client and name (allowed and blocked), and
// which name answered with which address. Free of sockets and the database so
// it can be tested on its own.

import net from 'net';

/** The part of an AdGuard Home /control/querylog item that is used. */
export interface QueryLogItem {
  time?: string;
  client?: string;
  question?: { name?: string; type?: string };
  answer?: Array<{ type?: string; value?: string }> | null;
  reason?: string;
}

export interface NameCount { hour: string; clientIp: string; name: string; allowed: number; blocked: number }
export interface AnswerSeen { clientIp: string; ip: string; name: string; first: string; last: string; count: number }

/**
 * Blocked, by AdGuard's reason: the Filtered* reasons. NotFiltered* and the
 * rewrites were answered.
 */
export function isBlocked(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('Filtered');
}

/** A query name as stored: lower case, without the root dot, at most 255 characters. */
export function cleanName(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (!n || n.length > 255 || !/^[a-z0-9_.*-]+$/.test(n)) return null;
  return n;
}

/** The DNS server itself (Pi-hole looks up its clients' names from 127.0.0.1): not a client. */
const isLoopback = (ip: string) => ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');

const hourOf = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000).toISOString();

/**
 * Totals for a batch of log items newer than `after` (exclusive). Returns the
 * newest time seen, to start the next poll from.
 */
export function summarise(items: QueryLogItem[], after: number | null): {
  counts: NameCount[]; answers: AnswerSeen[]; newest: number | null; used: number;
} {
  const counts = new Map<string, NameCount>();
  const answers = new Map<string, AnswerSeen>();
  let newest: number | null = null;
  let used = 0;
  for (const it of items) {
    const t = Date.parse(it.time ?? '');
    if (!Number.isFinite(t) || (after !== null && t <= after)) continue;
    // Read is read, counted or not: skipped entries mustn't be read again next poll.
    if (newest === null || t > newest) newest = t;
    const clientIp = typeof it.client === 'string' && net.isIP(it.client) && !isLoopback(it.client) ? it.client : null;
    const name = cleanName(it.question?.name);
    if (!clientIp || !name) continue;
    used++;
    const hour = hourOf(t);
    const k = `${hour}|${clientIp}|${name}`;
    const c = counts.get(k) ?? { hour, clientIp, name, allowed: 0, blocked: 0 };
    if (isBlocked(it.reason)) c.blocked++; else c.allowed++;
    counts.set(k, c);
    if (isBlocked(it.reason)) continue;
    // Addresses the name answered with (A and AAAA; a CNAME chain ends in them).
    const iso = new Date(t).toISOString();
    for (const a of it.answer ?? []) {
      if ((a.type !== 'A' && a.type !== 'AAAA') || typeof a.value !== 'string' || !net.isIP(a.value)) continue;
      const ak = `${clientIp}|${a.value}|${name}`;
      const seen = answers.get(ak);
      if (seen) {
        seen.count++;
        if (iso < seen.first) seen.first = iso;
        if (iso > seen.last) seen.last = iso;
      } else {
        answers.set(ak, { clientIp, ip: a.value, name, first: iso, last: iso, count: 1 });
      }
    }
  }
  return { counts: [...counts.values()], answers: [...answers.values()], newest, used };
}
