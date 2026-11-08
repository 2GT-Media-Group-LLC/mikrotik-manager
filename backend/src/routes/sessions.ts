// Session log (#415 step 2): connections from NetFlow, one row each, client
// to server, both directions paired. Written by the NetFlow collector; see
// services/netflow/sessions.ts.

import { Router, type Request } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { deviceSiteAccess } from '../utils/siteAccess';
import { siteScopeByNullableDevice } from '../utils/siteScope';
import { END_REASONS } from '../services/netflow/sessions';
import { netflowCollector } from '../services/netflow/NetflowCollector';

const router = Router();
router.use(requireAuth);

export const SESSIONS_MAX_LIMIT = 500;
/** Counting stops here; past it the page says "more than". */
export const SESSIONS_COUNT_CAP = 10_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

const PROTOCOLS: Record<string, number> = { tcp: 6, udp: 17, icmp: 1, icmpv6: 58, gre: 47, esp: 50 };

function one(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : null;
}

function int(v: string, min: number, max?: number): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) return null;
  return n;
}

type Parsed = { where: string[]; params: unknown[] } | { error: string };

/** Filters from the query string, as SQL over `s` (netflow_sessions) and `d` (devices). */
export function sessionFilters(req: Request): Parsed {
  const q = req.query;
  const raw = {
    deviceId: one(q.deviceId), since: one(q.since), until: one(q.until), address: one(q.address),
    port: one(q.port), protocol: one(q.protocol), reason: one(q.reason), app: one(q.app),
  };
  for (const [k, v] of Object.entries(raw)) if (v === null) return { error: `Invalid ${k}` };

  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  const since = raw.since ? new Date(raw.since) : new Date(Date.now() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(since.getTime())) return { error: 'Invalid since; expected a date/time' };
  where.push(`s.ended_at >= ${p(since.toISOString())}`);
  if (raw.until) {
    const until = new Date(raw.until);
    if (Number.isNaN(until.getTime())) return { error: 'Invalid until; expected a date/time' };
    where.push(`s.started_at <= ${p(until.toISOString())}`);
  }
  if (raw.deviceId) {
    const id = int(raw.deviceId, 1);
    if (id === null) return { error: 'Invalid deviceId' };
    where.push(`s.device_id = ${p(id)}`);
  }
  if (raw.address?.trim()) {
    const a = raw.address.trim().toLowerCase();
    if (!/^[0-9a-f.:]{2,45}$/.test(a)) return { error: 'Invalid address; expected an IPv4 or IPv6 address' };
    const ph = p(a);
    // The real ends and the translated ones, so a public address finds the
    // client behind masquerade.
    where.push(`(s.client_addr = ${ph} OR s.server_addr = ${ph} OR s.client_nat_addr = ${ph} OR s.server_nat_addr = ${ph})`);
  }
  if (raw.port?.trim()) {
    const port = int(raw.port.trim(), 0, 65535);
    if (port === null) return { error: 'Invalid port' };
    const ph = p(port);
    where.push(`(s.server_port = ${ph} OR s.client_port = ${ph} OR s.server_nat_port = ${ph} OR s.client_nat_port = ${ph})`);
  }
  if (raw.protocol?.trim()) {
    const name = raw.protocol.trim().toLowerCase();
    const num = PROTOCOLS[name] ?? int(name, 0, 255);
    if (num === null || num === undefined) return { error: 'Invalid protocol' };
    where.push(`s.protocol = ${p(num)}`);
  }
  if (raw.reason?.trim()) {
    const r = raw.reason.trim();
    if (!(END_REASONS as readonly string[]).includes(r)) return { error: 'Invalid reason' };
    where.push(`s.end_reason = ${p(r)}`);
  }
  if (raw.app?.trim()) {
    const app = raw.app.trim();
    if (app.length > 32) return { error: 'Invalid app' };
    where.push(`s.app = ${p(app)}`);
  }
  const site = siteScopeByNullableDevice(activeSite(req), 's.device_id');
  if (site) where.push(site);
  return { where, params };
}

type SessionRow = Record<string, unknown> & { total_count?: never };

// GET /api/sessions — newest first
router.get('/', async (req, res) => {
  const f = sessionFilters(req);
  if ('error' in f) return res.status(400).json({ error: f.error });
  const limitRaw = one(req.query.limit);
  const offsetRaw = one(req.query.offset);
  const limit = limitRaw === undefined ? 100 : limitRaw === null ? null : int(limitRaw, 1, SESSIONS_MAX_LIMIT);
  const offset = offsetRaw === undefined ? 0 : offsetRaw === null ? null : int(offsetRaw, 0, 1_000_000);
  if (limit === null) return res.status(400).json({ error: `Invalid limit; expected 1 to ${SESSIONS_MAX_LIMIT}` });
  if (offset === null) return res.status(400).json({ error: 'Invalid offset' });

  const where = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';
  const n = f.params.length;
  const [rows, count] = await Promise.all([
    query<SessionRow>(
      `SELECT s.id, s.device_id, d.name AS device_name, s.exporter, s.protocol,
              s.client_addr, s.client_port, s.server_addr, s.server_port,
              s.client_nat_addr, s.client_nat_port, s.server_nat_addr, s.server_nat_port,
              s.client_mac, c.hostname AS client_name, s.app,
              s.started_at, s.ended_at, s.bytes_out, s.bytes_in, s.packets_out, s.packets_in,
              s.flags_out, s.flags_in, s.end_reason
         FROM netflow_sessions s
         LEFT JOIN devices d ON d.id = s.device_id
         LEFT JOIN LATERAL (
           SELECT hostname FROM clients c
            WHERE s.client_mac IS NOT NULL AND c.mac_address = s.client_mac AND c.hostname IS NOT NULL AND c.hostname <> ''
            ORDER BY c.last_seen DESC NULLS LAST LIMIT 1
         ) c ON TRUE
         ${where}
        ORDER BY s.ended_at DESC, s.id DESC
        LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...f.params, limit, offset]
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM netflow_sessions s ${where} LIMIT ${SESSIONS_COUNT_CAP + 1}) x`,
      f.params
    ),
  ]);
  const total = count?.n ?? 0;
  res.json({
    sessions: rows.map((r) => ({
      ...r,
      // bigint columns come back as strings
      id: Number(r.id),
      bytes_out: Number(r.bytes_out), bytes_in: Number(r.bytes_in),
      packets_out: Number(r.packets_out), packets_in: Number(r.packets_in),
    })),
    total: Math.min(total, SESSIONS_COUNT_CAP),
    totalCapped: total > SESSIONS_COUNT_CAP,
  });
});

// PUT /api/sessions/devices/:id — { enabled } turns the session log on or off for a device
const deviceFromPath = (req: Request): number | null => {
  const m = /^\/devices\/(\d+)\/?$/.exec(req.path);
  return m ? Number(m[1]) : null;
};
router.put('/devices/:id', deviceSiteAccess(deviceFromPath), requireWrite, async (req, res) => {
  const id = int(String(req.params.id), 1);
  if (id === null) return res.status(400).json({ error: 'Invalid device id' });
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
  const row = await queryOne<{ id: number }>(
    `UPDATE devices SET netflow_sessions = $2 WHERE id = $1 RETURNING id`, [id, enabled]);
  if (!row) return res.status(404).json({ error: 'Device not found' });
  netflowCollector.refreshDevices();
  res.json({ id, sessions: enabled });
});

export default router;
