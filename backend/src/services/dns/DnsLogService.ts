// Pulls DNS query logs from AdGuard Home (#366 step 3) every minute, for each
// enabled source, and keeps their totals: lookups per hour, client and name,
// and which names answered with which addresses (adguardLog.ts).
//
// Only newer entries are read each time: the log is paged newest first until
// the last poll's newest entry, up to a bound, so a long outage or a first
// poll of a busy server can't read for minutes.

import http from 'http';
import https from 'https';
import { query } from '../../config/database';
import { unseal } from '../../utils/sealed';
import { summarise, type QueryLogItem } from './adguardLog';

export const POLL_MS = 60_000;
const PAGE = 1000;
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 32 * 1024 * 1024;
/** A first poll reads back this far, at most. */
const FIRST_POLL_MS = 3_600_000;

export interface DnsSourceRow {
  id: number;
  name: string;
  site_id: number;
  url: string;
  username: string;
  password: string;
  tls_verify: boolean;
  enabled: boolean;
  /** pg returns timestamptz as a Date. */
  cursor_at: Date | string | null;
}

/** GET a JSON document with basic auth. */
export function getJson(url: string, user: string, pass: string, tlsVerify: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      timeout: TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        ...(user || pass ? { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } : {}),
      },
      ...(u.protocol === 'https:' ? { rejectUnauthorized: tlsVerify } : {}),
    };
    const onResponse = (res: http.IncomingMessage) => {
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); reject(new Error('AdGuard Home refused the username or password')); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`AdGuard Home answered HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new Error('The answer was too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('The answer wasn\'t JSON. Is this the AdGuard Home address?')); }
      });
    };
    // Named in full, so the guard on outbound connections (jumpHostRoutes.test) sees both.
    const req = u.protocol === 'https:' ? https.get(u, opts, onResponse) : http.get(u, opts, onResponse);
    req.on('timeout', () => req.destroy(new Error('No answer within 15 seconds')));
    req.on('error', reject);
  });
}

/** The query log endpoint for a source's base address. */
export function querylogUrl(base: string, olderThan?: string): string {
  const u = new URL(base.replace(/\/+$/, '') + '/control/querylog');
  u.searchParams.set('limit', String(PAGE));
  if (olderThan) u.searchParams.set('older_than', olderThan);
  return u.toString();
}

/** Read entries newer than `since`, newest first, page by page. */
export async function readNewEntries(src: Pick<DnsSourceRow, 'url' | 'username' | 'password' | 'tls_verify'>, since: number): Promise<QueryLogItem[]> {
  const pass = src.password ? unseal(src.password) : '';
  const items: QueryLogItem[] = [];
  let olderThan: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(querylogUrl(src.url, olderThan), src.username, pass, src.tls_verify) as { data?: unknown; oldest?: unknown };
    const data = Array.isArray(body?.data) ? body.data as QueryLogItem[] : null;
    if (!data) throw new Error('The answer had no query log. Is this the AdGuard Home address?');
    items.push(...data);
    const oldest = data.length ? Date.parse(data[data.length - 1].time ?? '') : NaN;
    if (data.length < PAGE || !Number.isFinite(oldest) || oldest <= since) break;
    olderThan = data[data.length - 1].time;
  }
  return items;
}

async function store(siteId: number, counts: ReturnType<typeof summarise>['counts'], answers: ReturnType<typeof summarise>['answers']): Promise<void> {
  if (counts.length) {
    await query(
      `INSERT INTO dns_name_counts (hour, site_id, client_ip, name, allowed, blocked)
       SELECT u.hour, $1, u.client_ip, u.name, u.allowed, u.blocked
         FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int[], $6::int[]) AS u(hour, client_ip, name, allowed, blocked)
       ON CONFLICT (hour, site_id, client_ip, name) DO UPDATE SET
         allowed = dns_name_counts.allowed + EXCLUDED.allowed,
         blocked = dns_name_counts.blocked + EXCLUDED.blocked`,
      [siteId, counts.map((c) => c.hour), counts.map((c) => c.clientIp), counts.map((c) => c.name),
        counts.map((c) => c.allowed), counts.map((c) => c.blocked)]);
  }
  if (answers.length) {
    await query(
      `INSERT INTO dns_answers (site_id, client_ip, ip, name, first_seen, last_seen, count)
       SELECT $1, u.client_ip, u.ip, u.name, u.first_seen, u.last_seen, u.count
         FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::int[])
           AS u(client_ip, ip, name, first_seen, last_seen, count)
       ON CONFLICT (site_id, ip, client_ip, name) DO UPDATE SET
         first_seen = LEAST(dns_answers.first_seen, EXCLUDED.first_seen),
         last_seen  = GREATEST(dns_answers.last_seen, EXCLUDED.last_seen),
         count      = dns_answers.count + EXCLUDED.count`,
      [siteId, answers.map((a) => a.clientIp), answers.map((a) => a.ip), answers.map((a) => a.name),
        answers.map((a) => a.first), answers.map((a) => a.last), answers.map((a) => a.count)]);
  }
}

/**
 * The saved cursor in milliseconds. pg hands back a Date, and Date.parse() of
 * one goes through its string form, which drops the milliseconds: every
 * entry in the cursor's last second was then counted again on each poll.
 */
export function cursorMs(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Poll one source now: read what's new, keep its totals, move the cursor. */
export async function pollSource(src: DnsSourceRow): Promise<{ used: number }> {
  const since = cursorMs(src.cursor_at) ?? Date.now() - FIRST_POLL_MS;
  try {
    const items = await readNewEntries(src, since);
    const { counts, answers, newest, used } = summarise(items, since);
    await store(src.site_id, counts, answers);
    await query(
      `UPDATE dns_sources SET cursor_at = COALESCE($2, cursor_at, NOW()), last_polled_at = NOW(), last_error = NULL,
              queries_counted = queries_counted + $3 WHERE id = $1`,
      [src.id, newest !== null ? new Date(newest).toISOString() : null, used]);
    return { used };
  } catch (e) {
    await query(`UPDATE dns_sources SET last_polled_at = NOW(), last_error = $2 WHERE id = $1`,
      [src.id, (e as Error).message.slice(0, 500)]).catch(() => {});
    throw e;
  }
}

class DnsLogService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sources = await query<DnsSourceRow>(`SELECT * FROM dns_sources WHERE enabled ORDER BY id`).catch(() => []);
      for (const src of sources) {
        await pollSource(src).catch((e) => console.warn(`[DNS] ${src.name}: ${(e as Error).message}`));
      }
    } finally {
      this.running = false;
    }
  }
}

export const dnsLogService = new DnsLogService();
