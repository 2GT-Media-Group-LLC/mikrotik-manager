import { Router, Request, Response } from 'express';
import { deviceSiteAccess, deviceIdQuery } from '../utils/siteAccess';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { resolveProxyQuery } from '../utils/proxyQuery';

const router = Router();
router.use(requireAuth);
// ?deviceId= must be a device the account can see (P1-7).
router.use(deviceSiteAccess(deviceIdQuery));

// GET /api/proxy/top?by=client|user|destination|denied&range=24h&limit=10&source=&port=&deviceId=
router.get('/top', async (req: Request, res: Response) => {
  const choice = resolveProxyQuery(req.query.by, req.query.range);
  if ('error' in choice) return res.status(400).json({ error: choice.error });
  const { group, interval } = choice;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 100);

  const filters = [group.where, `event_time > NOW() - $1::interval`];
  const params: unknown[] = [interval];
  if (req.query.source) { params.push(String(req.query.source)); filters.push(`source = $${params.length}`); }
  if (req.query.port) {
    const port = parseInt(String(req.query.port), 10);
    if (Number.isFinite(port)) { params.push(port); filters.push(`proxy_port = $${params.length}`); }
  }
  if (req.query.deviceId) {
    const id = parseInt(String(req.query.deviceId), 10);
    if (Number.isFinite(id)) { params.push(id); filters.push(`device_id = $${params.length}`); }
  }
  const siteFilter = siteScopeByDevice(activeSite(req), 'device_id');
  if (siteFilter) filters.push(siteFilter);
  const where = filters.join(' AND ');
  params.push(limit);

  // Rank first, then count distinct peers for only the returned keys: a per-group
  // COUNT(DISTINCT) over every group was the dominant cost on large tables.
  const rows = await query(
    `WITH top AS (
       SELECT ${group.key} AS key,
              COUNT(*)::int AS requests,
              COALESCE(SUM(bytes_sent), 0)::bigint AS bytes_out,
              COALESCE(SUM(bytes_received), 0)::bigint AS bytes_in,
              MAX(event_time) AS last_seen
         FROM proxy_connections
        WHERE ${where}
        GROUP BY 1
        ORDER BY requests DESC, last_seen DESC
        LIMIT $${params.length}
     ), peers AS (
       SELECT ${group.key} AS key, COUNT(DISTINCT ${group.distinct})::int AS distinct_peers
         FROM proxy_connections
        WHERE ${where} AND ${group.key} IN (SELECT key FROM top)
        GROUP BY 1
     )
     SELECT t.key, t.requests, t.bytes_out, t.bytes_in, p.distinct_peers, t.last_seen
       FROM top t JOIN peers p USING (key)
      ORDER BY t.requests DESC, t.last_seen DESC`,
    params
  );
  res.json(rows.map((r: any) => ({
    key: r.key,
    requests: r.requests,
    bytes_in: Number(r.bytes_in),
    bytes_out: Number(r.bytes_out),
    distinct_peers: r.distinct_peers,
    last_seen: r.last_seen,
  })));
});

// The 30-day scan behind the selector is the same for every viewer of a site, so
// answer repeat calls from memory for a short while.
const SOURCES_TTL_MS = 120_000;
const sourcesCache = new Map<string, { at: number; rows: unknown }>();

// GET /api/proxy/sources — proxy instances seen in the last 30 days, for the selector
router.get('/sources', async (req: Request, res: Response) => {
  const siteFilter = siteScopeByDevice(activeSite(req), 'device_id');
  const cacheKey = siteFilter ?? '';
  const hit = sourcesCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SOURCES_TTL_MS) return res.json(hit.rows);
  const rows = await query(
    `SELECT source, proxy_type, proxy_port, COUNT(*)::int AS requests
       FROM proxy_connections
      WHERE event_time > NOW() - INTERVAL '30 days' ${siteFilter ? `AND ${siteFilter}` : ''}
      GROUP BY source, proxy_type, proxy_port
      ORDER BY requests DESC`
  );
  sourcesCache.set(cacheKey, { at: Date.now(), rows });
  res.json(rows);
});

export default router;
