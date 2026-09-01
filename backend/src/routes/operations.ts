import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { getQueryApi } from '../config/influxdb';
import { requireAuth, requireWrite } from '../middleware/auth';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { BackupService, BackupDevice } from '../services/BackupService';

const router = Router();
router.use(requireAuth);

const backupService = new BackupService();

const bucket = process.env.INFLUXDB_BUCKET || 'mikrotik';

type Sev = 'error' | 'warn' | 'info';
interface AttentionItem {
  sev: Sev; category: string; title: string; body: string; action: string; path: string;
  /** Stable identity for an item that is otherwise recomputed each request (#102). */
  fingerprint?: string;
}

/**
 * Identify an insight by what it is about rather than by its wording.
 *
 * Insights are derived from live state, so they have no id to dismiss. Keying on
 * category plus the target path survives a reworded title — dismissing "sw1 is
 * unreachable" should stay dismissed if the copy changes, but must NOT swallow a
 * different device's outage.
 */
function fingerprintOf(item: AttentionItem): string {
  return `${item.category}|${item.path}|${item.title}`.slice(0, 160);
}

// Latest value per device for a set of device_resources fields.
async function latestResources(): Promise<Map<string, { cpu: number; memTotal: number; memUsed: number }>> {
  const out = new Map<string, { cpu: number; memTotal: number; memUsed: number }>();
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -15m)
      |> filter(fn: (r) => r["_measurement"] == "device_resources")
      |> filter(fn: (r) => r["_field"] == "cpu_load" or r["_field"] == "memory_total" or r["_field"] == "memory_used")
      |> group(columns: ["device_id", "_field"])
      |> last()
  `;
  try {
    const api = getQueryApi();
    await new Promise<void>((resolve, reject) => {
      api.queryRows(flux, {
        next(row, tableMeta) {
          const o = tableMeta.toObject(row) as Record<string, unknown>;
          const id = String(o['device_id'] || '');
          const field = String(o['_field'] || '');
          const val = Number(o['_value']) || 0;
          const e = out.get(id) || { cpu: 0, memTotal: 0, memUsed: 0 };
          if (field === 'cpu_load') e.cpu = val;
          else if (field === 'memory_total') e.memTotal = val;
          else if (field === 'memory_used') e.memUsed = val;
          out.set(id, e);
        },
        error: reject,
        complete: resolve,
      });
    });
  } catch { /* influx unavailable → empty */ }
  return out;
}

// Latest TX-retry % per radio (from the RF Health series).
async function latestRetries(): Promise<{ device_id: string; device_name: string; interface: string; pct: number }[]> {
  const rows: { device_id: string; device_name: string; interface: string; pct: number }[] = [];
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -1h)
      |> filter(fn: (r) => r["_measurement"] == "wireless_radio_quality")
      |> filter(fn: (r) => r["_field"] == "tx_retry_pct")
      |> group(columns: ["device_id", "device_name", "interface"])
      |> last()
  `;
  try {
    const api = getQueryApi();
    await new Promise<void>((resolve, reject) => {
      api.queryRows(flux, {
        next(row, tableMeta) {
          const o = tableMeta.toObject(row) as Record<string, unknown>;
          rows.push({
            device_id: String(o['device_id'] || ''),
            device_name: String(o['device_name'] || ''),
            interface: String(o['interface'] || ''),
            pct: Number(o['_value']) || 0,
          });
        },
        error: reject,
        complete: resolve,
      });
    });
  } catch { /* ignore */ }
  return rows;
}

// GET /api/operations/insights — aggregated operational intelligence (no live
// device connections; all from Postgres + InfluxDB so it's fast).
router.get('/insights', async (_req: Request, res: Response) => {
  const [
    devices, missingBackup, recentOutages, weakWifi, coChannel, eventCounts,
  ] = await Promise.all([
    query<{
      id: number; name: string; status: string; last_seen: string | null;
      device_type: string; ros_version: string | null;
      firmware_update_available: boolean; latest_ros_version: string | null;
      routerboard_upgrade_available: boolean; firmware_version: string | null;
      upgrade_firmware_version: string | null;
    }>(`SELECT id, name, status, last_seen, device_type, ros_version,
               firmware_update_available, latest_ros_version,
               routerboard_upgrade_available, firmware_version, upgrade_firmware_version
        FROM devices`),
    query<{ id: number; name: string; last_backup: string | null }>(`
      SELECT d.id, d.name, MAX(b.created_at) AS last_backup
      FROM devices d LEFT JOIN backups b ON b.device_id = d.id
      GROUP BY d.id
      HAVING MAX(b.created_at) IS NULL OR MAX(b.created_at) < NOW() - INTERVAL '7 days'`),
    query<{ device_id: number; name: string; outages: string }>(`
      SELECT a.device_id, d.name, COUNT(*) AS outages
      FROM device_availability a JOIN devices d ON d.id = a.device_id
      WHERE a.went_offline_at > NOW() - INTERVAL '7 days'
      GROUP BY a.device_id, d.name`),
    query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM clients
      WHERE active = TRUE AND client_type = 'wireless'
        AND signal_strength IS NOT NULL AND signal_strength < -75`),
    query<{ frequency: number; radios: string }>(`
      SELECT frequency, COUNT(*) AS radios FROM wireless_interfaces
      WHERE disabled = FALSE AND frequency IS NOT NULL AND frequency > 0
        AND (config_json->>'master-interface') IS NULL
      GROUP BY frequency HAVING COUNT(*) > 1`),
    query<{ errors: string; warnings: string }>(`
      SELECT COUNT(*) FILTER (WHERE severity = 'error')   AS errors,
             COUNT(*) FILTER (WHERE severity = 'warning') AS warnings
      FROM events WHERE event_time > NOW() - INTERVAL '24 hours'`),
  ]);

  const [resources, retries] = await Promise.all([latestResources(), latestRetries()]);

  const attention: AttentionItem[] = [];

  for (const d of devices) {
    if (d.status === 'offline') {
      attention.push({
        sev: 'error', category: 'availability',
        title: `${d.name} is unreachable`,
        body: `Last seen ${d.last_seen ? timeAgo(d.last_seen) : 'never'}.`,
        action: 'View device', path: `/devices/${d.id}`,
      });
    }
  }
  // The poller's own health belongs here. A fleet outrunning its workers looks
  // exactly like a fleet of broken devices — stale data everywhere and no
  // explanation — and the operator who most needs to know is the one least
  // likely to go reading an API endpoint (#114).
  try {
    const { pollerService } = await import('../services/pollerRef');
    const health = pollerService ? await pollerService.getPollerHealth() : null;
    if (health && health.status !== 'ok') {
      const cap = health.capacity as Record<string, number | null>;
      const backlog = cap.backlog ?? 0;
      const saturated = health.status === 'saturated';
      attention.push({
        sev: saturated ? 'error' : 'warn',
        category: 'poller',
        title: saturated
          ? 'Polling cannot keep up with this fleet'
          : `Polling is behind — ${backlog.toLocaleString()} jobs queued`,
        body: saturated
          ? `Each cycle enqueues ${cap.arrival_per_sec}/s but the workers clear only ${cap.service_per_sec}/s, so devices will go stale. Raise POLLER_CONCURRENCY or lengthen the interval.`
          : `Clearing at the current rate takes ${cap.drain_eta_sec == null ? 'longer than it is accumulating' : `about ${Math.round((cap.drain_eta_sec || 0) / 60)} min`}. Devices poll late until it clears.`,
        action: 'Open poller health', path: '/settings?tab=poller',
      });
    }
  } catch { /* health is advisory — never let it break the dashboard */ }

  for (const d of devices) {
    if (d.firmware_update_available) {
      attention.push({
        sev: 'warn', category: 'updates',
        title: `RouterOS update available for ${d.name}`,
        body: `Running ${d.ros_version}${d.latest_ros_version ? `, ${d.latest_ros_version} available` : ''}.`,
        action: 'Review update', path: `/devices/${d.id}?tab=config`,
      });
    }
    if (d.routerboard_upgrade_available) {
      attention.push({
        sev: 'info', category: 'updates',
        title: `RouterBOOT upgrade available for ${d.name}`,
        body: `Firmware ${d.firmware_version}${d.upgrade_firmware_version ? ` → ${d.upgrade_firmware_version}` : ''}.`,
        action: 'Review upgrade', path: `/devices/${d.id}?tab=config`,
      });
    }
  }

  // Capacity pressure (CPU / memory)
  const capacity: { id: number; name: string; cpu: number; mem_pct: number }[] = [];
  for (const d of devices) {
    const r = resources.get(String(d.id));
    if (!r) continue;
    const memPct = r.memTotal > 0 ? Math.round((r.memUsed / r.memTotal) * 100) : 0;
    capacity.push({ id: d.id, name: d.name, cpu: Math.round(r.cpu), mem_pct: memPct });
    if (r.cpu >= 85) {
      attention.push({
        sev: 'warn', category: 'capacity',
        title: `${d.name} CPU is high (${Math.round(r.cpu)}%)`,
        body: 'Sustained high CPU can drop management responsiveness and routing throughput.',
        action: 'View device', path: `/devices/${d.id}`,
      });
    }
    if (memPct >= 90) {
      attention.push({
        sev: 'warn', category: 'capacity',
        title: `${d.name} memory is high (${memPct}%)`,
        body: 'Low free memory risks instability; check for leaks or oversized tables.',
        action: 'View device', path: `/devices/${d.id}`,
      });
    }
  }

  // Backups
  for (const b of missingBackup) {
    attention.push({
      sev: 'warn', category: 'backups',
      title: `${b.name} has no recent backup`,
      body: b.last_backup ? `Last backup ${timeAgo(b.last_backup)}.` : 'No backup has ever been taken.',
      action: 'Back up', path: '/backups',
    });
  }

  // Reliability — recent outages (device still online now, but flapped)
  for (const o of recentOutages) {
    const dev = devices.find(d => d.id === o.device_id);
    if (dev && dev.status === 'offline') continue; // already covered by the offline item
    attention.push({
      sev: 'info', category: 'reliability',
      title: `${o.name} had ${o.outages} outage${Number(o.outages) !== 1 ? 's' : ''} this week`,
      body: 'Recent connectivity flapping — worth checking power, uplink, or PoE.',
      action: 'View device', path: `/devices/${o.device_id}`,
    });
  }

  // WiFi — weak clients
  const weakCount = parseInt(weakWifi[0]?.count || '0', 10);
  if (weakCount > 0) {
    attention.push({
      sev: 'warn', category: 'wifi',
      title: `${weakCount} wireless client${weakCount !== 1 ? 's' : ''} on weak signal`,
      body: 'Clients connected below −75 dBm — likely coverage gaps or far-roaming devices.',
      action: 'Open Wireless', path: '/wireless',
    });
  }

  // WiFi — co-channel overlap
  if (coChannel.length > 0) {
    const chans = coChannel.map(c => freqToChannel(c.frequency)).filter(Boolean);
    attention.push({
      sev: 'warn', category: 'wifi',
      title: `Co-channel overlap on ${coChannel.length} channel${coChannel.length !== 1 ? 's' : ''}`,
      body: `Multiple radios share channel${chans.length ? ` ${chans.join(', ')}` : ''}. Overlapping cells reduce airtime — re-plan channels.`,
      action: 'Open Wireless', path: '/wireless',
    });
  }

  // WiFi — high TX retries
  const badRetries = retries.filter(r => r.pct >= 15);
  for (const r of badRetries) {
    attention.push({
      sev: 'warn', category: 'wifi',
      title: `High TX retries on ${r.device_name} (${r.interface})`,
      body: `${r.pct.toFixed(0)}% transmit retries — interference or weak clients on this radio.`,
      action: 'Open Wireless', path: '/wireless',
    });
  }

  // Recent error events
  const errCount = parseInt(eventCounts[0]?.errors || '0', 10);
  if (errCount > 0) {
    attention.push({
      sev: 'info', category: 'events',
      title: `${errCount} error-level event${errCount !== 1 ? 's' : ''} in the last 24h`,
      body: 'Recent error logs across the fleet may need a look.',
      action: 'Open Events', path: '/events',
    });
  }

  // Rogue APs — evil twins broadcasting our SSIDs from foreign hardware
  try {
    const { classifyScans } = await import('../utils/rogueAp');
    const [scans, radios, ifaceMacs] = await Promise.all([
      query<{ device_id: number; device_name: string; scanned_at: string; data: unknown }>(`
        SELECT DISTINCT ON (a.device_id) a.device_id, d.name AS device_name, a.scanned_at, a.data
        FROM ap_scan_data a JOIN devices d ON d.id = a.device_id
        ORDER BY a.device_id, a.scanned_at DESC`),
      query<{ ssid: string | null; mac_address: string | null }>(`SELECT ssid, mac_address FROM wireless_interfaces`),
      query<{ mac_address: string }>(`SELECT mac_address FROM interfaces WHERE mac_address IS NOT NULL`),
    ]);
    const ownSsids = new Set(radios.map(r => r.ssid || '').filter(Boolean));
    const ownBssids = new Set([
      ...radios.map(r => (r.mac_address || '').toLowerCase()).filter(Boolean),
      ...ifaceMacs.map(r => r.mac_address.toLowerCase()),
    ]);
    const { rogues } = classifyScans(
      scans.map(s => ({ deviceName: s.device_name, scannedAt: String(s.scanned_at), networks: Array.isArray(s.data) ? s.data as import('../utils/rogueAp').ScannedNetwork[] : [] })),
      ownSsids, ownBssids
    );
    for (const r of rogues) {
      attention.push({
        sev: 'error', category: 'security',
        title: `Rogue AP broadcasting "${r.ssid}"`,
        body: `Foreign BSSID ${r.bssid}${r.vendor ? ` (${r.vendor})` : ''} at ${r.signal} dBm, seen by ${r.seenBy} — possible evil twin.`,
        action: 'Open Wireless', path: '/wireless',
      });
    }
  } catch { /* scan data unavailable */ }

  // Config Health — configurations RouterOS accepted but that do not work. These
  // are latent: nothing alerts on them because the device reports no error, so the
  // dashboard is where they surface. Grouped per device to avoid flooding the feed.
  try {
    const findings = await query<{
      device_id: number; name: string; severity: string; title: string; rule: string; count: string;
    }>(`
      SELECT f.device_id, d.name, f.severity, f.title, f.rule,
             COUNT(*) OVER (PARTITION BY f.device_id, f.severity) AS count
      FROM device_config_findings f
      JOIN devices d ON d.id = f.device_id
      WHERE f.severity IN ('critical', 'warning')
      ORDER BY f.device_id, CASE f.severity WHEN 'critical' THEN 0 ELSE 1 END, f.rule`);

    const seen = new Set<string>();
    for (const f of findings) {
      const key = `${f.device_id}:${f.severity}`;
      if (seen.has(key)) continue;      // one item per device+severity, naming the first
      seen.add(key);
      const extra = parseInt(f.count, 10) - 1;
      attention.push({
        sev: f.severity === 'critical' ? 'error' : 'warn',
        category: 'config',
        title: `${f.name}: ${f.title}`,
        body: extra > 0
          ? `RouterOS accepted this configuration without complaint. ${extra} more ${f.severity} finding${extra !== 1 ? 's' : ''} on this device.`
          : 'RouterOS accepted this configuration without complaint.',
        action: 'Open Config Health', path: `/devices/${f.device_id}?tab=security`,
      });
    }
  } catch { /* findings table unavailable */ }

  // Baseline anomalies (client counts, CPU, error bursts)
  const anomalies = await detectAnomalies();
  for (const a of anomalies) attention.push(a);

  // Dismissals (#102). Expired rows are cleared on read, so a dismissal lapses
  // without needing a scheduled job, and an item still true when it lapses simply
  // reappears — which is the intended behaviour of "remind me later".
  await query(`DELETE FROM insight_dismissals WHERE expires_at < NOW()`).catch(() => []);
  const dismissed = new Set(
    (await query<{ fingerprint: string }>(`SELECT fingerprint FROM insight_dismissals`)
      .catch(() => [])).map((r) => r.fingerprint)
  );

  for (const item of attention) item.fingerprint = fingerprintOf(item);
  const visible = attention.filter((i) => !dismissed.has(i.fingerprint!));

  // Severity ordering: error → warn → info
  const sevRank: Record<Sev, number> = { error: 0, warn: 1, info: 2 };
  visible.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);

  // Activity feed — recent config changes, user actions, and notable events
  const activity = await buildActivity();

  res.json({ attention: visible, dismissedCount: attention.length - visible.length, capacity, activity });
});

/**
 * POST /api/operations/insights/dismiss — hide one item for a while.
 *
 * Time-boxed on purpose. "Handled" and "not now" look the same to the code, and an
 * item that is genuinely resolved stops being generated anyway — so a dismissal that
 * never lapsed would only ever hide things that are still true.
 */
router.post('/insights/dismiss', requireWrite, async (req: Request, res: Response) => {
  const { fingerprint, category, title, hours } = req.body as
    { fingerprint?: string; category?: string; title?: string; hours?: number };
  if (!fingerprint) return res.status(400).json({ error: 'fingerprint is required' });

  const h = Math.min(720, Math.max(1, Number(hours) || 24));
  await query(
    `INSERT INTO insight_dismissals (fingerprint, category, title, dismissed_by, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval)
     ON CONFLICT (fingerprint) DO UPDATE SET
       expires_at = EXCLUDED.expires_at, dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by`,
    [fingerprint.slice(0, 160), category ?? null, title ?? null,
     (req as unknown as { user?: { username?: string } }).user?.username ?? null, String(h)]
  );
  res.status(201).json({ fingerprint, hours: h });
});

/** GET /api/operations/insights/dismissed — what is currently hidden, and until when. */
router.get('/insights/dismissed', async (_req: Request, res: Response) => {
  await query(`DELETE FROM insight_dismissals WHERE expires_at < NOW()`).catch(() => []);
  res.json(await query(`SELECT * FROM insight_dismissals ORDER BY expires_at ASC`));
});

/** DELETE — bring an item back before its dismissal lapses. */
router.delete('/insights/dismiss/:fingerprint', requireWrite, async (req: Request, res: Response) => {
  await query(`DELETE FROM insight_dismissals WHERE fingerprint = $1`, [req.params.fingerprint]);
  res.status(204).end();
});

// ─── Baseline anomaly detection ────────────────────────────────────────────────
// Mist-style "this is unusual for you" insights: compare the last 30 minutes
// against the same-hour-of-day baseline over the past 14 days (per device) and
// flag deviations of ≥ 2.5 standard deviations. Conservative thresholds — an
// insight should mean something.

async function influxGroupValues(flux: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const api = getQueryApi();
    await new Promise<void>((resolve, reject) => {
      api.queryRows(flux, {
        next(row, tableMeta) {
          const o = tableMeta.toObject(row) as Record<string, unknown>;
          const id = String(o['device_id'] || '');
          if (id) out.set(id, Number(o['_value']) || 0);
        },
        error: reject,
        complete: resolve,
      });
    });
  } catch { /* influx unavailable */ }
  return out;
}

async function detectAnomalies(): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const hour = new Date().getUTCHours();
  const nameById = new Map<string, { id: number; name: string }>();
  const devices = await query<{ id: number; name: string }>(`SELECT id, name FROM devices`);
  for (const d of devices) nameById.set(String(d.id), d);

  const metric = async (measurement: string, field: string) => {
    const base = `
      from(bucket: "${bucket}")
        |> range(start: -14d)
        |> filter(fn: (r) => r["_measurement"] == "${measurement}")
        |> filter(fn: (r) => r["_field"] == "${field}")
        |> hourSelection(start: ${hour}, stop: ${hour})
        |> group(columns: ["device_id"])`;
    const [cur, mean, std] = await Promise.all([
      influxGroupValues(`
        from(bucket: "${bucket}")
          |> range(start: -30m)
          |> filter(fn: (r) => r["_measurement"] == "${measurement}")
          |> filter(fn: (r) => r["_field"] == "${field}")
          |> group(columns: ["device_id"])
          |> mean()`),
      influxGroupValues(`${base}\n  |> mean()`),
      influxGroupValues(`${base}\n  |> stddev()`),
    ]);
    return { cur, mean, std };
  };

  // Client-count deviations (device dropped clients / unusual surge)
  const cc = await metric('client_counts', 'total_clients');
  for (const [id, current] of cc.cur) {
    const m = cc.mean.get(id), s = cc.std.get(id);
    const dev = nameById.get(id);
    if (!dev || m === undefined || s === undefined || s < 1) continue;
    const z = (current - m) / s;
    if (Math.abs(z) >= 2.5 && Math.abs(current - m) >= 5) {
      items.push({
        sev: 'warn', category: 'anomaly',
        title: `Client count on ${dev.name} is unusually ${z < 0 ? 'low' : 'high'}`,
        body: `${Math.round(current)} clients now vs ~${Math.round(m)} typical for this hour (14-day baseline).`,
        action: 'View device', path: `/devices/${dev.id}`,
      });
    }
  }

  // Sustained CPU deviations (only flag high — idle is not a problem)
  const cpu = await metric('device_resources', 'cpu_load');
  for (const [id, current] of cpu.cur) {
    const m = cpu.mean.get(id), s = cpu.std.get(id);
    const dev = nameById.get(id);
    if (!dev || m === undefined || s === undefined || s < 1) continue;
    const z = (current - m) / s;
    if (z >= 2.5 && current >= 50) {
      items.push({
        sev: 'warn', category: 'anomaly',
        title: `CPU on ${dev.name} is far above its baseline`,
        body: `${Math.round(current)}% for the last 30m vs ~${Math.round(m)}% typical for this hour.`,
        action: 'View device', path: `/devices/${dev.id}`,
      });
    }
  }

  // Error-log bursts (Postgres, hourly rate vs 7-day average)
  const bursts = await query<{ device_id: number; name: string; cur: string; avg_hourly: string }>(`
    WITH cur AS (
      SELECT device_id, COUNT(*) AS n FROM events
      WHERE severity = 'error' AND event_time > NOW() - INTERVAL '1 hour'
      GROUP BY device_id
    ), hist AS (
      SELECT device_id, COUNT(*) / 168.0 AS avg_hourly FROM events
      WHERE severity = 'error' AND event_time > NOW() - INTERVAL '7 days'
      GROUP BY device_id
    )
    SELECT c.device_id, d.name, c.n AS cur, COALESCE(h.avg_hourly, 0) AS avg_hourly
    FROM cur c JOIN devices d ON d.id = c.device_id
    LEFT JOIN hist h ON h.device_id = c.device_id
    WHERE c.n >= 10 AND c.n > 5 * GREATEST(COALESCE(h.avg_hourly, 0), 0.5)`);
  for (const b of bursts) {
    items.push({
      sev: 'warn', category: 'anomaly',
      title: `Error-log burst on ${b.name}`,
      body: `${b.cur} error entries in the last hour (typically ~${Number(b.avg_hourly).toFixed(1)}/h).`,
      action: 'Open Events', path: '/events',
    });
  }

  return items;
}

// Recent activity merged from config snapshots, audit log, and events.
async function buildActivity() {
  const [configs, audits, events] = await Promise.all([
    query<{ at: string; name: string; summary: string | null }>(`
      SELECT dc.collected_at AS at, d.name, dc.change_summary AS summary
      FROM device_configs dc JOIN devices d ON d.id = dc.device_id
      WHERE dc.change_summary IS NOT NULL AND dc.change_summary != ''
      ORDER BY dc.collected_at DESC LIMIT 8`),
    query<{ at: string; username: string | null; method: string; summary: string | null }>(`
      SELECT created_at AS at, username, method, summary
      FROM audit_log
      WHERE method <> 'GET' AND status_code < 400
        AND path NOT ILIKE '%login%' AND path NOT ILIKE '%logout%' AND path NOT ILIKE '%/auth/%'
      ORDER BY created_at DESC LIMIT 8`),
    query<{ at: string; severity: string; message: string; name: string | null }>(`
      SELECT e.event_time AS at, e.severity, e.message, d.name
      FROM events e LEFT JOIN devices d ON d.id = e.device_id
      WHERE e.severity IN ('error', 'warning')
      ORDER BY e.event_time DESC LIMIT 8`),
  ]);

  type Act = { at: string; kind: 'config' | 'audit' | 'alert'; sev?: string; title: string; sub: string };
  const items: Act[] = [];
  for (const c of configs) items.push({ at: c.at, kind: 'config', title: c.summary || 'Configuration changed', sub: c.name });
  for (const a of audits) items.push({ at: a.at, kind: 'audit', title: a.summary || `${a.method} request`, sub: a.username || 'system' });
  for (const e of events) items.push({ at: e.at, kind: 'alert', sev: e.severity, title: e.message, sub: e.name || 'fleet' });
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return items.slice(0, 14);
}

// POST /api/operations/backup-all — back up every online device (parallel, best-effort)
router.post('/backup-all', requireWrite, async (_req: Request, res: Response) => {
  const devices = await query<DeviceRow>(`SELECT * FROM devices WHERE status = 'online'`);
  const settled = await Promise.allSettled(devices.map(d => {
    const dev: BackupDevice = {
      id: d.id, name: d.name, ip_address: d.ip_address,
      ssh_port: d.ssh_port ?? 22, ssh_username: d.ssh_username,
      ssh_password_encrypted: d.ssh_password_encrypted,
      api_username: d.api_username, api_password_encrypted: d.api_password_encrypted,
    };
    return backupService.createBackup(dev, 'Operations: backup all');
  }));
  res.json({
    total: devices.length,
    results: settled.map((s, i) => ({
      name: devices[i].name,
      ok: s.status === 'fulfilled',
      error: s.status === 'rejected' ? (s.reason as Error)?.message : undefined,
    })),
  });
});

// POST /api/operations/sync-all — pull latest config/state from every online device
router.post('/sync-all', requireWrite, async (_req: Request, res: Response) => {
  const devices = await query<DeviceRow>(`SELECT * FROM devices WHERE status = 'online'`);
  const settled = await Promise.allSettled(devices.map(async (d) => {
    const c = new DeviceCollector(d);
    try { await c.connect(); await c.collectAll(); }
    finally { c.disconnect(); }
  }));
  res.json({
    total: devices.length,
    results: settled.map((s, i) => ({
      name: devices[i].name,
      ok: s.status === 'fulfilled',
      error: s.status === 'rejected' ? (s.reason as Error)?.message : undefined,
    })),
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function freqToChannel(freq: number): number | null {
  if (freq >= 2400 && freq < 2500) return freq === 2484 ? 14 : Math.round((freq - 2407) / 5);
  if (freq >= 4900 && freq < 5925) return Math.round((freq - 5000) / 5);
  if (freq >= 5925 && freq <= 7125) return Math.round((freq - 5950) / 5);
  return null;
}

export default router;
