import { Router } from 'express';
import { decodedPath } from '../utils/requestPath';
import { outageLengthSeconds, outageOverlapsSql, outageSecondsInWindow, outageSecondsSql } from '../utils/outageWindow';
import { deviceSiteAccess, guardIdParams } from '../utils/siteAccess';
import { getQueryApi, bucket } from '../config/influxdb';
import { query } from '../config/database';
import { CLIENT_SIGHTINGS } from '../utils/clientPorts';
import { requireAuth } from '../middleware/auth';
import { siteScopeDevices, siteScopeByDevice, siteScopeByNullableDevice, clientSeriesTag, siteList } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { fluxString } from '@influxdata/influxdb-client';
import { latestResources, latestInterfaceCounters } from '../services/latestMetrics';
import { linkSpeedBps } from '../utils/deviceGraphs';

const router = Router();
router.use(requireAuth);
// Ids are plain numbers, read the same way by the site check and the handler (GHSA-j9x4-qwcj-p8v8).
guardIdParams(router, ['deviceId'], 'Device not found');
// Per-device metrics: a site-scoped account only reaches its own sites' devices (P1-7).
router.use(deviceSiteAccess((req) => {
  // Decoded, as the handler's :id is (GHSA-6xq3-q9m5-7hxp); NaN is refused.
  const path = decodedPath(req);
  if (path === null) return NaN;
  const m = /^\/(?:interface|device)\/(\d+)(?:\/|$)/.exec(path);
  return m ? parseInt(m[1], 10) : null;
}));

function rangeToFlux(range: string): string {
  const allowed = ['1h', '3h', '6h', '12h', '24h', '7d', '30d'];
  return allowed.includes(range) ? range : '24h';
}

// GET /api/metrics/clients-over-time?range=24h
router.get('/clients-over-time', async (req, res) => {
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
  const sites = siteList(activeSite(req));
  // One tag normally; a site-scoped account covering several sites (P1-7) gets
  // each site's series, summed below.
  let seriesTags: string[] = ['_global'];
  if (sites && sites.length === 1) {
    const counts = await query<{ in_site: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE site_id = $1)::int AS in_site,
              COUNT(*)::int AS total
         FROM devices`,
      [sites[0]]
    );
    const { in_site = 0, total = 0 } = counts[0] ?? {};
    seriesTags = [clientSeriesTag(sites[0], in_site, total)];
  } else if (sites) {
    seriesTags = sites.map((id) => `_site_${id}`);
  }

  // Use the global deduplicated metric (_global tag) written by DeviceCollector.
  // This avoids double-counting clients seen by multiple devices simultaneously.
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_counts")
      |> filter(fn: (r) => r._field == "total_clients")
      |> filter(fn: (r) => ${seriesTags.map((t) => `r.device_id == ${fluxString(t)}`).join(' or ')})
      |> aggregateWindow(every: 5m, fn: last, createEmpty: false)
      |> group(columns: ["_time"])
      |> sum()
      |> group()
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
    // An Influx failure is not an empty series (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
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
    if (sites !== null) {
      const ids = await query<{ id: number }>(
        `SELECT id FROM devices WHERE site_id = ANY($1::int[])`, [sites]
      );
      // An empty site has no series to fall back to, and must show an empty
      // chart rather than the fleet's (issue #130).
      deviceFilter = ids.length
        ? `|> filter(fn: (r) => ${ids.map((d) => `r.device_id == ${fluxString(String(d.id))}`).join(' or ')})`
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
router.get('/top-clients', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '10'), 10), 50);
  const topFilter = siteScopeByDevice(activeSite(req), 'c.device_id');

  // Use postgres data (most recent client data)
  const clients = await query(
    `SELECT c.mac_address, c.hostname, c.ip_address, c.interface_name,
            c.tx_bytes + c.rx_bytes as total_bytes,
            c.tx_bytes, c.rx_bytes, c.client_type, d.name as device_name
     FROM ${CLIENT_SIGHTINGS} c JOIN devices d ON d.id = c.device_id
     WHERE c.active = TRUE AND (c.tx_bytes + c.rx_bytes) > 0
       ${topFilter ? `AND ${topFilter}` : ''}
     ORDER BY total_bytes DESC LIMIT $1`,
    [limit]
  );

  res.json(clients);
});

// GET /api/metrics/interface/:deviceId/:interface?range=1h
router.get('/interface/:deviceId/:interface', async (req, res) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;
  const iface = req.params.interface;

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "interface_traffic")
      |> filter(fn: (r) => r.device_id == ${fluxString(String(deviceId))})
      |> filter(fn: (r) => r.interface == ${fluxString(String(iface))})
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
    // An Influx failure is not an empty series (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
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
router.get('/interface/:deviceId/:interface/packets', async (req, res) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;
  const iface = req.params.interface;

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "interface_traffic")
      |> filter(fn: (r) => r.device_id == ${fluxString(String(deviceId))})
      |> filter(fn: (r) => r.interface == ${fluxString(String(iface))})
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
    // An Influx failure is not an empty series (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
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

// GET /api/metrics/interface/:deviceId/:interface/drops?range=1h
// Errors and drops per second (#402), apart from traffic, so a few aren't
// flattened by gigabit rates on the same chart.
const DROP_FIELDS = ['rx_errors', 'tx_errors', 'rx_drops', 'tx_drops', 'tx_queue_drops'];
router.get('/interface/:deviceId/:interface/drops', async (req, res) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "interface_traffic")
      |> filter(fn: (r) => r.device_id == ${fluxString(String(req.params.deviceId))})
      |> filter(fn: (r) => r.interface == ${fluxString(String(req.params.interface))})
      |> filter(fn: (r) => ${DROP_FIELDS.map((f) => `r._field == "${f}"`).join(' or ')})
      |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
      |> derivative(unit: 1s, nonNegative: true)
      |> yield(name: "drops")
  `;
  const pivoted: Record<string, Record<string, number | string>> = {};
  try {
    await getQueryApi().collectRows(fluxQuery, (row, tableMeta) => {
      const t = tableMeta.get(row, '_time') as string;
      const f = tableMeta.get(row, '_field') as string;
      if (!pivoted[t]) pivoted[t] = { time: t };
      pivoted[t][f] = Number(tableMeta.get(row, '_value')) || 0;
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  res.json(Object.values(pivoted).sort((a, b) => String(a['time']).localeCompare(String(b['time']))).map((p) => ({
    time: p.time,
    errors: (Number(p.rx_errors) || 0) + (Number(p.tx_errors) || 0),
    drops: (Number(p.rx_drops) || 0) + (Number(p.tx_drops) || 0),
    queue_drops: Number(p.tx_queue_drops) || 0,
  })));
});

// ─── Device graphs (#402) ─────────────────────────────────────────────────────

/** Window per range: about 200–700 points whatever the range. */
const GRAPH_WINDOW: Record<string, string> = { '1h': '1m', '6h': '2m', '24h': '5m', '7d': '30m', '30d': '2h' };
const GRAPH_MEASUREMENTS = new Set(['conntrack', 'conntrack_split', 'firewall_drops', 'cpu_cores', 'health_temps']);
const FIELD_NAME = /^[a-z0-9_]{1,48}$/;

function graphRange(req: { query: Record<string, unknown> }): { range: string; every: string } {
  const r = String(req.query.range || '24h');
  return GRAPH_WINDOW[r] ? { range: r, every: GRAPH_WINDOW[r] } : { range: '24h', every: '5m' };
}

/**
 * GET /api/metrics/device/:deviceId/series?m=conntrack&range=24h
 * Every field of one graph measurement, averaged per window, with the peak
 * in each window as <field>_peak, so a burst doesn't hide in the average.
 */
router.get('/device/:deviceId/series', async (req, res) => {
  const m = String(req.query.m ?? '');
  if (!GRAPH_MEASUREMENTS.has(m)) return res.status(400).json({ error: 'Unknown measurement' });
  const { range, every } = graphRange(req);
  const base = `
    base = from(bucket: ${fluxString(bucket)})
      |> range(start: -${rangeToFlux(range)})
      |> filter(fn: (r) => r._measurement == ${fluxString(m)} and r.device_id == ${fluxString(String(req.params.deviceId))})`;
  const flux = `${base}
    avg = base |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
    peak = base |> aggregateWindow(every: ${every}, fn: max, createEmpty: false) |> map(fn: (r) => ({ r with _field: r._field + "_peak" }))
    union(tables: [avg, peak]) |> yield(name: "series")`;
  const pivoted: Record<string, Record<string, number | string>> = {};
  try {
    await getQueryApi().collectRows(flux, (row, meta) => {
      const f = String(meta.get(row, '_field'));
      if (!FIELD_NAME.test(f.replace(/_peak$/, ''))) return;
      const t = String(meta.get(row, '_time'));
      if (!pivoted[t]) pivoted[t] = { time: t };
      pivoted[t][f] = Number(meta.get(row, '_value')) || 0;
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  return res.json(Object.values(pivoted).sort((a, b) => String(a.time).localeCompare(String(b.time))));
});

// GET /api/metrics/device/:deviceId/drop-rules?range=24h — the rules that dropped the most.
router.get('/device/:deviceId/drop-rules', async (req, res) => {
  const { range } = graphRange(req);
  const flux = `
    from(bucket: ${fluxString(bucket)})
      |> range(start: -${rangeToFlux(range)})
      |> filter(fn: (r) => r._measurement == "firewall_rule_drops" and r.device_id == ${fluxString(String(req.params.deviceId))} and r._field == "packets")
      |> group(columns: ["rule", "label", "chain"])
      |> sum()
      |> group()
      |> sort(columns: ["_value"], desc: true)
      |> limit(n: 10)`;
  const out: { rule: string; label: string; chain: string; packets: number }[] = [];
  try {
    await getQueryApi().collectRows(flux, (row, meta) => {
      out.push({ rule: String(meta.get(row, 'rule')), label: String(meta.get(row, 'label')), chain: String(meta.get(row, 'chain')),
        packets: Number(meta.get(row, '_value')) || 0 });
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  return res.json(out);
});

/**
 * GET /api/metrics/device/:deviceId/interfaces?range=24h[&ifaces=a,b]
 * Several interfaces at once (#402): bits/s and packets/s per window, with
 * the link speed for utilisation. Without ifaces, the four busiest physical
 * ports and bonds in the range.
 */
router.get('/device/:deviceId/interfaces', async (req, res) => {
  const { range, every } = graphRange(req);
  const deviceId = String(req.params.deviceId);
  const known = await query<{ name: string; type: string | null; link_rate: string | null; speed: string | null }>(
    `SELECT name, type, link_rate, speed FROM interfaces WHERE device_id = $1`, [Number(deviceId)]);
  const byName = new Map(known.map((i) => [i.name, i]));
  let names = String(req.query.ifaces ?? '').split(',').map((x) => x.trim()).filter((x) => byName.has(x)).slice(0, 8);
  const scope = `
      |> range(start: -${rangeToFlux(range)})
      |> filter(fn: (r) => r._measurement == "interface_traffic" and r.device_id == ${fluxString(deviceId)})`;
  try {
    if (!names.length) {
      // The busiest by bytes moved in the range; bridges, VLANs and loopback repeat their ports' traffic.
      const skip = new Set(['bridge', 'vlan', 'loopback']);
      const totals = new Map<string, number>();
      await getQueryApi().collectRows(`from(bucket: ${fluxString(bucket)})${scope}
        |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes")
        |> spread()`, (row, meta) => {
        const n = String(meta.get(row, 'interface'));
        totals.set(n, (totals.get(n) ?? 0) + (Number(meta.get(row, '_value')) || 0));
      });
      names = [...totals].filter(([n, v]) => v > 0 && byName.has(n) && !skip.has(byName.get(n)!.type ?? ''))
        .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
    }
    const series = new Map<string, Map<string, Record<string, number>>>();
    if (names.length) {
      await getQueryApi().collectRows(`from(bucket: ${fluxString(bucket)})${scope}
        |> filter(fn: (r) => ${names.map((n) => `r.interface == ${fluxString(n)}`).join(' or ')})
        |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes" or r._field == "rx_packets" or r._field == "tx_packets")
        |> aggregateWindow(every: ${every}, fn: last, createEmpty: false)
        |> derivative(unit: 1s, nonNegative: true)`, (row, meta) => {
        const n = String(meta.get(row, 'interface'));
        const t = String(meta.get(row, '_time'));
        const f = String(meta.get(row, '_field'));
        if (!series.has(n)) series.set(n, new Map());
        const pts = series.get(n)!;
        if (!pts.has(t)) pts.set(t, {});
        const v = Number(meta.get(row, '_value')) || 0;
        // Bytes/s to bits/s for throughput and utilisation.
        pts.get(t)![f === 'rx_bytes' ? 'rx_bps' : f === 'tx_bytes' ? 'tx_bps' : f === 'rx_packets' ? 'rx_pps' : 'tx_pps'] = f.endsWith('bytes') ? v * 8 : v;
      });
    }
    return res.json({
      interfaces: names.map((n) => {
        const i = byName.get(n)!;
        return {
          name: n,
          speed_bps: linkSpeedBps(i.link_rate) ?? linkSpeedBps(i.speed),
          points: [...(series.get(n) ?? new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([time, v]) => ({ time, ...v })),
        };
      }),
      available: known.filter((i) => !['loopback'].includes(i.type ?? '')).map((i) => i.name).sort(),
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
});

// GET /api/metrics/device/:deviceId/resources?range=24h
router.get('/device/:deviceId/resources', async (req, res) => {
  const range = rangeToFlux(String(req.query.range || '24h'));
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;

  const fluxQuery = `
    base = from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "device_resources")
      |> filter(fn: (r) => r.device_id == ${fluxString(String(deviceId))})
      |> filter(fn: (r) => r._field == "cpu_load" or r._field == "memory_used" or r._field == "memory_total")
    avg = base |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
    // The highest reading in each window (#402): a one-minute burst to 100% CPU
    // reads as 30% on a five-minute average.
    peak = base
      |> filter(fn: (r) => r._field == "cpu_load" or r._field == "memory_used")
      |> aggregateWindow(every: 5m, fn: max, createEmpty: false)
      |> map(fn: (r) => ({ r with _field: r._field + "_peak" }))
    union(tables: [avg, peak]) |> yield(name: "resources")
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
    // An Influx failure is not an empty series (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
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
router.get('/device/:deviceId/poe', async (req, res) => {
  const queryApi = getQueryApi();
  const deviceId = req.params.deviceId;

  const currentFlux = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r._measurement == "poe_power")
      |> filter(fn: (r) => r.device_id == ${fluxString(String(deviceId))})
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
      |> filter(fn: (r) => r.device_id == ${fluxString(String(deviceId))})
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
router.get('/device/:deviceId/availability', async (req, res) => {
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
    // Every outage overlapping the window, including one that began before
    // it or is still going (P2-25).
    `SELECT id, went_offline_at, came_back_online_at, duration_seconds
     FROM device_availability
     WHERE device_id = $1
       AND ${outageOverlapsSql(`($2::text)::interval`)}
     ORDER BY went_offline_at DESC`,
    [deviceId, intervalStr]
  );

  const rangeSeconds = parseInt(intervalStr, 10) * 86400;
  const now = new Date();
  const windowStart = new Date(now.getTime() - rangeSeconds * 1000);
  const totalOutageSec = outages.reduce((sum, o) => sum + outageSecondsInWindow(o, windowStart, now), 0);
  const uptimePct = Math.max(0, Math.min(100, parseFloat(((1 - totalOutageSec / rangeSeconds) * 100).toFixed(2))));
  const longestOutage = outages.reduce((max, o) => Math.max(max, outageLengthSeconds(o, now)), 0);

  res.json({
    uptimePct,
    totalOutages: outages.length,
    longestOutageSec: longestOutage,
    totalOutageSec,
    outages,
    range: rangeRaw,
  });
});

// GET /api/metrics/resources/latest - newest CPU/memory point per device (read-only, site-scoped)
router.get('/resources/latest', async (req, res) => {
  const devFilter = siteScopeDevices(activeSite(req));
  let latest;
  try {
    latest = await latestResources({ strict: true });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  const allowed = await query<{ id: number }>(`SELECT id FROM devices ${devFilter ? `WHERE ${devFilter}` : ''}`);
  const devices: Record<string, { cpu_load: number; memory_used: number; memory_total: number; time: string }> = {};
  for (const d of allowed) {
    const r = latest.get(String(d.id));
    if (!r || !r.time) continue;
    devices[String(d.id)] = { cpu_load: r.cpu, memory_used: r.memUsed, memory_total: r.memTotal, time: r.time };
  }
  res.json({ devices });
});

// GET /api/metrics/resources/cpu-history?range=1h — every device's CPU series
// in one query, for the Devices list sparklines (#302). The list used to ask
// once per device: 1,500 requests and Flux queries for a large fleet.
router.get('/resources/cpu-history', async (req, res) => {
  const range = rangeToFlux(String(req.query.range || '1h'));
  const devFilter = siteScopeDevices(activeSite(req));
  const allowed = new Set((await query<{ id: number }>(`SELECT id FROM devices ${devFilter ? `WHERE ${devFilter}` : ''}`)).map((d) => String(d.id)));
  const flux = `
    from(bucket: ${fluxString(bucket)})
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "device_resources" and r._field == "cpu_load")
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
      |> keep(columns: ["_time", "_value", "device_id"])
  `;
  const series = new Map<string, { t: string; v: number }[]>();
  try {
    await getQueryApi().collectRows(flux, (row, meta) => {
      const id = String(meta.get(row, 'device_id') ?? '');
      if (!allowed.has(id)) return;
      if (!series.has(id)) series.set(id, []);
      series.get(id)!.push({ t: String(meta.get(row, '_time')), v: Number(meta.get(row, '_value')) || 0 });
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  const devices: Record<string, number[]> = {};
  for (const [id, pts] of series) devices[id] = pts.sort((a, b) => a.t.localeCompare(b.t)).map((p) => Math.round(p.v * 10) / 10);
  res.json({ devices });
});

// GET /api/metrics/interfaces/latest - newest cumulative rx/tx byte counters per device and interface
router.get('/interfaces/latest', async (req, res) => {
  const devFilter = siteScopeDevices(activeSite(req));
  let latest;
  try {
    latest = await latestInterfaceCounters();
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  const allowed = await query<{ id: number }>(`SELECT id FROM devices ${devFilter ? `WHERE ${devFilter}` : ''}`);
  const devices: Record<string, Record<string, { rx_bytes: number; tx_bytes: number; time: string }>> = {};
  for (const d of allowed) {
    const ifaces = latest.get(String(d.id));
    if (!ifaces) continue;
    // No prototype: an interface named __proto__ or constructor is an ordinary key.
    const out: Record<string, { rx_bytes: number; tx_bytes: number; time: string }> = Object.create(null);
    for (const [name, v] of ifaces) {
      if (v.time) out[name] = { rx_bytes: v.rx, tx_bytes: v.tx, time: v.time };
    }
    if (Object.keys(out).length) devices[String(d.id)] = out;
  }
  res.json({ devices });
});

// GET /api/metrics/summary - dashboard summary stats
router.get('/summary', async (req, res) => {
  const siteId = activeSite(req);
  const devFilter = siteScopeDevices(siteId);
  const cliFilter = siteScopeByDevice(siteId, 'device_id');
  const evtFilter = siteScopeByNullableDevice(siteId, 'device_id');
  const [deviceStats, clientStats, alertStats, availStats, rebootStats] = await Promise.all([
    query<{ total: string; online: string; offline: string; degraded: string; intermittent_offline: string }>(
      // Offline excludes devices marked intermittent: they are expected to drop
      // out and are counted on their own (#168).
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='online') as online,
        COUNT(*) FILTER (WHERE status='offline' AND NOT intermittent) as offline,
        COUNT(*) FILTER (WHERE status='online' AND health_status='degraded') as degraded,
        COUNT(*) FILTER (WHERE status='offline' AND intermittent) as intermittent_offline
       FROM devices ${devFilter ? `WHERE ${devFilter}` : ''}`
    ),
    query<{ total: string; active: string }>(
      `SELECT COUNT(DISTINCT mac_address) as total,
              COUNT(DISTINCT mac_address) FILTER (WHERE active=TRUE) as active
       FROM clients ${cliFilter ? `WHERE ${cliFilter}` : ''}`
    ),
    query<{ critical: string; warning: string }>(
      // The severity test sits in the WHERE as well as the FILTERs: almost every event
      // is info, and without it the 24h count read every one of them (hundreds of
      // thousands of rows, about a second) instead of the few that are counted.
      `SELECT
        COUNT(*) FILTER (WHERE severity='error') as critical,
        COUNT(*) FILTER (WHERE severity='warning') as warning
       FROM events WHERE severity IN ('error','warning') AND event_time > NOW() - INTERVAL '24 hours'
         ${evtFilter ? `AND ${evtFilter}` : ''}`
    ),
    query<{ total_outage_sec: string }>(
      // Clipped to the 30 days, ongoing outages included (P2-25).
      `SELECT COALESCE(SUM(${outageSecondsSql(`INTERVAL '30 days'`)}), 0)::bigint::text AS total_outage_sec
       FROM device_availability
       WHERE ${outageOverlapsSql(`INTERVAL '30 days'`)}
         ${cliFilter ? `AND ${cliFilter}` : ''}`
    ),
    // Reboots the polls didn't see as outages (#326).
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM device_reboots
        WHERE boot_at > NOW() - INTERVAL '30 days' ${cliFilter ? `AND ${cliFilter}` : ''}`
    ).catch(() => [{ n: '0' }]),
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
      degraded: parseInt(deviceStats[0]?.degraded || '0', 10),
      intermittent_offline: parseInt(deviceStats[0]?.intermittent_offline || '0', 10),
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
      reboots30d: parseInt(rebootStats[0]?.n || '0', 10),
    },
  });
});

export default router;
