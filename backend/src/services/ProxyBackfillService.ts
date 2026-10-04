import { pool } from '../config/database';
import { logSafe } from '../utils/logSafe';
import { backfillProxySources } from './ProxyLogService';
import { backfillProxyUsage } from './ProxyUsageService';

/**
 * Runs the proxy backfills (the instance list and the hourly rollup) after startup,
 * not inside the migrations: on a large install they scan millions of rows, and the
 * health check gives the backend only about 105 s before nginx gives up waiting.
 * Until each one finishes its readers fall back to proxy_connections, so nothing
 * depends on them having completed.
 */

// Arbitrary but fixed: keeps two instances (a rolling deploy) from backfilling at once.
const BACKFILL_LOCK_KEY = 702_104_001;

let running = false;

/**
 * One pass over both backfills on a client of its own. Resolves true when there is
 * nothing left to do (done now, or another instance holds the lock), false when this
 * process is already running one; rejects if a step fails.
 */
export async function runProxyBackfills(): Promise<boolean> {
  if (running) return false;
  running = true;
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [BACKFILL_LOCK_KEY]);
    if (!got.rows[0]?.ok) return true;
    try {
      const sources = await backfillProxySources(client);
      if (sources > 0) console.log(`[proxy] recorded ${sources} proxy instance(s) from existing connections`);
      const days = await backfillProxyUsage(client);
      if (days > 0) console.log(`[proxy] built the usage rollup from ${days} chunk(s) of connections`);
      return true;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
    running = false;
  }
}

/** Delays before each attempt; a restart begins again from the first. */
export const BACKFILL_RETRY_DELAYS_MS = [0, 60_000, 300_000, 900_000, 3_600_000];

/** Start the backfills without waiting for them; failures are logged and retried later. */
export function startProxyBackfillsInBackground(delaysMs: number[] = BACKFILL_RETRY_DELAYS_MS): Promise<void> {
  return (async () => {
    for (const delay of delaysMs) {
      if (delay > 0) {
        // unref'd so a pending retry never keeps a shutdown waiting.
        await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
      }
      try {
        if (await runProxyBackfills()) return;
      } catch (err) {
        console.error('[proxy] backfill failed, will retry: %s', logSafe((err as Error).message));
      }
    }
    console.error('[proxy] backfill did not finish; it will be tried again on the next start');
  })();
}
