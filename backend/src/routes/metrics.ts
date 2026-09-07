import { Router, Request, Response } from 'express';
import { getQueryApi, bucket } from '../config/influxdb';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeDevices, siteScopeByDevice, siteScopeByNullableDevice, clientSeriesTag } from '../utils/siteScope';
import { activeSite } from '../middleware/site';

const router = Router();
router.use(requireAuth);

function rangeToFlux(range: string): string {
  const allowed = ['1h', '3h', '6h', '12h', '24h', '7d', '30d'];
  return allowed.includes(range) ? range : '24h';
}

// GET /api/metrics/clients-over-time?range=24h
router.get('/clients-over-time', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const queryApi = getQueryApi();
  // Per-site deduplicated series when a site is selected, fleet-wide otherwise.
  // Written by DeviceCollector alongside the global series (issue #130).
  //
  // A site holding the entire fleet is a special case worth taking: its total
  // *is* the global total, by definition rather than by approximation. Using
  // the global series there is not a shortcut -- it keeps the chart's full
  // history, which the per-site series only accumulates from the upgrade
  // onward. That covers every single-site install.
  const siteId = activeSite(req);
  let seriesTag = '_global';
  if (siteId !== null) {
    const counts = await query<{ in_site: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE site_id = $1)::int AS in_site,
              COUNT(*)::int AS total
         FROM devices`,
      [siteId]
    );
    const { in_site = 0, total = 0 } = counts[0] ?? {};
    seriesTag = clientSeriesTag(siteId, in_site, total);
  }

  // Use the global deduplicated metric (_global tag) written by DeviceCollector.
  // This avoids double-counting clients seen by multiple devices simultaneously.
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_counts")
      |> filter(fn: (r) => r._field == "total_clients")
      |> filter(fn: (r) => r.device_id == "${seriesTag}")
      |> aggregateWindow(every: 5m, fn: last, createEmpty: false)
      |> yield(name: "clients_over_time")
  `;

  const rawPoints: { time: string; value: number }[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const time = tableMeta.get(row, '_time') as string;
      const value = tableMeta.get(row, '_value') as number;
      rawPoints.push({ time, value: Math.round(value) });
    });
  } catch {
    // InfluxDB might not have data yet
  }

  // If no deduplicated series exists yet (first run, or a site whose history
  // predates the per-site series), fall back to max across real devices. max()
  // is better than sum() since the device with the most clients is the gateway
  // that sees everyone — summing would double-count clients visible from
  // multiple devices.
  if (rawPoints.length === 0) {
    // The synthetic series are tagged _global and _site_<id>; the leading
    // underscore is what distinguishes them from real device ids. Matching on
    // it matters: without it the fleet-wide fallback would fold the per-site
    // totals back in and count everyone twice.
    let deviceFilter: string | null = `|> filter(fn: (r) => not (r.device_id =~ /^_/))`;
    if (siteId !== null) {
      const ids = await query<{ id: number }>(
        `SELECT id FROM devices WHERE site_id = $1`, [siteId]
      );
      // An empty site has no series to fall back to, and must show an empty
      // chart rather than the fleet's (issue #130).
      deviceFilter = ids.length
        ? `|> filter(fn: (r) => ${ids.map((d) => `r.device_id == "${d.id}"`).join(' or ')})`
        : null;
    }
    if (deviceFilter) {
      const fallbackQuery = `
        from(bucket: "${bucket}")
          |> range(start: -${range})
          |> filter(fn: (r) => r._measurement == "client_counts")
          |> filter(fn: (r) => r._field == "total_clients")
          ${deviceFilter}
          |> aggregateWindow(every: 5m, fn: max, createEmpty: false)
          |> group()
          |> aggregateWindow(every: 5m, fn: max, createEmpty: false)
          |> yield(name: "clients_over_time_fallback")
      `;
      try {
        await queryApi.collectRows(fallbackQuery, (row, tableMeta) => {
          const time = tableMeta.get(row, '_time') as string;
          const value = tableMeta.get(row, '_value') as number;
          rawPoints.push({ time, value: Math.round(value) });
        });
      } catch {
        // No data yet
      }
    }
  }

  const points = rawPoints.sort((a, b) => a.time.localeCompare(b.time));
  res.json(points);
});

// GET /api/metrics/top-clients?limit=10&range=24h
router.get('/top-clients', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '10'), 10), 50);
  const topFilter = siteScopeByDevice(activeSite(req), 'c.device_id');

  // Use postgres data (most recent client data)
  const clients = await query(
    `SELECT c.mac_address, c.hostname, c.ip_address, c.interface_name,
            c.tx_bytes + c.rx_bytes as total_bytes,
            c.tx_bytes, c.rx_bytes, c.client_type, d.name as device_name
     FROM clients c JOIN devices d ON d.id = c.device_id
     WHERE c.active = TRUE AND (c.tx_bytes + c.rx_bytes) > 0
       ${topFilter ? `AND ${topFilter}` : ''}
     ORDER BY total_bytes DESC LIMIT $1`,
    [limit]
  );

  res.json(clients);
});

// GET /api/metrics/interface/:deviceId/:interface?range=1h
router.get('/interface/:deviceId/:interface', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;
  const iface = req.params.interface;

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "interface_traffic")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r.interface == "${iface}")
      |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes")
      |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
      |> derivative(unit: 1s, nonNegative: true)
      |> yield(name: "traffic")
  `;

  const points: Record<string, unknown>[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      points.push({
        time: tableMeta.get(row, '_time'),
        field: tableMeta.get(row, '_field'),
        value: tableMeta.get(row, '_value'),
      });
    });
  } catch {
    // No data yet
  }

  // Pivot rx/tx into single objects per timestamp
  const pivoted: Record<string, { time: string; rx: number; tx: number }> = {};
  for (const p of points) {
    const t = p['time'] as string;
    if (!pivoted[t]) pivoted[t] = { time: t, rx: 0, tx: 0 };
    if (p['field'] === 'rx_bytes') pivoted[t].rx = Number(p['value']) || 0;
    if (p['field'] === 'tx_bytes') pivoted[t].tx = Number(p['value']) || 0;
  }

  res.json(Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time)));
});

// GET /api/metrics/interface/:deviceId/:interface/packets?range=1h
router.get('/interface/:deviceId/:interface/packets', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;
  const iface = req.params.interface;

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "interface_traffic")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r.interface == "${iface}")
      |> filter(fn: (r) => r._field == "rx_packets" or r._field == "tx_packets")
      |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
      |> derivative(unit: 1s, nonNegative: true)
      |> yield(name: "packets")
  `;

  const points: Record<string, unknown>[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      points.push({
        time: tableMeta.get(row, '_time'),
        field: tableMeta.get(row, '_field'),
        value: tableMeta.get(row, '_value'),
      });
    });
  } catch {
    // No data yet
  }

  const pivoted: Record<string, { time: string; rx: number; tx: number }> = {};
  for (const p of points) {
    const t = p['time'] as string;
    if (!pivoted[t]) pivoted[t] = { time: t, rx: 0, tx: 0 };
    if (p['field'] === 'rx_packets') pivoted[t].rx = Number(p['value']) || 0;
    if (p['field'] === 'tx_packets') pivoted[t].tx = Number(p['value']) || 0;
  }

  res.json(Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time)));
});

// GET /api/metrics/device/:deviceId/resources?range=24h
router.get('/device/:deviceId/resources', async (req: Request, res: Response) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "device_resources")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r._field == "cpu_load" or r._field == "memory_used" or r._field == "memory_total")
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
      |> yield(name: "resources")
  `;

  const points: Record<string, unknown>[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      points.push({
        time: tableMeta.get(row, '_time'),
        field: tableMeta.get(row, '_field'),
        value: tableMeta.get(row, '_value'),
      });
    });
  } catch {
    // No data yet
  }

  const pivoted: Record<string, Record<string, unknown>> = {};
  for (const p of points) {
    const t = p['time'] as string;
    if (!pivoted[t]) pivoted[t] = { time: t };
    pivoted[t][p['field'] as string] = Number(p['value']) || 0;
  }

  res.json(Object.values(pivoted).sort((a, b) => String(a['time']).localeCompare(String(b['time']))));
});

// GET /api/metrics/device/:deviceId/poe - current PoE power per port + 1h time series
router.get('/device/:deviceId/poe', async (req: Request, res: Response) => {
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;

  const currentFlux = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r._measurement == "poe_power")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r._field == "watts" or r._field == "current_ma" or r._field == "voltage_v")
      |> last()
  `;

  const portData: Record<string, { port: string; watts: number; current_ma: number; voltage_v: number }> = {};
  try {
    await queryApi.collectRows(currentFlux, (row, tableMeta) => {
      const port = tableMeta.get(row, 'port') as string;
      const field = tableMeta.get(row, '_field') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      if (!portData[port]) portData[port] = { port, watts: 0, current_ma: 0, voltage_v: 0 };
      if (field === 'watts') portData[port].watts = value;
      if (field === 'current_ma') portData[port].current_ma = value;
      if (field === 'voltage_v') portData[port].voltage_v = value;
    });
  } catch { /* no data */ }

  const historyFlux = `
    from(bucket: "${bucket}")
      |> range(start: -1h)
      |> filter(fn: (r) => r._measurement == "poe_power")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r._field == "watts")
      |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  `;

  const history: { time: string; port: string; watts: number }[] = [];
  try {
    await queryApi.collectRows(historyFlux, (row, tableMeta) => {
      history.push({
        time: tableMeta.get(row, '_time') as string,
        port: tableMeta.get(row, 'port') as string,
        watts: Number(tableMeta.get(row, '_value')) || 0,
      });
    });
  } catch { /* no data */ }

  const ports = Object.values(portData);
  const totalWatts = parseFloat(ports.reduce((s, p) => s + p.watts, 0).toFixed(2));

  res.json({ ports, totalWatts, history });
});

// GET /api/metrics/device/:deviceId/availability?range=30d
router.get('/device/:deviceId/availability', async (req: Request, res: Response) => {
  const deviceId = parseInt(req.params.deviceId, 10);
  const rangeRaw = String(req.query.range || '30d');
  const allowedRanges: Record<string, string> = {
    '7d': '7 days', '30d': '30 days', '90d': '90 days',
  };
  const intervalStr = allowedRanges[rangeRaw] ?? '30 days';

  const outages = await query<{
    id: number;
    went_offline_at: string;
    came_back_online_at: string | null;
    duration_seconds: number | null;
  }>(
    `SELECT id, went_offline_at, came_back_online_at, duration_seconds
     FROM device_availability
     WHERE device_id = $1
       AND went_offline_at > NOW() - ($2::text || '')::interval
     ORDER BY went_offline_at DESC`,
    [deviceId, intervalStr]
  );

  const rangeSeconds = parseInt(intervalStr, 10) * 86400;
  const totalOutageSec = outages.reduce((sum, o) => {
    const dur = o.duration_seconds ?? (o.came_back_online_at == null ? Math.round((Date.now() / 1000) - new Date(o.went_offline_at).getTime() / 1000) : 0);
    return sum + dur;
  }, 0);
  const uptimePct = Math.max(0, Math.min(100, parseFloat(((1 - totalOutageSec / rangeSeconds) * 100).toFixed(2))));
  const longestOutage = outages.reduce((max, o) => Math.max(max, o.duration_seconds ?? 0), 0);

  res.json({
    uptimePct,
    totalOutages: outages.length,
    longestOutageSec: longestOutage,
    totalOutageSec,
    outages,
    range: rangeRaw,
  });
});

// GET /api/metrics/summary - dashboard summary stats
router.get('/summary', async (req: Request, res: Response) => {
  const siteId = activeSite(req);
  const devFilter = siteScopeDevices(siteId);
  const cliFilter = siteScopeByDevice(siteId, 'device_id');
  const evtFilter = siteScopeByNullableDevice(siteId, 'device_id');
  const [deviceStats, clientStats, alertStats, availStats] = await Promise.all([
    query<{ total: string; online: string; offline: string }>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='online') as online,
        COUNT(*) FILTER (WHERE status='offline') as offline
       FROM devices ${devFilter ? `WHERE ${devFilter}` : ''}`
    ),
    query<{ total: string; active: string }>(
      `SELECT COUNT(DISTINCT mac_address) as total,
              COUNT(DISTINCT mac_address) FILTER (WHERE active=TRUE) as active
       FROM clients ${cliFilter ? `WHERE ${cliFilter}` : ''}`
    ),
    query<{ critical: string; warning: string }>(
      `SELECT
        COUNT(*) FILTER (WHERE severity='error') as critical,
        COUNT(*) FILTER (WHERE severity='warning') as warning
       FROM events WHERE event_time > NOW() - INTERVAL '24 hours'
         ${evtFilter ? `AND ${evtFilter}` : ''}`
    ),
    query<{ total_outage_sec: string }>(
      `SELECT COALESCE(SUM(COALESCE(duration_seconds, 0)), 0)::text AS total_outage_sec
       FROM device_availability
       WHERE went_offline_at > NOW() - INTERVAL '30 days'
         ${cliFilter ? `AND ${cliFilter}` : ''}`
    ),
  ]);

  const deviceTotal = parseInt(deviceStats[0]?.total || '0', 10);
  const totalOutageSec = parseInt(availStats[0]?.total_outage_sec || '0', 10);
  const possibleDeviceSeconds = deviceTotal * 30 * 86400;
  const fleetUptimePct = possibleDeviceSeconds > 0
    ? parseFloat(Math.max(0, Math.min(100, (1 - totalOutageSec / possibleDeviceSeconds) * 100)).toFixed(2))
    : 100;

  res.json({
    devices: {
      total: deviceTotal,
      online: parseInt(deviceStats[0]?.online || '0', 10),
      offline: parseInt(deviceStats[0]?.offline || '0', 10),
    },
    clients: {
      total: parseInt(clientStats[0]?.total || '0', 10),
      active: parseInt(clientStats[0]?.active || '0', 10),
    },
    alerts: {
      critical: parseInt(alertStats[0]?.critical || '0', 10),
      warning: parseInt(alertStats[0]?.warning || '0', 10),
    },
    availability: {
      fleetUptimePct30d: fleetUptimePct,
    },
  });
});

export default router;
