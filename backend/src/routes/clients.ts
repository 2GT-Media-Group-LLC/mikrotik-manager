import { Router, Request, Response } from 'express';
import * as dgram from 'dgram';
import { query } from '../config/database';
import { requireAuth, requireAdmin, requireWrite } from '../middleware/auth';
import { PollerService } from '../services/PollerService';
import { getQueryApi, bucket } from '../config/influxdb';

const router = Router();
router.use(requireAuth);

let pollerService: PollerService | null = null;
export function setPollerService(p: PollerService): void { pollerService = p; }

// GET /api/clients
router.get('/', async (req: Request, res: Response) => {
  const { deviceId, active, search, client_type, limit = '100', offset = '0' } = req.query;

  // Build WHERE clause shared by both queries
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  let idx = 1;

  if (deviceId) {
    filters.push(`c.device_id = $${idx++}`);
    filterParams.push(deviceId);
  }
  if (active === 'true') {
    filters.push(`c.active = TRUE`);
  }
  if (client_type) {
    filters.push(`c.client_type = $${idx++}`);
    filterParams.push(client_type);
  }
  if (search) {
    filters.push(`(c.mac_address ILIKE $${idx} OR c.custom_name ILIKE $${idx} OR c.hostname ILIKE $${idx} OR c.ip_address ILIKE $${idx} OR c.vendor ILIKE $${idx})`);
    filterParams.push(`%${search}%`);
    idx++;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  // Deduplicate by MAC address across devices: prefer active rows, then most recently seen.
  // The inner DISTINCT ON picks the best row per MAC; the outer query applies final sort + pagination.
  const sql = `
    SELECT * FROM (
      SELECT DISTINCT ON (c.mac_address)
        c.*, d.name as device_name,
        wi.ssid as ssid
      FROM clients c
      JOIN devices d ON d.id = c.device_id
      LEFT JOIN wireless_interfaces wi
        ON wi.device_id = c.device_id AND wi.name = c.interface_name
      ${where}
      ORDER BY c.mac_address, (c.client_type = 'wireless') DESC, c.active DESC, c.last_seen DESC NULLS LAST
    ) deduped
    ORDER BY last_seen DESC NULLS LAST
    LIMIT $${idx++} OFFSET $${idx++}
  `;
  const clients = await query(sql, [...filterParams, parseInt(String(limit), 10), parseInt(String(offset), 10)]);

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(DISTINCT c.mac_address) as total FROM clients c ${where}`,
    filterParams
  );

  res.json({
    clients,
    total: parseInt(countResult[0]?.total || '0', 10),
  });
});

// GET /api/clients/:mac — detail view with SSID, VLAN name, device type, upstream topology
router.get('/:mac', async (req: Request, res: Response) => {
  const mac = req.params.mac.toLowerCase();

  // Order: wireless records before wired (AP knows the client best), then active,
  // then most recently seen. Use LATERAL for topology so we never multiply rows.
  const rows = await query<Record<string, unknown>>(
    `SELECT c.*, d.name as device_name, d.device_type,
            wi.ssid as ssid,
            v.name as vlan_name,
            topo.upstream_device_id,
            topo.upstream_interface,
            topo.upstream_device_name,
            topo.upstream_device_type,
            topo.upstream_device_ip
     FROM clients c
     JOIN devices d ON d.id = c.device_id
     LEFT JOIN wireless_interfaces wi
       ON wi.device_id = c.device_id AND wi.name = c.interface_name
     LEFT JOIN vlans v
       ON v.device_id = c.device_id AND v.vlan_id = c.vlan_id
     LEFT JOIN LATERAL (
       SELECT tl.to_device_id   AS upstream_device_id,
              tl.to_interface   AS upstream_interface,
              ud.name           AS upstream_device_name,
              ud.device_type    AS upstream_device_type,
              ud.ip_address     AS upstream_device_ip
       FROM topology_links tl
       JOIN devices ud ON ud.id = tl.to_device_id
       WHERE tl.from_device_id = c.device_id
       LIMIT 1
     ) topo ON TRUE
     WHERE LOWER(c.mac_address) = $1
     ORDER BY (c.client_type = 'wireless') DESC, c.active DESC, c.last_seen DESC NULLS LAST
     LIMIT 1`,
    [mac]
  );

  if (!rows.length) return res.status(404).json({ error: 'Client not found' });
  return res.json(rows[0]);
});

// GET /api/clients/:mac/presence?range=2h|24h|7d — connectivity timeline from InfluxDB
router.get('/:mac/presence', async (req: Request, res: Response) => {
  const mac = req.params.mac.toLowerCase();
  const rangeRaw = String(req.query.range || '24h');
  const allowedRanges: Record<string, string> = { '2h': '2h', '24h': '24h', '7d': '7d' };
  const range = allowedRanges[rangeRaw] || '24h';

  // Window size: 5m for 2h/24h, 30m for 7d
  const window = range === '7d' ? '30m' : '5m';

  const queryApi = getQueryApi();
  // Group by mac_address only (drop device_id) so that all devices reporting the
  // same client are merged into one series. fn:max means online=1 if any device
  // saw the client in that window; createEmpty+fill gives offline=0 for gaps.
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_presence")
      |> filter(fn: (r) => r._field == "online")
      |> filter(fn: (r) => r.mac_address == "${mac}")
      |> group(columns: ["_measurement", "_field", "mac_address"])
      |> aggregateWindow(every: ${window}, fn: max, createEmpty: true)
      |> fill(value: 0)
      |> yield(name: "presence")
  `;

  const points: { time: string; online: number }[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const time = tableMeta.get(row, '_time') as string;
      const value = tableMeta.get(row, '_value') as number;
      points.push({ time, online: value != null ? Math.round(value) : 0 });
    });
  } catch {
    // InfluxDB not available or no data yet
  }

  return res.json(points);
});

// GET /api/clients/:mac/traffic?range=2h|24h|7d — wireless tx/rx rate graph
router.get('/:mac/traffic', async (req: Request, res: Response) => {
  const mac = req.params.mac.toLowerCase();
  const rangeRaw = String(req.query.range || '24h');
  const allowedRanges: Record<string, string> = { '2h': '2h', '24h': '24h', '7d': '7d' };
  const range = allowedRanges[rangeRaw] || '24h';

  const window = range === '7d' ? '30m' : '5m';

  const queryApi = getQueryApi();
  // Simple query: get the last cumulative byte counter value per time window.
  // Non-negative differences are computed in TypeScript below — avoids the
  // fragile non_negative_difference+pivot combination in Flux.
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_presence")
      |> filter(fn: (r) => r._field == "tx_bytes" or r._field == "rx_bytes")
      |> filter(fn: (r) => r.mac_address == "${mac}")
      |> group(columns: ["_measurement", "_field", "mac_address"])
      |> aggregateWindow(every: ${window}, fn: last, createEmpty: false)
      |> yield(name: "traffic_raw")
  `;

  const raw: { time: string; field: string; value: number }[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const time  = tableMeta.get(row, '_time')  as string;
      const field = tableMeta.get(row, '_field') as string;
      const value = tableMeta.get(row, '_value') as number;
      if (time && field && value != null) raw.push({ time, field, value });
    });
  } catch (err) {
    console.error(`[clients/traffic] Flux error for ${mac}:`, err);
  }

  // Separate tx and rx series, sort by time, then compute non-negative deltas
  const txSeries = raw.filter(p => p.field === 'tx_bytes').sort((a, b) => a.time.localeCompare(b.time));
  const rxSeries = raw.filter(p => p.field === 'rx_bytes').sort((a, b) => a.time.localeCompare(b.time));

  const txDeltas = new Map<string, number>();
  for (let i = 1; i < txSeries.length; i++) {
    const diff = txSeries[i].value - txSeries[i - 1].value;
    if (diff >= 0) txDeltas.set(txSeries[i].time, diff);
  }

  const rxDeltas = new Map<string, number>();
  for (let i = 1; i < rxSeries.length; i++) {
    const diff = rxSeries[i].value - rxSeries[i - 1].value;
    if (diff >= 0) rxDeltas.set(rxSeries[i].time, diff);
  }

  const allTimes = new Set([...txDeltas.keys(), ...rxDeltas.keys()]);
  const points = [...allTimes].sort().map(time => ({
    time,
    tx_bytes: txDeltas.get(time) ?? 0,
    rx_bytes: rxDeltas.get(time) ?? 0,
  }));

  return res.json(points);
});

// GET /api/clients/:mac/signal?range=2h|24h|7d — signal strength over time
router.get('/:mac/signal', async (req: Request, res: Response) => {
  const mac = req.params.mac.toLowerCase();
  const rangeRaw = String(req.query.range || '24h');
  const allowedRanges: Record<string, string> = { '2h': '2h', '24h': '24h', '7d': '7d' };
  const range = allowedRanges[rangeRaw] || '24h';

  const window = range === '7d' ? '30m' : '5m';

  const queryApi = getQueryApi();
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${range})
      |> filter(fn: (r) => r._measurement == "client_presence")
      |> filter(fn: (r) => r._field == "signal_strength")
      |> filter(fn: (r) => r.mac_address == "${mac}")
      |> group(columns: ["_measurement", "_field", "mac_address"])
      |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)
      |> yield(name: "signal")
  `;

  const points: { time: string; signal_strength: number }[] = [];
  try {
    await queryApi.collectRows(fluxQuery, (row, tableMeta) => {
      const time  = tableMeta.get(row, '_time')  as string;
      const value = tableMeta.get(row, '_value') as number;
      if (time && value != null) points.push({ time, signal_strength: Math.round(value) });
    });
  } catch (err) {
    console.error(`[clients/signal] Flux error for ${mac}:`, err);
  }

  return res.json(points);
});

// POST /api/clients/:mac/wol — send Wake-on-LAN magic packet
router.post('/:mac/wol', requireWrite, async (req: Request, res: Response) => {
  const mac = req.params.mac.replace(/[^0-9a-fA-F:.-]/g, '');
  const hexMac = mac.replace(/[:\-.]/g, '');
  if (hexMac.length !== 12) {
    return res.status(400).json({ error: 'Invalid MAC address' });
  }

  // Build magic packet: 6 bytes of 0xFF + MAC repeated 16 times
  const macBytes = Buffer.from(hexMac, 'hex');
  const magic = Buffer.alloc(102);
  magic.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(magic, 6 + i * 6);
  }

  return new Promise<void>((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      res.status(500).json({ error: `WoL send failed: ${err.message}` });
      resolve();
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magic, 0, magic.length, 9, '255.255.255.255', (err) => {
        socket.close();
        if (err) {
          res.status(500).json({ error: `WoL send failed: ${err.message}` });
        } else {
          res.json({ success: true, message: `Magic packet sent to ${mac}` });
        }
        resolve();
      });
    });
  });
});

// PUT /api/clients/:mac/hostname  (writes to custom_name — user-set names persist across collector cycles)
router.put('/:mac/hostname', requireWrite, async (req: Request, res: Response) => {
  const { hostname } = req.body as { hostname?: string };
  const mac = req.params.mac.toLowerCase();

  const result = await query(
    `UPDATE clients SET custom_name = $1 WHERE LOWER(mac_address) = $2 RETURNING *`,
    [hostname || null, mac]
  );
  if (!result.length) return res.status(404).json({ error: 'Client not found' });
  return res.json(result[0]);
});

// PUT /api/clients/:mac/notes — update the comment/notes field
router.put('/:mac/notes', requireWrite, async (req: Request, res: Response) => {
  const { notes } = req.body as { notes?: string };
  const mac = req.params.mac.toLowerCase();

  const result = await query(
    `UPDATE clients SET comment = $1 WHERE LOWER(mac_address) = $2 RETURNING *`,
    [notes ?? null, mac]
  );
  if (!result.length) return res.status(404).json({ error: 'Client not found' });
  return res.json(result[0]);
});

// POST /api/clients/purge — immediately delete inactive clients older than retention period
router.post('/purge', requireAdmin, async (_req: Request, res: Response) => {
  if (!pollerService) return res.status(503).json({ error: 'Poller not available' });
  const count = await pollerService.pruneStaleClientsNow();
  return res.json({ message: `Purged ${count} stale client record(s)`, count });
});

export default router;
