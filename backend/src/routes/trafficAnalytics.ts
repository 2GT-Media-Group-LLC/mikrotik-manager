import { Router, Request } from 'express';
import { getQueryApi, bucket } from '../config/influxdb';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { netflowCollector } from '../services/netflow/NetflowCollector';
import { fluxString } from '@influxdata/influxdb-client';
import { activeSite } from '../middleware/site';
import { siteList } from '../utils/siteScope';
import { lookupAsn, specialKind, asnStatus } from '../utils/asnDatabase';
import { reverseNames } from '../utils/reverseNames';
import { namesForAddresses } from '../utils/addressNames';
import { OTHER_REMOTE } from '../services/netflow/DestinationAggregator';
import net from 'net';
import { timeWindow, pointSeconds, BAD_WINDOW, type TimeWindow } from '../utils/trafficWindow';
import { queryLimit } from '../utils/queryLimit';

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

// MACs are used inside Flux queries — restrict to safe charsets (real MACs
// plus the 'unknown'/'other' pseudo-clients).
function sanitizeMac(raw: string): string | null {
  const mac = raw.toLowerCase();
  if (mac === 'unknown' || mac === 'other') return mac;
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac) ? mac : null;
}

// GET /api/traffic/status — collector state for the config page
router.get('/status', async (req, res) => {
  const stats = netflowCollector.getStats();
  // The exporter list follows the site selector, like the charts (#236). A
  // site-scoped account's selection is always within its own sites (P1-7).
  // Collector totals stay collector-wide; the response says so.
  const sites = siteList(activeSite(req));
  if (!sites) { res.json({ ...stats, site_filtered: false }); return; }
  const own = new Set((await query<{ id: number }>(
    `SELECT id FROM devices WHERE site_id = ANY($1::int[])`, [sites])).map((d) => d.id));
  res.json({
    ...stats,
    // Only this site's devices: unidentified exporters and refused sources
    // carry no site, so they show in the all-sites view only.
    exporters: stats.exporters.filter((e) => own.has(e.deviceId)),
    rejectedSources: [],
    site_filtered: true,
  });
});

// GET /api/traffic/timeseries?range=24h — fleet-wide upload/download over time
router.get('/timeseries', async (req, res) => {
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(${w.flux})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes" or r._field == "packets")
      |> group(columns: ["direction", "_field"])
      |> aggregateWindow(every: ${w.every}, fn: sum, createEmpty: false)
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
    // An Influx failure is not "no traffic" (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }

  // `seconds`: what each point covers, for showing it as a rate.
  res.json(Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time))
    .map((p) => ({ ...p, seconds: pointSeconds(p.time, w) })));
});

type ClientNames = { hostname: string | null; custom_name: string | null; vendor: string | null; ip_address: string | null };

/** Client identity from Postgres for real MACs, from the clients in view only. */
async function withClientNames<T extends { mac: string }>(req: Request, rows: T[]): Promise<(T & ClientNames)[]> {
  const realMacs = rows.map((r) => r.mac).filter((m) => m !== 'unknown' && m !== 'other');
  const names = new Map<string, ClientNames>();
  if (realMacs.length > 0) {
    // Names come from the clients in view, never another site's record of a MAC.
    const sites = siteList(activeSite(req));
    const found = await query<ClientNames & { mac_address: string }>(
      `SELECT DISTINCT ON (LOWER(c.mac_address)) c.mac_address, c.hostname, c.custom_name, c.vendor, c.ip_address
       FROM clients c
       ${sites ? 'JOIN devices d ON d.id = c.device_id AND d.site_id = ANY($2::int[])' : ''}
       WHERE LOWER(c.mac_address) = ANY($1)
       ORDER BY LOWER(c.mac_address), c.last_seen DESC NULLS LAST`,
      sites ? [realMacs, sites] : [realMacs]
    );
    for (const row of found) names.set(row.mac_address.toLowerCase(), row);
  }
  return rows.map((r) => {
    const info = names.get(r.mac);
    return { ...r, hostname: info?.hostname || null, custom_name: info?.custom_name || null, vendor: info?.vendor || null, ip_address: info?.ip_address || null };
  });
}

// GET /api/traffic/top-clients?range=24h&limit=10 — top talkers with client names
router.get('/top-clients', async (req, res) => {
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const limit = queryLimit(req.query.limit, 10, 50);
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(${w.flux})
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
    // An Influx failure is not "no traffic" (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }

  const ranked = Array.from(perMac.entries())
    .map(([mac, e]) => ({ mac, upload_bytes: e.upload, download_bytes: e.download, total_bytes: e.upload + e.download }))
    .sort((a, b) => b.total_bytes - a.total_bytes)
    .slice(0, limit);

  res.json(await withClientNames(req, ranked));
});

// GET /api/traffic/apps?range=24h&mac=xx:xx:.. — app-category byte totals
// (fleet-wide, or for a single client when mac is given)
router.get('/apps', async (req, res) => {
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
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
      |> range(${w.flux})
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
    // An Influx failure is not "no traffic" (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }

  const apps = Array.from(byApp.entries()).map(([app, e]) => ({ app, bytes: e.bytes, packets: e.packets }));
  res.json(apps.sort((a, b) => b.bytes - a.bytes));
});

// GET /api/traffic/apps/:app/clients?range=24h — who generates one application's
// traffic (#366 step 1): each client's download, upload and share of the app's total.
router.get('/apps/:app/clients', async (req, res) => {
  const app = String(req.params.app);
  // App names come from the classifier (HTTP, QUIC, DNS, Other…): printable and short.
  if (!/^[\x20-\x7e]{1,64}$/.test(app)) return res.status(400).json({ error: 'Invalid application' });
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const limit = queryLimit(req.query.limit, 50, 200);
  const site = await siteFilter(req);

  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(${w.flux})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes" and r.app == ${fluxString(app)})
      |> group(columns: ["mac", "direction"])
      |> sum()
  `;

  const perMac = new Map<string, { upload: number; download: number }>();
  try {
    await getQueryApi().collectRows(fluxQuery, (row, tableMeta) => {
      const mac = tableMeta.get(row, 'mac') as string;
      const direction = tableMeta.get(row, 'direction') as string;
      const value = Number(tableMeta.get(row, '_value')) || 0;
      const e = perMac.get(mac) ?? { upload: 0, download: 0 };
      if (direction === 'upload') e.upload += value; else e.download += value;
      perMac.set(mac, e);
    });
  } catch {
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }

  const all = Array.from(perMac.entries())
    .map(([mac, e]) => ({ mac, upload_bytes: e.upload, download_bytes: e.download, total_bytes: e.upload + e.download }))
    .sort((a, b) => b.total_bytes - a.total_bytes);
  const total = all.reduce((s, c) => s + c.total_bytes, 0);
  const top = all.slice(0, limit).map((c) => ({ ...c, share: total > 0 ? c.total_bytes / total : 0 }));
  res.json({ app, total_bytes: total, client_count: all.length, clients: await withClientNames(req, top) });
});

// GET /api/traffic/client/:mac?range=24h — per-client time series + app breakdown
router.get('/client/:mac', async (req, res) => {
  const mac = sanitizeMac(req.params.mac);
  if (!mac) return res.status(400).json({ error: 'Invalid mac' });
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const queryApi = getQueryApi();
  const site = await siteFilter(req);

  const seriesFlux = `
    from(bucket: "${bucket}")
      |> range(${w.flux})
      |> filter(fn: (r) => r._measurement == "client_traffic")
      ${site}
      |> filter(fn: (r) => r._field == "bytes")
      |> filter(fn: (r) => r.mac == ${fluxString(String(mac))})
      |> group(columns: ["direction"])
      |> aggregateWindow(every: ${w.every}, fn: sum, createEmpty: false)
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
    // An Influx failure is not "no traffic" (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }

  const appsFlux = `
    from(bucket: "${bucket}")
      |> range(${w.flux})
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
    // An Influx failure is not "no traffic" (outside review J3).
    return res.status(503).json({ error: 'The metrics database could not be read, so this data is unavailable right now.' });
  }
  const apps = Array.from(byApp.entries()).map(([app, e]) => ({ app, bytes: e.bytes, packets: e.packets }));

  res.json({
    series: Object.values(pivoted).sort((a, b) => a.time.localeCompare(b.time))
      .map((p) => ({ ...p, seconds: pointSeconds(p.time, w) })),
    apps: apps.sort((a, b) => b.bytes - a.bytes),
  });
});

// ─── Destinations (#366 step 2) ──────────────────────────────────────────────

/**
 * The WHERE clause and parameters for destinations in view: the window (whole
 * hours, so 1h covers the current and previous hour, and a window picked on
 * the chart covers every hour it touches), the site(s) in view, and optionally
 * one application, client or remote address. Traffic with no site (site_id 0)
 * is only in a fleet-wide view.
 */
function destinationScope(req: Request, w: TimeWindow, extra: { app?: string; mac?: string; remote?: string }): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: (n: number) => string, value: unknown) => { params.push(value); where.push(sql(params.length)); };
  if (w.stop) {
    add((n) => `hour >= date_trunc('hour', $${n}::timestamptz)`, w.start);
    add((n) => `hour < $${n}::timestamptz`, w.stop);
  } else {
    add((n) => `hour >= date_trunc('hour', NOW()) - make_interval(hours => $${n}::int)`, w.hours);
  }
  const sites = siteList(activeSite(req));
  if (sites) add((n) => `site_id = ANY($${n}::int[])`, sites);
  if (extra.app) add((n) => `app = $${n}`, extra.app);
  if (extra.mac) add((n) => `mac = $${n}`, extra.mac);
  if (extra.remote !== undefined) add((n) => `remote = $${n}`, extra.remote);
  return { where: where.join(' AND '), params };
}

const validApp = (app: unknown): app is string => typeof app === 'string' && /^[\x20-\x7e]{1,32}$/.test(app);

/** Who an address belongs to: its organisation, or what kind of address it is. */
function describeRemote(remote: string) {
  if (remote === OTHER_REMOTE) return { org: null, asn: null, country: null, kind: 'other' as const };
  const kind = specialKind(remote);
  if (kind) return { org: null, asn: null, country: null, kind };
  const a = lookupAsn(remote);
  return { org: a?.org ?? null, asn: a?.asn ?? null, country: a?.country || null, kind: 'public' as const };
}

// ─── DNS names from AdGuard Home (#366 step 3) ───────────────────────────────

/** The first hour in view, for the hourly DNS tables. */
function hourStart(w: TimeWindow): Date {
  const d = new Date(w.start);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** A client's addresses in the site(s) in view, as AdGuard Home sees it. */
async function clientIps(req: Request, mac: string): Promise<string[]> {
  const sites = siteList(activeSite(req));
  const rows = await query<{ ip_address: string }>(
    `SELECT DISTINCT c.ip_address FROM clients c JOIN devices d ON d.id = c.device_id
      WHERE LOWER(c.mac_address) = $1 AND c.ip_address IS NOT NULL AND c.ip_address <> ''
        ${sites ? 'AND d.site_id = ANY($2::int[])' : ''}`,
    sites ? [mac, sites] : [mac]);
  return rows.map((r) => r.ip_address);
}

/**
 * The names behind each address: what clients asked for (AdGuard Home), then
 * the routers' DNS caches. With `ips`, AdGuard answers to those clients only.
 */
async function domainsFor(req: Request, w: TimeWindow, remotes: string[], ips?: string[]): Promise<Map<string, string[]>> {
  return namesForAddresses(remotes, { sites: siteList(activeSite(req)), since: hourStart(w), clientIps: ips });
}

/** Whether an AdGuard Home or Pi-hole source covers any site in view. */
async function dnsConfigured(req: Request): Promise<boolean> {
  const sites = siteList(activeSite(req));
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM dns_sources WHERE enabled ${sites ? 'AND site_id = ANY($1::int[])' : ''}`,
    sites ? [sites] : []).catch(() => [{ n: 0 }]);
  return (r[0]?.n ?? 0) > 0;
}

// GET /api/traffic/dns?range=24h&mac=..&limit=50 — the names looked up, with
// how often each was allowed and blocked, for the site(s) in view or one client.
router.get('/dns', async (req, res) => {
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  let ips: string[] | undefined;
  if (req.query.mac !== undefined) {
    const mac = sanitizeMac(String(req.query.mac));
    if (!mac) return res.status(400).json({ error: 'Invalid mac' });
    ips = await clientIps(req, mac);
  }
  const limit = queryLimit(req.query.limit, 50, 200);
  const sites = siteList(activeSite(req));
  const params: unknown[] = [hourStart(w)];
  let where = 'hour >= $1';
  if (w.stop) { params.push(w.stop); where += ` AND hour < $${params.length}`; }
  if (sites) { params.push(sites); where += ` AND site_id = ANY($${params.length}::int[])`; }
  if (ips) { params.push(ips); where += ` AND client_ip = ANY($${params.length}::text[])`; }
  try {
    const configured = await dnsConfigured(req);
    const [names, totals] = ips && ips.length === 0 ? [[], [{ allowed: 0, blocked: 0 }]] : await Promise.all([
      query<{ name: string; allowed: number; blocked: number; clients: number }>(
        `SELECT name, SUM(allowed)::int AS allowed, SUM(blocked)::int AS blocked, COUNT(DISTINCT client_ip)::int AS clients
           FROM dns_name_counts WHERE ${where}
          GROUP BY name ORDER BY SUM(allowed + blocked) DESC LIMIT ${limit}`, params),
      query<{ allowed: number; blocked: number }>(
        `SELECT COALESCE(SUM(allowed), 0)::int AS allowed, COALESCE(SUM(blocked), 0)::int AS blocked
           FROM dns_name_counts WHERE ${where}`, params),
    ]);
    res.json({ configured, allowed: totals[0]?.allowed ?? 0, blocked: totals[0]?.blocked ?? 0, names,
      client_addresses: ips ?? null });
  } catch (e) {
    console.error('[Traffic] dns:', (e as Error).message);
    res.status(503).json({ error: 'DNS lookups could not be read right now.' });
  }
});

// GET /api/traffic/dns/clients?range=24h — clients by how many lookups they
// made, with how many were blocked, matched to clients by address.
router.get('/dns/clients', async (req, res) => {
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const sites = siteList(activeSite(req));
  const params: unknown[] = [hourStart(w)];
  let where = 'n.hour >= $1';
  if (w.stop) { params.push(w.stop); where += ` AND n.hour < $${params.length}`; }
  if (sites) { params.push(sites); where += ` AND n.site_id = ANY($${params.length}::int[])`; }
  try {
    const rows = await query<{ client_ip: string; site_id: number; allowed: number; blocked: number; names: number }>(
      `SELECT n.client_ip, n.site_id, SUM(n.allowed)::int AS allowed, SUM(n.blocked)::int AS blocked, COUNT(DISTINCT n.name)::int AS names
         FROM dns_name_counts n WHERE ${where}
        GROUP BY n.client_ip, n.site_id ORDER BY SUM(n.allowed + n.blocked) DESC LIMIT 100`, params);
    // The client behind each address, in the source's site; newest holder first (DHCP reuse).
    const macs = new Map<string, string>();
    if (rows.length) {
      const found = await query<{ site_id: number; ip_address: string; mac_address: string }>(
        `SELECT DISTINCT ON (d.site_id, c.ip_address) d.site_id, c.ip_address, LOWER(c.mac_address) AS mac_address
           FROM clients c JOIN devices d ON d.id = c.device_id
          WHERE c.ip_address = ANY($1::text[])
          ORDER BY d.site_id, c.ip_address, c.last_seen DESC NULLS LAST`, [rows.map((r) => r.client_ip)]);
      for (const f of found) macs.set(`${f.site_id}|${f.ip_address}`, f.mac_address);
    }
    const clients = rows.map((r) => ({
      mac: macs.get(`${r.site_id}|${r.client_ip}`) ?? 'unknown', client_ip: r.client_ip,
      allowed: r.allowed, blocked: r.blocked, names: r.names,
      upload_bytes: 0, download_bytes: 0, total_bytes: 0,
    }));
    res.json({ configured: await dnsConfigured(req), clients: await withClientNames(req, clients) });
  } catch (e) {
    console.error('[Traffic] dns clients:', (e as Error).message);
    res.status(503).json({ error: 'DNS lookups could not be read right now.' });
  }
});

async function destinationRetention(): Promise<number> {
  const r = await query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'retention_destinations_days'`).catch(() => []);
  const n = Number(r[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

// GET /api/traffic/destinations?range=24h&app=HTTPS&mac=..&limit=50 — where
// traffic goes: the whole site, one application, one client, or one client's
// use of one application. Each row: the remote address, who owns it (the
// organisation, from the ASN list), its reverse DNS name if any, bytes each
// way, and how many clients used it.
router.get('/destinations', async (req, res) => {
  const app = req.query.app === undefined ? undefined : String(req.query.app);
  if (app !== undefined && !validApp(app)) return res.status(400).json({ error: 'Invalid application' });
  let mac: string | undefined;
  if (req.query.mac !== undefined) {
    const m = sanitizeMac(String(req.query.mac));
    if (!m) return res.status(400).json({ error: 'Invalid mac' });
    mac = m;
  }
  const limit = queryLimit(req.query.limit, 50, 200);
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const { where, params } = destinationScope(req, w, { app, mac });
  try {
    const [rows, totals, first] = await Promise.all([
      query<{ remote: string; upload: string; download: string; clients: number; apps: string[] }>(
        `SELECT remote, SUM(upload_bytes)::text AS upload, SUM(download_bytes)::text AS download,
                COUNT(DISTINCT mac)::int AS clients, (ARRAY_AGG(DISTINCT app))[1:5] AS apps
           FROM client_destinations WHERE ${where} AND remote <> ''
          GROUP BY remote ORDER BY SUM(upload_bytes + download_bytes) DESC LIMIT ${limit}`, params),
      query<{ total: string | null; other: string | null }>(
        `SELECT SUM(upload_bytes + download_bytes)::text AS total,
                (SUM(upload_bytes + download_bytes) FILTER (WHERE remote = ''))::text AS other
           FROM client_destinations WHERE ${where}`, params),
      // When collecting began: right after an upgrade a 24h view holds only the
      // last hour or so, which shouldn't read as missing data. Every site's rows
      // count, since it's the manager that began, not a site; hour leads the
      // primary key, so this is an index lookup.
      query<{ first: Date | null }>(`SELECT MIN(hour) AS first FROM client_destinations`),
    ]);
    const total = Number(totals[0]?.total ?? 0);
    const retentionDays = await destinationRetention();
    // Once retention has pruned the oldest hours, the first one left is the
    // retention cutoff, not when collecting began: the range's start or that
    // cutoff, whichever is later, is where rows are expected to begin. An hour's
    // slack covers pruning that isn't on the hour.
    const expectedFrom = Math.max(hourStart(w).getTime(), Date.now() - retentionDays * 86_400_000);
    const firstHour = first[0]?.first ? new Date(first[0].first) : null;
    const recordedSince = firstHour && firstHour.getTime() > expectedFrom + 3_600_000 ? firstHour.toISOString() : null;
    const remotes = rows.map((r) => r.remote);
    const [names, domains] = await Promise.all([
      reverseNames(remotes),
      domainsFor(req, w, remotes, mac ? await clientIps(req, mac) : undefined),
    ]);
    res.json({
      total_bytes: total,
      other_bytes: Number(totals[0]?.other ?? 0),
      retention_days: retentionDays,
      // Set only when the range starts before anything was recorded.
      recorded_since: recordedSince,
      names_available: asnStatus().loaded,
      destinations: rows.map((r) => {
        const up = Number(r.upload), down = Number(r.download);
        return {
          remote: r.remote, ...describeRemote(r.remote), name: names.get(r.remote) ?? null,
          domains: domains.get(r.remote) ?? [],
          upload_bytes: up, download_bytes: down, total_bytes: up + down,
          share: total > 0 ? (up + down) / total : 0, client_count: r.clients, apps: r.apps,
        };
      }),
    });
  } catch (e) {
    console.error('[Traffic] destinations:', (e as Error).message);
    res.status(503).json({ error: 'Destinations could not be read right now.' });
  }
});

// GET /api/traffic/destinations/:remote/clients?range=24h&app=.. — the clients
// that talked to one address, busiest first.
router.get('/destinations/:remote/clients', async (req, res) => {
  const remote = String(req.params.remote);
  if (!net.isIP(remote)) return res.status(400).json({ error: 'Invalid address' });
  const app = req.query.app === undefined ? undefined : String(req.query.app);
  if (app !== undefined && !validApp(app)) return res.status(400).json({ error: 'Invalid application' });
  const w = timeWindow(req.query);
  if (!w) return res.status(400).json({ error: BAD_WINDOW });
  const { where, params } = destinationScope(req, w, { app, remote });
  try {
    const rows = await query<{ mac: string; upload: string; download: string; apps: string[] }>(
      `SELECT mac, SUM(upload_bytes)::text AS upload, SUM(download_bytes)::text AS download, ARRAY_AGG(DISTINCT app) AS apps
         FROM client_destinations WHERE ${where}
        GROUP BY mac ORDER BY SUM(upload_bytes + download_bytes) DESC LIMIT 100`, params);
    const clients = rows.map((r) => ({
      mac: r.mac, upload_bytes: Number(r.upload), download_bytes: Number(r.download),
      total_bytes: Number(r.upload) + Number(r.download), apps: r.apps,
    }));
    const [names, domains] = await Promise.all([reverseNames([remote]), domainsFor(req, w, [remote])]);
    res.json({
      remote, ...describeRemote(remote), name: names.get(remote) ?? null, domains: domains.get(remote) ?? [],
      clients: await withClientNames(req, clients),
    });
  } catch (e) {
    console.error('[Traffic] destination clients:', (e as Error).message);
    res.status(503).json({ error: 'Destinations could not be read right now.' });
  }
});

export default router;
