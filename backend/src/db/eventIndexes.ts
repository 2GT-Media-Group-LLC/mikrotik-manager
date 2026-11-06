import type { PoolClient } from 'pg';
import { pool } from '../config/database';
import { firewallPacketLogSql } from '../utils/firewallEventSql';
import { CLOCK_CHANGE_SQL } from '../utils/clockLogLines';

type EventIndex = { name: string; sql: string };

const NOT_FIREWALL = `NOT ${firewallPacketLogSql()}`;
const NOT_CLOCK_CHANGE = `NOT ${CLOCK_CHANGE_SQL}`;

/**
 * Partial indexes for the high-volume predicates on `events`.
 *
 * Firewall packet logs and NTP/cloud clock corrections are classified by
 * regular expressions over topic/message. On a busy install those are 97%+ of
 * the table, so filtering them per row made the Events page's totals and topic
 * badges scan millions of rows (seconds per request) even though both views
 * hide them. Each index keeps only the rows its view can show, in the order it
 * reads them, so a page is a short index walk and the capped total is an
 * index-only scan. Predicates are interpolated from the same helpers the routes
 * use so the planner can prove they match.
 *
 * Built with CONCURRENTLY after the server is listening (see
 * `buildEventIndexes`): the first scan on a large install can take minutes and
 * must not hold up startup, the health check, or writes.
 */
const EVENT_INDEXES: EventIndex[] = [
  {
    name: 'idx_events_nonfw_time',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_nonfw_time
      ON events(event_time DESC, id DESC)
      WHERE ${NOT_FIREWALL} AND ${NOT_CLOCK_CHANGE}`,
  },
  {
    // Same non-firewall rows without the clock restriction: the topic badges
    // show clock tokens too, and "show clock changes" reads this ordering. Its
    // INCLUDE lets the topic aggregate run as an index-only scan.
    name: 'idx_events_nonfw_all_time',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_nonfw_all_time
      ON events(event_time DESC, id DESC) INCLUDE (topic)
      WHERE ${NOT_FIREWALL}`,
  },
  {
    name: 'idx_events_fw_time',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_fw_time
      ON events(event_time DESC, id DESC)
      WHERE ${firewallPacketLogSql()}`,
  },
  {
    // The header's 24-hour critical badge. Small (errors only) and index-only
    // for the count, which otherwise re-tests the regexes on every recent error.
    name: 'idx_events_nonfw_critical_time',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_nonfw_critical_time
      ON events(event_time DESC, id DESC)
      WHERE severity IN ('error','critical')
        AND ${NOT_FIREWALL} AND ${NOT_CLOCK_CHANGE}`,
  },
];

// One builder at a time per database. Poll/poller replicas do not run this,
// but a rolling deploy can briefly have two API containers; without the lock
// they would both scan the same table and race on the same index names.
const BUILD_LOCK_SQL =
  `SELECT pg_try_advisory_lock(hashtext('mikrotik-manager:event-indexes')::bigint) AS locked`;
const BUILD_UNLOCK_SQL =
  `SELECT pg_advisory_unlock(hashtext('mikrotik-manager:event-indexes')::bigint)`;

/**
 * Build (or repair) the Events partial indexes without blocking startup.
 *
 * Call after `httpServer.listen` and do not await it. Until the build finishes
 * the Events pages simply keep their previous, slower query plans; writes and
 * health checks are never blocked because every statement is CONCURRENTLY.
 */
export async function buildEventIndexes(): Promise<void> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(BUILD_LOCK_SQL);
    if (!lock.rows[0]?.locked) {
      console.log('[events] another instance is building the event indexes; skipping');
      return;
    }

    console.log(
      '[events] building event indexes (first run on a large log table may take a while)...'
    );

    for (const index of EVENT_INDEXES) {
      try {
        await buildOne(client, index);
      } catch (err) {
        // A failed concurrent build can leave an INVALID index behind. The next
        // start drops it (see buildOne) and tries again; the other indexes still
        // get built now.
        console.error(`[events] could not build ${index.name}:`, err);
      }
    }

    console.log('[events] event indexes ready');
  } finally {
    // The lock is session-scoped, so it must be released on the client that
    // took it. If this fails the connection close releases it anyway.
    await client.query(BUILD_UNLOCK_SQL).catch(() => {});
    client.release();
  }
}

async function buildOne(client: PoolClient, index: EventIndex): Promise<void> {
  const existing = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid
     FROM pg_index i
     WHERE i.indexrelid = to_regclass($1)`,
    [index.name]
  );

  if (existing.rows[0]?.valid) {
    console.log(`[events] ${index.name} already present`);
    return;
  }

  if (existing.rows[0]) {
    // An interrupted CREATE INDEX CONCURRENTLY leaves the index in place but
    // invalid, and IF NOT EXISTS would then skip it forever. Drop and rebuild.
    console.warn(
      `[events] dropping invalid index ${index.name} left by an interrupted build`
    );
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
  }

  console.log(`[events] building ${index.name}...`);
  await client.query(index.sql);
  console.log(`[events] ${index.name} ready`);
}
