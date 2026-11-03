import { fluxString } from '@influxdata/influxdb-client';
import { getQueryApi, bucket } from '../config/influxdb';
import { trendStart, trendSlots, type TrendPoint } from '../utils/cpuTrend';
import { SwrCache } from '../utils/swrCache';

export interface LatestResources {
  cpu: number;
  memTotal: number;
  memUsed: number;
  /** Time of the newest of the three points (ISO 8601), or null if none carried one. */
  time: string | null;
}

export interface LatestInterfaceCounters {
  rx: number;
  tx: number;
  time: string | null;
}

/** How far back "latest" looks. A device silent for longer has no current value. */
const WINDOW = '-15m';

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function timeOf(o: Record<string, unknown>): string | null {
  const t = o['_time'];
  if (t instanceof Date) return t.toISOString();
  return t ? new Date(String(t)).toISOString() : null;
}

function run(flux: string, onRow: (o: Record<string, unknown>) => void): Promise<void> {
  const api = getQueryApi();
  return new Promise<void>((resolve, reject) => {
    api.queryRows(flux, {
      next(row, tableMeta) { onRow(tableMeta.toObject(row) as Record<string, unknown>); },
      error: reject,
      complete: resolve,
    });
  });
}

/**
 * Latest CPU/memory per device id, from the last 15 minutes. By default an
 * unreadable Influx gives an empty map (the insights feed relies on that); with
 * `{ strict: true }` it throws so the caller can report it.
 */
export async function latestResources(opts: { strict?: boolean } = {}): Promise<Map<string, LatestResources>> {
  const out = new Map<string, LatestResources>();
  const flux = `
    from(bucket: ${fluxString(bucket)})
      |> range(start: ${WINDOW})
      |> filter(fn: (r) => r["_measurement"] == "device_resources")
      |> filter(fn: (r) => r["_field"] == "cpu_load" or r["_field"] == "memory_total" or r["_field"] == "memory_used")
      |> group(columns: ["device_id", "_field"])
      |> last()
  `;
  try {
    await run(flux, (o) => {
      const id = String(o['device_id'] || '');
      const field = String(o['_field'] || '');
      const val = Number(o['_value']) || 0;
      const e = out.get(id) || { cpu: 0, memTotal: 0, memUsed: 0, time: null };
      if (field === 'cpu_load') e.cpu = val;
      else if (field === 'memory_total') e.memTotal = val;
      else if (field === 'memory_used') e.memUsed = val;
      e.time = newer(e.time, timeOf(o));
      out.set(id, e);
    });
  } catch (err) {
    if (opts.strict) throw err;
    /* influx unavailable → empty */
  }
  return out;
}

/**
 * Latest cumulative rx/tx byte counters per device and interface, one query for
 * the whole fleet. Throws if Influx cannot be read (callers decide how to report it).
 */
export async function latestInterfaceCounters(): Promise<Map<string, Map<string, LatestInterfaceCounters>>> {
  const out = new Map<string, Map<string, LatestInterfaceCounters>>();
  const flux = `
    from(bucket: ${fluxString(bucket)})
      |> range(start: ${WINDOW})
      |> filter(fn: (r) => r["_measurement"] == "interface_traffic")
      |> filter(fn: (r) => r["_field"] == "rx_bytes" or r["_field"] == "tx_bytes")
      |> group(columns: ["device_id", "interface", "_field"])
      |> last()
  `;
  await run(flux, (o) => {
    const id = String(o['device_id'] || '');
    const iface = String(o['interface'] || '');
    const field = String(o['_field'] || '');
    if (!id || !iface) return;
    const byIface = out.get(id) ?? new Map<string, LatestInterfaceCounters>();
    const e = byIface.get(iface) ?? { rx: 0, tx: 0, time: null };
    const val = Number(o['_value']) || 0;
    if (field === 'rx_bytes') e.rx = val;
    else if (field === 'tx_bytes') e.tx = val;
    e.time = newer(e.time, timeOf(o));
    byIface.set(iface, e);
    out.set(id, byIface);
  });
  return out;
}

/**
 * The 24h trend changes slowly and the dashboard asks every minute. Overlapping
 * requests share one query, and an expired trend is served while it refreshes
 * in the background, so no dashboard load waits for it (#368).
 */
const trendCache = new SwrCache<Map<string, (number | null)[]>>({ freshMs: 2 * 60_000, staleMs: 30 * 60_000 });

/**
 * Every device's CPU over the last 24 hours as 48 half-hour maxima (#368), in
 * one query for the whole fleet. Grouped by device id only, so a device renamed
 * during the day stays one line. An unreadable Influx gives an empty map.
 */
export async function cpuTrend24h(): Promise<Map<string, (number | null)[]>> {
  return trendCache.get('cpu', async () => {
    const now = Date.now();
    const points: TrendPoint[] = [];
    const flux = `
      from(bucket: ${fluxString(bucket)})
        |> range(start: time(v: ${fluxString(new Date(trendStart(now)).toISOString())}))
        |> filter(fn: (r) => r["_measurement"] == "device_resources" and r["_field"] == "cpu_load")
        |> group(columns: ["device_id"])
        |> aggregateWindow(every: 30m, fn: max, createEmpty: false, timeSrc: "_start")
    `;
    await run(flux, (o) => {
      const t = o['_time'];
      const start = t instanceof Date ? t.getTime() : Date.parse(String(t));
      points.push({ id: String(o['device_id'] || ''), start, value: Number(o['_value']) });
    });
    return trendSlots(points, now);
  }).catch(() => new Map());
}

/** The 7-day low moves slower still. */
const memLowCache = new SwrCache<Map<string, number>>({ freshMs: 15 * 60_000, staleMs: 6 * 60 * 60_000 });

/**
 * The least memory each device used in the last 7 days, in bytes (#368). A
 * device whose memory sits high all week is where its firmware keeps it; one
 * well above its own low is growing. One query for the fleet; an unreadable
 * Influx gives an empty map.
 */
export async function memoryLow7d(): Promise<Map<string, number>> {
  return memLowCache.get('mem', async () => {
    const out = new Map<string, number>();
    const flux = `
      from(bucket: ${fluxString(bucket)})
        |> range(start: -7d)
        |> filter(fn: (r) => r["_measurement"] == "device_resources" and r["_field"] == "memory_used")
        |> group(columns: ["device_id"])
        |> min()
    `;
    await run(flux, (o) => {
      const id = String(o['device_id'] || '');
      const v = Number(o['_value']);
      if (id && Number.isFinite(v)) out.set(id, v);
    });
    return out;
  }).catch(() => new Map());
}
