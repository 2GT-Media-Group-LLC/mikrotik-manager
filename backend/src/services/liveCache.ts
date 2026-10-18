/**
 * Fleet pages without contacting every device on every load (#302).
 *
 * Some pages show something per device that only the device can tell us
 * (DHCP servers, traffic-flow settings, a security checklist). They used to
 * open a connection to every device at once, on load and on a timer: on a
 * large fleet, hundreds of TLS handshakes per page view.
 *
 * Now each page asks for a "kind" of data for a set of devices. What has been
 * fetched before is returned straight away with when it was fetched; anything
 * missing or older than the page's limit is refreshed in the background, a few
 * devices at a time. A small fleet barely notices: the request waits a moment
 * for the refreshes it started, so the first view is complete. A large fleet
 * gets the cached view at once and the rest fills in as the page polls.
 */
import { query } from '../config/database';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { FLEET_ACTION_CONCURRENCY } from '../utils/concurrency';
import { logSafe } from '../utils/logSafe';

export interface LiveEntry<T> {
  data: T | null;
  /** When this was read from the device, or null if it never has been. */
  fetchedAt: string | null;
  error: string | null;
  /** A refresh for this device is queued or running. */
  refreshing: boolean;
}

type Fetcher<T> = (c: DeviceCollector, device: DeviceRow) => Promise<T>;

interface Job { kind: string; device: DeviceRow; fetch: Fetcher<unknown>; done: Array<() => void> }

const inFlight = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

const key = (kind: string, id: number) => `${kind}:${id}`;

function pump(): void {
  while (running < FLEET_ACTION_CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    void run(job).finally(() => {
      running--;
      inFlight.delete(key(job.kind, job.device.id));
      job.done.forEach((f) => f());
      pump();
    });
  }
}

async function run(job: Job): Promise<void> {
  const c = new DeviceCollector(job.device);
  try {
    await c.connect();
    const data = await job.fetch(c, job.device);
    await query(
      `INSERT INTO device_live_cache (device_id, kind, data, fetched_at, error) VALUES ($1, $2, $3, NOW(), NULL)
       ON CONFLICT (device_id, kind) DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW(), error = NULL`,
      [job.device.id, job.kind, JSON.stringify(data)]);
  } catch (e) {
    const msg = (e as Error).message;
    // Keep the last good data; note why it couldn't be refreshed.
    await query(
      `INSERT INTO device_live_cache (device_id, kind, data, fetched_at, error) VALUES ($1, $2, NULL, NULL, $3)
       ON CONFLICT (device_id, kind) DO UPDATE SET error = EXCLUDED.error`,
      [job.device.id, job.kind, msg]).catch(() => {});
    console.warn(`[live-cache] ${job.kind} for ${logSafe(job.device.name)}: ${logSafe(msg)}`);
  } finally {
    c.disconnect();
  }
}

/** Queue a refresh unless one is already queued or running; resolves when it's done. */
function refresh<T>(kind: string, device: DeviceRow, fetch: Fetcher<T>): Promise<void> {
  return new Promise((resolve) => {
    const existing = inFlight.get(key(kind, device.id));
    if (existing) { existing.done.push(resolve); return; }
    const job: Job = { kind, device, fetch: fetch as Fetcher<unknown>, done: [resolve] };
    inFlight.set(key(kind, device.id), job);
    queue.push(job);
    pump();
  });
}

/**
 * `kind` data for each device: cached where fresh enough, refreshed in the
 * background where not. `refresh: true` refreshes every device (a page's
 * Refresh button), still a few at a time. Waits up to `waitMs` for the
 * refreshes it started before answering.
 */
export async function liveForDevices<T>(kind: string, devices: DeviceRow[], fetch: Fetcher<T>, opts: {
  maxAgeMs: number; refresh?: boolean; waitMs?: number;
}): Promise<Map<number, LiveEntry<T>>> {
  const ids = devices.map((d) => d.id);
  const rows = ids.length
    ? await query<{ device_id: number; data: T | null; fetched_at: string | null; error: string | null }>(
      `SELECT device_id, data, fetched_at, error FROM device_live_cache WHERE kind = $1 AND device_id = ANY($2::int[])`, [kind, ids])
    : [];
  const byId = new Map(rows.map((r) => [r.device_id, r]));
  const now = Date.now();
  const started: Promise<void>[] = [];
  for (const d of devices) {
    const r = byId.get(d.id);
    const age = r?.fetched_at ? now - new Date(r.fetched_at).getTime() : Infinity;
    if (opts.refresh || age > opts.maxAgeMs) started.push(refresh(kind, d, fetch));
  }
  if (started.length && (opts.waitMs ?? 0) > 0) {
    await Promise.race([Promise.all(started), new Promise((r) => setTimeout(r, opts.waitMs))]);
  }
  // Re-read what the refreshes that finished in time wrote.
  const fresh = started.length && ids.length
    ? new Map((await query<{ device_id: number; data: T | null; fetched_at: string | null; error: string | null }>(
      `SELECT device_id, data, fetched_at, error FROM device_live_cache WHERE kind = $1 AND device_id = ANY($2::int[])`, [kind, ids]))
      .map((r) => [r.device_id, r]))
    : byId;
  const out = new Map<number, LiveEntry<T>>();
  for (const d of devices) {
    const r = fresh.get(d.id);
    out.set(d.id, {
      data: r?.data ?? null, fetchedAt: r?.fetched_at ?? null, error: r?.error ?? null,
      refreshing: inFlight.has(key(kind, d.id)),
    });
  }
  return out;
}

/** For tests and diagnostics: how many refreshes are queued or running. */
export function liveCacheBusy(): number { return inFlight.size; }
