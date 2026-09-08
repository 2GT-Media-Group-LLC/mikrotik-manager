/**
 * Deciding which RouterOS log lines are actually new (issue #137).
 *
 * `/log/print` returns the device's whole ring buffer every time — commonly a
 * thousand lines — so almost all of it is already stored. Getting this decision
 * right is the difference between inserting a handful of rows and re-offering
 * the entire buffer once a minute.
 */

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
