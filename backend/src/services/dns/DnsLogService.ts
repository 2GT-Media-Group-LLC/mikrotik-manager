// Pulls DNS query logs from AdGuard Home and Pi-hole (#366 step 3) every
// minute, for each enabled source, and keeps their totals: lookups per hour,
// client and name, and (AdGuard Home only, Pi-hole doesn't log them) which
// names answered with which addresses (adguardLog.ts). Any number of sources
// per site: active/active resolvers each see their own share of the lookups,
// so their counts add up to the site's.
//
// Only newer entries are read each time, newest first until the last poll's
// newest entry, up to a bound, so a long outage or a first poll of a busy
// server can't read for minutes.

import http from 'http';
import https from 'https';
import { query } from '../../config/database';
import { unseal } from '../../utils/sealed';
import { summarise, type QueryLogItem } from './adguardLog';
import { fromPihole, type PiholeQuery } from './piholeLog';

export const POLL_MS = 60_000;
const PAGE = 1000;
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 32 * 1024 * 1024;
/** A first poll reads back this far, at most. */
const FIRST_POLL_MS = 3_600_000;

export type DnsSourceKind = 'adguard' | 'pihole';
export const PRODUCT: Record<DnsSourceKind, string> = { adguard: 'AdGuard Home', pihole: 'Pi-hole' };

export interface DnsSourceRow {
  id: number;
  name: string;
  kind: DnsSourceKind;
  site_id: number;
  url: string;
  username: string;
  password: string;
  tls_verify: boolean;
  enabled: boolean;
  /** pg returns timestamptz as a Date. */
  cursor_at: Date | string | null;
}

type SourceLogin = Pick<DnsSourceRow, 'kind' | 'url' | 'username' | 'password' | 'tls_verify'> & { id?: number };

/** An HTTP request with a JSON answer: its status and parsed body. */
export function requestJson(url: string, opts: {
  method?: 'GET' | 'POST' | 'DELETE'; headers?: Record<string, string>; body?: unknown; tlsVerify: boolean; product: string;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const reqOpts = {
      method: opts.method ?? 'GET',
      timeout: TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...opts.headers,
      },
      ...(u.protocol === 'https:' ? { rejectUnauthorized: opts.tlsVerify } : {}),
    };
    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new Error('The answer was too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) { resolve({ status: res.statusCode ?? 0, body: null }); return; }
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch {
          reject(new Error(`The answer wasn't JSON. Is this the ${opts.product} address?`));
        }
      });
    };
    // Named in full, so the guard on outbound connections (jumpHostRoutes.test) sees both.
    const req = u.protocol === 'https:' ? https.request(u, reqOpts, onResponse) : http.request(u, reqOpts, onResponse);
    req.on('timeout', () => req.destroy(new Error('No answer within 15 seconds')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET a JSON document with basic auth (AdGuard Home). */
export async function getJson(url: string, user: string, pass: string, tlsVerify: boolean): Promise<unknown> {
  const r = await requestJson(url, {
    tlsVerify, product: 'AdGuard Home',
    headers: user || pass ? { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } : {},
  });
  if (r.status === 401 || r.status === 403) throw new Error('AdGuard Home refused the username or password');
  if (r.status !== 200) throw new Error(`AdGuard Home answered HTTP ${r.status}`);
  return r.body;
}

/** The AdGuard Home query log endpoint for a source's base address. */
export function querylogUrl(base: string, olderThan?: string, limit = PAGE): string {
  const u = new URL(base.replace(/\/+$/, '') + '/control/querylog');
  u.searchParams.set('limit', String(limit));
  if (olderThan) u.searchParams.set('older_than', olderThan);
  return u.toString();
}

async function readAdguard(src: SourceLogin, since: number, limit = PAGE, maxPages = MAX_PAGES): Promise<QueryLogItem[]> {
  const pass = src.password ? unseal(src.password) : '';
  const items: QueryLogItem[] = [];
  let olderThan: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = await getJson(querylogUrl(src.url, olderThan, limit), src.username, pass, src.tls_verify) as { data?: unknown };
    const data = Array.isArray(body?.data) ? body.data as QueryLogItem[] : null;
    if (!data) throw new Error('The answer had no query log. Is this the AdGuard Home address?');
    items.push(...data);
    const oldest = data.length ? Date.parse(data[data.length - 1].time ?? '') : NaN;
    if (data.length < limit || !Number.isFinite(oldest) || oldest <= since) break;
    olderThan = data[data.length - 1].time;
  }
  return items;
}

// ─── Pi-hole 6 ───────────────────────────────────────────────────────────────
// A login gives a session id valid for a while (30 minutes by default). It's
// kept and reused, since Pi-hole allows only a few sessions at once; one that
// has expired is replaced once.

const piholeSessions = new Map<number, { sid: string; until: number }>();

const base = (url: string) => url.replace(/\/+$/, '');

async function piholeLogin(src: SourceLogin): Promise<string> {
  const pass = src.password ? unseal(src.password) : '';
  const r = await requestJson(`${base(src.url)}/api/auth`, { method: 'POST', body: { password: pass }, tlsVerify: src.tls_verify, product: 'Pi-hole' });
  const session = (r.body as { session?: { valid?: boolean; sid?: string | null; validity?: number; message?: string; totp?: boolean } } | null)?.session;
  if (session?.valid && session.sid) {
    if (src.id !== undefined) piholeSessions.set(src.id, { sid: session.sid, until: Date.now() + Math.max(60, (session.validity ?? 300) - 60) * 1000 });
    return session.sid;
  }
  if (session?.totp) throw new Error('Pi-hole asks for a two-factor code. Use an app password from Pi-hole’s settings instead.');
  if (r.status === 401 || session) throw new Error('Pi-hole refused the password');
  throw new Error(r.status === 404 ? 'No Pi-hole 6 API there. Pi-hole 6 or later is needed.' : `Pi-hole answered HTTP ${r.status}`);
}

/** Log out a kept session (a source removed or changed). */
export async function dropPiholeSession(src: SourceLogin & { id: number }): Promise<void> {
  const s = piholeSessions.get(src.id);
  piholeSessions.delete(src.id);
  if (!s) return;
  await requestJson(`${base(src.url)}/api/auth`, { method: 'DELETE', headers: { 'X-FTL-SID': s.sid }, tlsVerify: src.tls_verify, product: 'Pi-hole' }).catch(() => {});
}

async function piholeGet(src: SourceLogin, path: string): Promise<unknown> {
  const kept = src.id !== undefined ? piholeSessions.get(src.id) : undefined;
  let sid = kept && kept.until > Date.now() ? kept.sid : await piholeLogin(src);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await requestJson(`${base(src.url)}${path}`, { headers: { 'X-FTL-SID': sid }, tlsVerify: src.tls_verify, product: 'Pi-hole' });
    if (r.status === 200) return r.body;
    if (r.status !== 401 || attempt > 0) throw new Error(`Pi-hole answered HTTP ${r.status}`);
    sid = await piholeLogin(src);   // the session ended early (Pi-hole restarted, or it was logged out)
  }
  throw new Error('Pi-hole refused the session');
}

async function readPihole(src: SourceLogin, since: number, length = PAGE, maxPages = MAX_PAGES): Promise<QueryLogItem[]> {
  const items: PiholeQuery[] = [];
  const from = Math.floor(since / 1000);
  let cursor: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ from: String(from), length: String(length), start: String(page * length) });
    if (cursor !== undefined) q.set('cursor', String(cursor));
    const body = await piholeGet(src, `/api/queries?${q}`) as { queries?: unknown; cursor?: unknown };
    const data = Array.isArray(body?.queries) ? body.queries as PiholeQuery[] : null;
    if (!data) throw new Error('The answer had no query log. Is this the Pi-hole address?');
    items.push(...data);
    // The cursor keeps the pages to one view of the log while it grows.
    if (cursor === undefined && typeof body.cursor === 'number') cursor = body.cursor;
    if (data.length < length) break;
  }
  return fromPihole(items);
}

/** Read entries newer than `since` from a source of either kind. */
export function readNewEntries(src: SourceLogin, since: number): Promise<QueryLogItem[]> {
  return src.kind === 'pihole' ? readPihole(src, since) : readAdguard(src, since);
}

/** Check an address and login: how many recent entries it answered with. */
export async function testSource(src: SourceLogin): Promise<number> {
  if (src.kind === 'pihole') {
    const sid = await piholeLogin(src);
    try {
      const r = await requestJson(`${base(src.url)}/api/queries?length=5`, { headers: { 'X-FTL-SID': sid }, tlsVerify: src.tls_verify, product: 'Pi-hole' });
      const qs = (r.body as { queries?: unknown } | null)?.queries;
      if (r.status !== 200 || !Array.isArray(qs)) throw new Error('That answered, but not with a query log. Is this the Pi-hole address?');
      return qs.length;
    } finally {
      // A test doesn't keep a session open.
      await requestJson(`${base(src.url)}/api/auth`, { method: 'DELETE', headers: { 'X-FTL-SID': sid }, tlsVerify: src.tls_verify, product: 'Pi-hole' }).catch(() => {});
    }
  }
  return (await readAdguard(src, Date.now(), 5, 1)).length;
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
