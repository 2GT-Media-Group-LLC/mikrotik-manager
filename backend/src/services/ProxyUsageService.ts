import type { PoolClient } from 'pg';
import { pool, query } from '../config/database';
import { GROUPS, type ProxyBy, type ProxyGroup } from '../utils/proxyQuery';

/**
 * Hourly rollup of proxy_connections for the dashboard rankings.
 *
 * Each row is one (hour, device, source, port, key, peer) pair per tab, so a ranking
 * reads thousands of small rows instead of every connection of the window, and the
 * distinct-peer count stays exact (it is a COUNT(DISTINCT peer) over the pair rows).
 * The tab definitions come from proxyQuery's GROUPS, so the rollup and the raw query
 * cannot drift apart.
 *
 * Writes: every batch of new connections updates the rollup in the same statement
 * (a data-modifying CTE over the rows actually inserted), so a re-collected log line
 * that proxy_connections drops is not counted twice. rebuildProxyUsage recomputes a
 * range from the raw rows: it backfills on upgrade and repairs drift once a day.
 */

/** One value per tab, stored in proxy_usage_hourly.kind. */
export const USAGE_KIND: Record<ProxyBy, number> = { client: 1, user: 2, destination: 3, denied: 4 };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const READY_KEY = 'proxy_usage_ready';
const ENABLED_KEY = 'proxy_usage_rollup';

/** Hour boundary in UTC, independent of the session time zone. */
const hourBucket = (col: string) => `(date_trunc('hour', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

const COLUMNS = '(kind, bucket, device_id, source, proxy_port, key, peer, requests, bytes_in, bytes_out, last_seen)';

// Additive, so a batch landing on an hour that already has rows adds to them.
const ON_CONFLICT = `ON CONFLICT (kind, bucket, device_id, source, proxy_port, key, peer) DO UPDATE SET
  requests = proxy_usage_hourly.requests + EXCLUDED.requests,
  bytes_in = proxy_usage_hourly.bytes_in + EXCLUDED.bytes_in,
  bytes_out = proxy_usage_hourly.bytes_out + EXCLUDED.bytes_out,
  last_seen = GREATEST(proxy_usage_hourly.last_seen, EXCLUDED.last_seen)`;

/**
 * The per-tab aggregation of `from` into rollup rows. A peer that is NULL is stored as
 * '' and ignored when peers are counted, as COUNT(DISTINCT) ignored NULL. Rows are
 * ordered so concurrent writers take row locks in the same order.
 */
export function aggregateSql(by: ProxyBy, from: string, extraWhere = ''): string {
  const g: ProxyGroup = GROUPS[by];
  return `SELECT ${USAGE_KIND[by]}::smallint AS kind, ${hourBucket('event_time')} AS bucket, device_id, source,
            COALESCE(proxy_port, 0) AS proxy_port, (${g.key})::varchar AS key,
            COALESCE((${g.distinct})::text, '') AS peer,
            COUNT(*) AS requests, COALESCE(SUM(bytes_received), 0) AS bytes_in,
            COALESCE(SUM(bytes_sent), 0) AS bytes_out, MAX(event_time) AS last_seen
       FROM ${from}
      WHERE ${g.where}${extraWhere}
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      ORDER BY 2, 3, 4, 5, 6, 7`;
}

/** The ", name AS (INSERT ...)" CTEs that fold the rows of `from` into the rollup. */
export function usageUpsertCtes(from: string): string {
  return (Object.keys(USAGE_KIND) as ProxyBy[])
    .map((by) => `, rollup_${by} AS (INSERT INTO proxy_usage_hourly ${COLUMNS}\n${aggregateSql(by, from)}\n${ON_CONFLICT})`)
    .join('\n');
}

const floorHour = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/**
 * Replace the rollup for the hour-aligned range [from, to) with what proxy_connections
 * holds. One REPEATABLE READ transaction, so the delete and the rebuild see the same
 * data; a batch committed meanwhile either fails the rebuild (retried next time) or is
 * invisible to both and added by its own upsert.
 */
export async function rebuildProxyUsage(client: PoolClient, from: Date, to: Date): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const range = [from.toISOString(), to.toISOString()];
    await client.query('DELETE FROM proxy_usage_hourly WHERE bucket >= $1 AND bucket < $2', range);
    for (const by of Object.keys(USAGE_KIND) as ProxyBy[]) {
      await client.query(
        `INSERT INTO proxy_usage_hourly ${COLUMNS}\n${aggregateSql(by, 'proxy_connections', ' AND event_time >= $1 AND event_time < $2')}\n${ON_CONFLICT}`,
        range,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Build the rollup from stored connections once, a day at a time, then mark it ready.
 * Until then the rankings read proxy_connections. A failure leaves it unmarked, so
 * the next boot tries again.
 */
export async function backfillProxyUsage(client: PoolClient): Promise<number> {
  const done = await client.query('SELECT 1 FROM app_settings WHERE key = $1', [READY_KEY]);
  if (done.rowCount) return 0;

  const lo = (await client.query<{ lo: Date | null }>('SELECT MIN(event_time) AS lo FROM proxy_connections')).rows[0]?.lo;
  let chunks = 0;
  if (lo) {
    // Through the end of the current hour: nothing else writes while migrations run.
    const end = new Date(floorHour(new Date()).getTime() + HOUR_MS);
    for (let a = floorHour(new Date(lo)); a < end; a = new Date(a.getTime() + DAY_MS)) {
      await rebuildProxyUsage(client, a, new Date(Math.min(a.getTime() + DAY_MS, end.getTime())));
      chunks++;
    }
  }
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [READY_KEY, JSON.stringify(true)],
  );
  return chunks;
}

const RECONCILE_CHUNK_HOURS = 6;
const RECONCILE_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Recompute the last `hours` complete hours from raw, repairing any drift. Done in
 * 6-hour chunks, each its own transaction and retried: a rebuild that collides with
 * a late log batch aborts (leaving the rollup untouched), and a small chunk gives it
 * far fewer chances to collide than the whole window would.
 */
export async function reconcileProxyUsage(hours = 48): Promise<void> {
  if (!(await readSettings()).ready) return;
  const end = floorHour(new Date());
  const start = new Date(end.getTime() - hours * HOUR_MS);
  const step = RECONCILE_CHUNK_HOURS * HOUR_MS;
  const failed: string[] = [];
  const client = await pool.connect();
  try {
    for (let a = start; a < end; a = new Date(a.getTime() + step)) {
      const b = new Date(Math.min(a.getTime() + step, end.getTime()));
      for (let attempt = 1; ; attempt++) {
        try {
          await rebuildProxyUsage(client, a, b);
          break;
        } catch {
          if (attempt >= RECONCILE_ATTEMPTS) { failed.push(a.toISOString()); break; }
          await sleep(200 * attempt);
        }
      }
    }
  } finally {
    client.release();
  }
  if (failed.length) throw new Error(`proxy usage reconcile gave up on ${failed.length} chunk(s) starting ${failed.join(', ')}`);
}

let settingsCache: { at: number; ready: boolean; enabled: boolean } | null = null;
const SETTINGS_TTL_MS = 30_000;

async function readSettings(): Promise<{ ready: boolean; enabled: boolean }> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache;
  const rows = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key IN ($1, $2)', [READY_KEY, ENABLED_KEY],
  );
  const ready = rows.some((r) => r.key === READY_KEY);
  // On unless explicitly switched off, so it can be disabled without a deploy.
  const enabled = !rows.some((r) => r.key === ENABLED_KEY && (r.value === false || r.value === 'false'));
  settingsCache = { at: Date.now(), ready, enabled };
  return settingsCache;
}

/** True when the rankings may read the rollup (built, and not switched off). */
export async function useProxyUsageRollup(): Promise<boolean> {
  const s = await readSettings();
  return s.ready && s.enabled;
}

/** Test hook: forget the cached settings. */
export function resetProxyUsageSettingsCache(): void {
  settingsCache = null;
}
