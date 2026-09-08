/**
 * Deciding which RouterOS log lines are actually new (issue #137).
 *
 * `/log/print` returns the device's whole ring buffer every time — commonly a
 * thousand lines — so almost all of it is already stored. Getting this decision
 * right is the difference between inserting a handful of rows and re-offering
 * the entire buffer once a minute.
 */

import { createHash } from 'crypto';

export interface RawLogLine {
  '.id'?: string;
  time?: string;
  topics?: string;
  message?: string;
  [k: string]: unknown;
}

/** RouterOS log ids are hex strings like "*1A2F"; 0 means "no usable id". */
export function parseRosId(id: string | undefined): number {
  const hex = (id || '').replace(/^\*/, '');
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return 0;
  const n = parseInt(hex, 16);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * The highest log id we have already stored.
 *
 * Taken as the maximum over recent rows rather than "the last row inserted".
 * Those are usually the same, but not always — and when they differ the
 * watermark goes backwards, every later line looks new, and the whole buffer is
 * reprocessed on every poll.
 */
export function highestStoredId(storedIds: (string | null | undefined)[]): number {
  let max = 0;
  for (const id of storedIds) {
    const n = parseRosId(id ?? undefined);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Has the device's log buffer been cleared or the device rebooted?
 *
 * Detected by ids going backwards. When it happens the id watermark is
 * meaningless and timestamps are the only thing left to compare.
 */
export function isLogReset(currentMaxId: number, lastStoredId: number): boolean {
  return lastStoredId > 0 && currentMaxId > 0 && currentMaxId < lastStoredId;
}

/**
 * Which lines should be inserted.
 *
 * `parseTime` is injected so the caller's RouterOS timestamp handling is used
 * without this module needing to know about it.
 */
export function selectNewLogLines(
  logs: RawLogLine[],
  opts: {
    lastStoredId: number;
    latestStoredTime: Date;
    parseTime: (raw: string) => Date;
  }
): RawLogLine[] {
  const ids = logs.map((l) => parseRosId(l['.id'])).filter((n) => n > 0);
  const currentMax = ids.length ? Math.max(...ids) : 0;
  const reset = isLogReset(currentMax, opts.lastStoredId);

  const out: RawLogLine[] = [];
  for (const log of logs) {
    const id = parseRosId(log['.id']);
    if (id > 0 && !reset) {
      if (id <= opts.lastStoredId) continue;
    } else {
      // No usable id, or the buffer reset: fall back to timestamps.
      if (opts.parseTime(log.time || '') <= opts.latestStoredTime) continue;
    }
    out.push(log);
  }
  return out;
}

/**
 * A stable identifier for a log line that RouterOS gave no `.id`.
 *
 * The events table has a unique index on (device_id, log_id) and relies on it
 * to reject lines already stored. PostgreSQL treats NULLs as *distinct* in a
 * unique index, so a NULL log_id conflicts with nothing: a device whose log
 * entries carry no `.id` had no protection at all and re-inserted the same
 * lines on every poll, without bound.
 *
 * Deriving the key from the line's own content restores that protection. The
 * `#` prefix keeps it out of the space of real RouterOS ids, which are `*`
 * followed by hex, so the two can never collide or be mistaken for each other.
 *
 * The trade, stated plainly: two genuinely separate lines with the same
 * timestamp, topic and text collapse into one. RouterOS timestamps are
 * second-resolution, so that is possible. Losing a repeat of an identical
 * message is a far smaller loss than growing the table by the whole buffer
 * every minute for ever.
 */
export function surrogateLogId(time: string, topics: string, message: string): string {
  const hash = createHash('sha256')
    .update(`${time}\u0000${topics}\u0000${message}`)
    .digest('hex')
    .slice(0, 16);
  return `#${hash}`;           // 17 chars, inside the column's VARCHAR(20)
}

/** True for the ids this module synthesised, as opposed to RouterOS's own. */
export function isSurrogateLogId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('#');
}
