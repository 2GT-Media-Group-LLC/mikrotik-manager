import type { PoolClient } from 'pg';
import { query } from '../config/database';
import { parseProxyLog, type ProxyConnection } from '../utils/proxyLog';
import { logSafe } from '../utils/logSafe';
import { usageUpsertCtes, SOURCES_READY_KEY } from './ProxyUsageService';

export interface ProxyLogInput {
  logId: string;
  topics: string | null | undefined;
  message: string | null | undefined;
}

const COLS = 17;
const BATCH = 200;

type Runner = (text: string, params: unknown[]) => Promise<unknown>;

async function insertParsed(
  run: Runner,
  deviceId: number,
  parsed: { logId: string; c: ProxyConnection }[],
): Promise<void> {
  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk = parsed.slice(i, i + BATCH);
    const values = chunk
      .map((_, r) => `(${Array.from({ length: COLS }, (_, c) => `$${r * COLS + c + 1}`).join(',')})`)
      .join(',');
    const params = chunk.flatMap(({ logId, c }) => [
      deviceId, logId, c.eventTime.toISOString(), c.source, c.proxyType, c.proxyPort,
      c.clientIp, c.clientPort, c.serverIp, c.serverPort, c.authUser, c.hostname,
      c.method, c.bytesSent, c.bytesReceived, c.errorCode, c.status,
    ]);
    // One statement: the rows actually inserted (a re-collected line is dropped by the
    // conflict) also feed the hourly rollup, so the two cannot disagree.
    await run(
      `WITH inserted AS (
         INSERT INTO proxy_connections
           (device_id, log_id, event_time, source, proxy_type, proxy_port, client_ip, client_port,
            server_ip, server_port, auth_user, hostname, method, bytes_sent, bytes_received,
            error_code, status)
         VALUES ${values}
         ON CONFLICT (device_id, log_id) DO NOTHING
         RETURNING device_id, event_time, source, proxy_port, client_ip, auth_user, hostname,
                   server_ip, bytes_sent, bytes_received, status
       )${usageUpsertCtes('inserted')}
       SELECT 1`,
      params,
    );
  }
}

/** Parse and store any proxy access-log lines among freshly collected device log lines. */
export async function storeProxyConnections(deviceId: number, lines: ProxyLogInput[]): Promise<number> {
  const parsed: { logId: string; c: ProxyConnection }[] = [];
  for (const l of lines) {
    const c = parseProxyLog(l.topics, l.message);
    if (c) parsed.push({ logId: l.logId, c });
  }
  if (!parsed.length) return 0;
  await insertParsed((t, p) => query(t, p), deviceId, parsed);
  // The instance list is a convenience for the selector: a failure here must not lose
  // or fail the log ingest that already succeeded.
  await recordProxySources((t, p) => query(t, p), deviceId, parsed).catch((err) =>
    console.error('[proxy] could not record proxy instances: %s', logSafe((err as Error).message)));
  return parsed.length;
}

/** Distinct (source, type, port) instances in a batch, each with its latest event time. */
export function collectProxySources(
  parsed: { c: ProxyConnection }[],
): { source: string; proxyType: string; proxyPort: number; lastSeen: Date }[] {
  const seen = new Map<string, { source: string; proxyType: string; proxyPort: number; lastSeen: Date }>();
  for (const { c } of parsed) {
    const proxyPort = c.proxyPort ?? 0;
    const key = `${c.source}\u0000${c.proxyType}\u0000${proxyPort}`;
    const cur = seen.get(key);
    if (!cur) seen.set(key, { source: c.source, proxyType: c.proxyType, proxyPort, lastSeen: c.eventTime });
    else if (c.eventTime > cur.lastSeen) cur.lastSeen = c.eventTime;
  }
  return [...seen.values()];
}

async function recordProxySources(
  run: Runner,
  deviceId: number,
  parsed: { logId: string; c: ProxyConnection }[],
): Promise<void> {
  const sources = collectProxySources(parsed);
  const values = sources.map((_, i) => `($1,$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4},$${i * 4 + 5})`).join(',');
  const params: unknown[] = [deviceId, ...sources.flatMap((s) => [s.source, s.proxyType, s.proxyPort, s.lastSeen.toISOString()])];
  await run(
    `INSERT INTO proxy_sources (device_id, source, proxy_type, proxy_port, last_seen)
     VALUES ${values}
     ON CONFLICT (device_id, source, proxy_type, proxy_port)
     DO UPDATE SET last_seen = GREATEST(proxy_sources.last_seen, EXCLUDED.last_seen)`,
    params,
  );
}

/**
 * Build proxy_sources from proxy_connections once, then mark it ready (until then
 * /sources reads proxy_connections). Runs in the background while new batches keep
 * arriving, so it merges instead of assuming an empty table: the later of the two
 * last_seen values wins. One aggregate scan, then nothing on later starts.
 */
export async function backfillProxySources(client: PoolClient): Promise<number> {
  const done = await client.query('SELECT 1 FROM app_settings WHERE key = $1', [SOURCES_READY_KEY]);
  if (done.rowCount) return 0;
  const res = await client.query(
    `INSERT INTO proxy_sources (device_id, source, proxy_type, proxy_port, last_seen)
     SELECT device_id, source, proxy_type, COALESCE(proxy_port, 0), MAX(event_time)
       FROM proxy_connections
      GROUP BY device_id, source, proxy_type, COALESCE(proxy_port, 0)
     ON CONFLICT (device_id, source, proxy_type, proxy_port)
     DO UPDATE SET last_seen = GREATEST(proxy_sources.last_seen, EXCLUDED.last_seen)`,
  );
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [SOURCES_READY_KEY, JSON.stringify(true)],
  );
  return res.rowCount ?? 0;
}

const BACKFILL_FLAG = 'proxy_backfill_done';

/**
 * Populate proxy_connections from existing events, once. Completion is recorded in
 * app_settings so installs with no proxy containers do not rescan the (possibly
 * very large) events table on every boot. A failed run leaves the flag unset and
 * is retried next boot.
 */
export async function backfillProxyConnections(client: PoolClient): Promise<number> {
  const done = await client.query('SELECT 1 FROM app_settings WHERE key = $1', [BACKFILL_FLAG]);
  if (done.rowCount) return 0;

  const total = await runBackfill(client);
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [BACKFILL_FLAG, JSON.stringify(true)],
  );
  return total;
}

async function runBackfill(client: PoolClient): Promise<number> {
  const existing = await client.query('SELECT 1 FROM proxy_connections LIMIT 1');
  if (existing.rowCount) return 0;

  const rows = await client.query<{ device_id: number; log_id: string; topic: string; message: string }>(
    `SELECT device_id, log_id, topic, message FROM events
      WHERE device_id IS NOT NULL AND log_id IS NOT NULL
        AND topic LIKE '%container%' AND message LIKE '%"client"%'`,
  );
  const byDevice = new Map<number, { logId: string; c: ProxyConnection }[]>();
  let total = 0;
  for (const r of rows.rows) {
    const c = parseProxyLog(r.topic, r.message);
    if (!c) continue;
    if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, []);
    byDevice.get(r.device_id)!.push({ logId: r.log_id, c });
    total++;
  }
  for (const [deviceId, parsed] of byDevice) {
    await insertParsed((t, p) => client.query(t, p), deviceId, parsed);
  }
  return total;
}
