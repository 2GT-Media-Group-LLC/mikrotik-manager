import { Router, Request, Response } from 'express';
import { getQueryApi, bucket } from '../config/influxdb';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { netflowCollector } from '../services/netflow/NetflowCollector';
import { fluxString } from '@influxdata/influxdb-client';
import { activeSite } from '../middleware/site';
import { siteList } from '../utils/siteScope';

const router = Router();
router.use(requireAuth);

/**
 * A Flux filter for the selected site(s), or '' for the whole fleet. Traffic is
 * stored with the site its exporter belongs to (outside review J4), so a site
 * view, and a site-scoped account (P1-7), see only that site's traffic.
 *
 * A selection that contains every device is the whole fleet, so no filter is
 * applied. That is always the case on a single-site install, where the one site
 * is always selected: filtering there hid all traffic recorded before 0.24.47,
 * which carries no site, and cost a filter on every query for nothing.
 */
async function siteFilter(req: Request): Promise<string> {
  const sites = siteList(activeSite(req));
  if (!sites) return '';
  if (sites.length === 0) return '|> filter(fn: (r) => false)';
  try {
    const rows = await query<{ outside: number }>(
      `SELECT COUNT(*)::int AS outside FROM devices WHERE site_id IS NULL OR NOT (site_id = ANY($1::int[]))`,
      [sites]);
    if (rows[0]?.outside === 0) return '';
  } catch { /* can't tell: filter, which is the safe side */ }
  // Site ids are integers, safe to inline as strings. Written as `==` joined by
  // `or`, not contains(): InfluxDB pushes the former down to storage, while
  // contains() is evaluated in Flux after reading every point in the range, and
  // also stops the filters after it from being pushed down.
  return `|> filter(fn: (r) => ${sites.map((id) => `r.site_id == "${id}"`).join(' or ')})`;
}

function rangeToFlux(range: string): string {
  const allowed = ['1h', '2h', '3h', '6h', '12h', '24h', '7d', '30d'];
  return allowed.includes(range) ? range : '24h';
}

// Aggregation window sized to the range so charts stay readable (points are
// written every 60s by the collector flush).
function windowForRange(range: string): string {
  const map: Record<string, string> = {
    '1h': '1m', '2h': '2m', '3h': '5m', '6h': '5m', '12h': '10m',
    '24h': '15m', '7d': '1h', '30d': '6h',
  };
  return map[range] || '15m';
}

// MACs are used inside Flux queries — restrict to safe charsets (real MACs
// plus the 'unknown'/'other' pseudo-clients).
function sanitizeMac(raw: string): string | null {
  const mac = raw.toLowerCase();
  if (mac === 'unknown' || mac === 'other') return mac;
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac) ? mac : null;
}

// GET /api/traffic/status — collector state for the config page
router.get('/status', async (req: Request, res: Response) => {
  const stats = netflowCollector.getStats();
  if (!req.user?.siteRoles) { res.json(stats); return; }
  // A site-scoped account sees its own exporters only: not other sites'
  // device names, nor the sources the collector is refusing.
  const own = new Set((await query<{ id: number }>(
    `SELECT id FROM devices WHERE site_id = ANY($1::int[])`, [Object.keys(req.user.siteRoles).map(Number)])).map((d) => d.id));
  res.json({
    ...stats,
    exporters: stats.exporters.filter((e) => own.has(e.deviceId)),
    rejectedSources: [],
  });
});

// GET /api/traffic/timeseries?range=24h — fleet-wide upload/download over time
router.get('/timeseries', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const every = windowForRange(range);
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes" or r._field == "packets")
      |> group(columns: ["direction", "_field"])
      |> aggregateWindow(every: ${every}, fn: sum, createEmpty: false)
  `;

  type Point = { time: string; upload: number; download: number; uploadPackets: number; downloadPackets: number };
  const pivoted: Record<string, Point> = {};
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const time = tableMeta.get(row, '_time') as string;
      const direction = tableMeta.get(row, 'direction') as string;
      const field = tableMeta.get(row, '_field') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      if (!pivoted[time]) pivoted[time] = { time, upload: 0, download: 0, uploadPackets: 0, downloadPackets: 0 };
      if (field === 'packets') {
        if (direction === 'upload') pivoted[time].uploadPackets += value;
        else if (direction === 'download') pivoted[time].downloadPackets += value;
      } else {
        if (direction === 'upload') pivoted[time].upload += value;
        else if (direction === 'download') pivoted[time].download += value;
      }
    });
  } catch {
    // No data yet
  }

  res.json(Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time)));
});

// GET /api/traffic/top-clients?range=24h&limit=10 — top talkers with client names
router.get('/top-clients', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const limit = Math.min(parseInt(String(req.query.limit || '10'), 10) || 10, 50);
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes")
      |> group(columns: ["mac", "direction"])
      |> sum()
  `;

  const perMac = new Map<string, { upload: number; download: number }>();
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const mac = tableMeta.get(row, 'mac') as string;
      const direction = tableMeta.get(row, 'direction') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      let entry = perMac.get(mac);
      if (!entry) {
        entry = { upload: 0, download: 0 };
        perMac.set(mac, entry);
      }
      if (direction === 'upload') entry.upload += value;
      else entry.download += value;
    });
  } catch {
    // No data yet
  }

  const ranked = Array.from(perMac.entries())
    .map(([mac, e]) => ({ mac, upload_bytes: e.upload, download_bytes: e.download, total_bytes: e.upload + e.download }))
    .sort((a, b) => b.total_bytes - a.total_bytes)
    .slice(0, limit);

  // Enrich real MACs with client identity from Postgres
  const realMacs = ranked.map((r) => r.mac).filter((m) => m !== 'unknown' && m !== 'other');
  const names = new Map<string, { hostname: string | null; custom_name: string | null; vendor: string | null; ip_address: string | null }>();
  if (realMacs.length > 0) {
    // Names come from the clients in view, never another site's record of a MAC.
    const sites = siteList(activeSite(req));
    const rows = await query<{ mac_address: string; hostname: string | null; custom_name: string | null; vendor: string | null; ip_address: string | null }>(
      `SELECT DISTINCT ON (LOWER(c.mac_address)) c.mac_address, c.hostname, c.custom_name, c.vendor, c.ip_address
       FROM clients c
       ${sites ? 'JOIN devices d ON d.id = c.device_id AND d.site_id = ANY($2::int[])' : ''}
       WHERE LOWER(c.mac_address) = ANY($1)
       ORDER BY LOWER(c.mac_address), c.last_seen DESC NULLS LAST`,
      sites ? [realMacs, sites] : [realMacs]
    );
    for (const row of rows) names.set(row.mac_address.toLowerCase(), row);
  }

  res.json(
    ranked.map((r) => {
      const info = names.get(r.mac);
      return {
        ...r,
        hostname: info?.hostname || null,
        custom_name: info?.custom_name || null,
        vendor: info?.vendor || null,
        ip_address: info?.ip_address || null,
      };
    })
  );
});

// GET /api/traffic/apps?range=24h&mac=xx:xx:.. — app-category byte totals
// (fleet-wide, or for a single client when mac is given)
router.get('/apps', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  let macFilter = '';
  if (req.query.mac) {
    const mac = sanitizeMac(String(req.query.mac));
    if (!mac) return res.status(400).json({ error: 'Invalid mac' });
    macFilter = `|> filter(fn: (r) => r.mac == ${fluxString(String(mac))})`;
  }

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes" or r._field == "packets")
      ${macFilter}
      |> group(columns: ["app", "_field"])
      |> sum()
  `;

  const byApp = new Map<string, { bytes: number; packets: number }>();
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const app = tableMeta.get(row, 'app') as string;
      const field = tableMeta.get(row, '_field') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      let entry = byApp.get(app);
      if (!entry) {
        entry = { bytes: 0, packets: 0 };
        byApp.set(app, entry);
      }
      if (field === 'packets') entry.packets += value;
      else entry.bytes += value;
    });
  } catch {
    // No data yet
  }

  const apps = Array.from(byApp.entries()).map(([app, e]) => ({ app, bytes: e.bytes, packets: e.packets }));
  res.json(apps.sort((a, b) => b.bytes - a.bytes));
});

// GET /api/traffic/client/:mac?range=24h — per-client time series + app breakdown
router.get('/client/:mac', async (req: Request, res: Response) => {
  const mac = sanitizeMac(req.params.mac);
  if (!mac) return res.status(400).json({ error: 'Invalid mac' });
  const range = rangeToFlux(String(req.query.range || '24h'));
  const every = windowForRange(range);
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const seriesFlux = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes")
      |> filter(fn: (r) => r.mac == ${fluxString(String(mac))})
      |> group(columns: ["direction"])
      |> aggregateWindow(every: ${every}, fn: sum, createEmpty: false)
  `;

  const pivoted: Record<string, { time: string; upload: number; download: number }> = {};
  try {
    await queryApi.collectRows(seriesFlux, (row, tableMeta) => {
      const time = tableMeta.get(row, '_time') as string;
      const direction = tableMeta.get(row, 'direction') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      if (!pivoted[time]) pivoted[time] = { time, upload: 0, download: 0 };
      if (direction === 'upload') pivoted[time].upload += value;
      else if (direction === 'download') pivoted[time].download += value;
    });
  } catch {
    // No data yet
  }

  const appsFlux = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes" or r._field == "packets")
      |> filter(fn: (r) => r.mac == ${fluxString(String(mac))})
      |> group(columns: ["app", "_field"])
      |> sum()
  `;

  const byApp = new Map<string, { bytes: number; packets: number }>();
  try {
    await queryApi.collectRows(appsFlux, (row, tableMeta) => {
      const app = tableMeta.get(row, 'app') as string;
      const field = tableMeta.get(row, '_field') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      let entry = byApp.get(app);
      if (!entry) {
        entry = { bytes: 0, packets: 0 };
        byApp.set(app, entry);
      }
      if (field === 'packets') entry.packets += value;
      else entry.bytes += value;
    });
  } catch {
    // No data yet
  }
  const apps = Array.from(byApp.entries()).map(([app, e]) => ({ app, bytes: e.bytes, packets: e.packets }));

  res.json({
    series: Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time)),
    apps: apps.sort((a, b) => b.bytes - a.bytes),
  });
});

export default router;
