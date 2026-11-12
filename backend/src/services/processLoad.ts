/**
 * How busy this process is, for poller health (#442): the longest the event
 * loop was blocked and the most queries kept waiting for a database
 * connection, since the last reading. A poll whose device answers in a second
 * but takes fifteen is waiting on one of these, and they say which.
 */
import { monitorEventLoopDelay } from 'perf_hooks';
import { pool } from '../config/database';

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let maxDbWaiting = 0;
setInterval(() => { maxDbWaiting = Math.max(maxDbWaiting, pool.waitingCount); }, 1_000).unref();

/** A stall worth a log line: long enough to push a poll towards its time limit. */
const LOOP_STALL_MS = 2_000;
const DB_QUEUE_WARN = 10;

export interface LoadReading {
  /** Longest event-loop block in the window. */
  loop_max_ms: number;
  loop_p99_ms: number;
  /** Most queries waiting for a connection at once, sampled each second. */
  db_waiting_max: number;
  db_connections: number;
}

/** The readings since the last call, which starts a new window. */
export function readLoad(): LoadReading {
  const r: LoadReading = {
    loop_max_ms: Math.round(loop.max / 1e6),
    loop_p99_ms: Math.round(loop.percentile(99) / 1e6),
    db_waiting_max: Math.max(maxDbWaiting, pool.waitingCount),
    db_connections: pool.totalCount,
  };
  loop.reset();
  maxDbWaiting = 0;
  if (r.loop_max_ms >= LOOP_STALL_MS || r.db_waiting_max >= DB_QUEUE_WARN) {
    console.warn(`[Load] Event loop blocked up to ${r.loop_max_ms} ms; up to ${r.db_waiting_max} queries waited for one of ${r.db_connections} database connections`);
  }
  return r;
}
