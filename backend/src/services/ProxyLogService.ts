import type { PoolClient } from 'pg';
import { query } from '../config/database';
import { parseProxyLog, type ProxyConnection } from '../utils/proxyLog';

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
    await run(
      `INSERT INTO proxy_connections
         (device_id, log_id, event_time, source, proxy_type, proxy_port, client_ip, client_port,
          server_ip, server_port, auth_user, hostname, method, bytes_sent, bytes_received,
          error_code, status)
       VALUES ${values}
       ON CONFLICT (device_id, log_id) DO NOTHING`,
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
  return parsed.length;
}

/** Populate proxy_connections from existing events, once (only while the table is empty). */
export async function backfillProxyConnections(client: PoolClient): Promise<number> {
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
