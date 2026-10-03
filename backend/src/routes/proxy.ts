import { Router, Request, Response } from 'express';
import { deviceSiteAccess, deviceIdQuery } from '../utils/siteAccess';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { resolveProxyQuery } from '../utils/proxyQuery';
import { USAGE_KIND, useProxyUsageRollup } from '../services/ProxyUsageService';

const router = Router();
router.use(requireAuth);
// ?deviceId= must be a device the account can see (P1-7).
router.use(deviceSiteAccess(deviceIdQuery));

// GET /api/proxy/top?by=client|user|destination|denied&range=24h&limit=10&source=&port=&deviceId=
router.get('/top', async (req: Request, res: Response) => {
  const choice = resolveProxyQuery(req.query.by, req.query.range);
  if ('error' in choice) return res.status(400).json({ error: choice.error });
  const { by, range, group, interval } = choice;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 100);

  // 24h, 7d and 30d read the hourly rollup (a few thousand rows) once it is built; 1h
  // stays on the raw rows so it is exact to the minute. The window starts at the hour
  // containing now - range, so it can reach up to an hour further back.
  if (range !== '1h' && await useProxyUsageRollup()) {
    const rparams: unknown[] = [USAGE_KIND[by], interval];
    const rfilters = [
      'kind = $1',
      `bucket >= (date_trunc('hour', (NOW() - $2::interval) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    ];
    if (req.query.source) { rparams.push(String(req.query.source)); rfilters.push(`source = $${rparams.length}`); }
    if (req.query.port) {
      const port = parseInt(String(req.query.port), 10);
      if (Number.isFinite(port)) { rparams.push(port); rfilters.push(`proxy_port = $${rparams.length}`); }
    }
    if (req.query.deviceId) {
      const id = parseInt(String(req.query.deviceId), 10);
      if (Number.isFinite(id)) { rparams.push(id); rfilters.push(`device_id = $${rparams.length}`); }
    }
    const rsite = siteScopeByDevice(activeSite(req), 'device_id');
    if (rsite) rfilters.push(rsite);
    rparams.push(limit);
    const rolled = await query(
      `SELECT key,
              SUM(requests)::bigint AS requests,
              SUM(bytes_out)::bigint AS bytes_out,
              SUM(bytes_in)::bigint AS bytes_in,
              COUNT(DISTINCT NULLIF(peer, ''))::int AS distinct_peers,
              MAX(last_seen) AS last_seen
         FROM proxy_usage_hourly
        WHERE ${rfilters.join(' AND ')}
        GROUP BY key
        ORDER BY requests DESC, last_seen DESC
        LIMIT $${rparams.length}`,
      rparams
    );
    return res.json(rolled.map((r: any) => ({
      key: r.key,
      requests: Number(r.requests),
      bytes_in: Number(r.bytes_in),
      bytes_out: Number(r.bytes_out),
      distinct_peers: r.distinct_peers,
      last_seen: r.last_seen,
    })));
  }

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

  // Rank first, then count distinct peers for only the returned keys. Distinct pairs
  // are collapsed by a hash aggregate; COUNT(DISTINCT) sorted every group (spilling to
  // disk once a group held hundreds of thousands of rows) and was the dominant cost.
  // COUNT(peer) skips NULL peers, as COUNT(DISTINCT peer) did.
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
       SELECT key, COUNT(peer)::int AS distinct_peers
         FROM (
           SELECT DISTINCT ${group.key} AS key, ${group.distinct} AS peer
             FROM proxy_connections
            WHERE ${where} AND ${group.key} IN (SELECT key FROM top)
         ) pairs
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

// GET /api/proxy/sources — proxy instances seen in the last 30 days, for the selector.
// Read from proxy_sources (one row per instance per device) rather than aggregating
// proxy_connections, which meant scanning every stored connection.
router.get('/sources', async (req: Request, res: Response) => {
  const siteFilter = siteScopeByDevice(activeSite(req), 'device_id');
  const rows = await query(
    `SELECT source, proxy_type, NULLIF(proxy_port, 0) AS proxy_port
       FROM proxy_sources
      WHERE last_seen > NOW() - INTERVAL '30 days' ${siteFilter ? `AND ${siteFilter}` : ''}
      GROUP BY source, proxy_type, NULLIF(proxy_port, 0)
      ORDER BY MAX(last_seen) DESC, source, proxy_port`
  );
  res.json(rows);
});

export default router;
