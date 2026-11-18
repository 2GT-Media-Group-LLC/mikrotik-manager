/**
 * The time a Traffic view covers: a preset range back from now (1h, 24h, 7d…),
 * or a window picked by dragging across the chart (#463), sent as `from` and
 * `to`. Both come out as the same shape, so every Traffic query takes either.
 */

/** The preset ranges, as Flux durations. */
export const RANGES = ['1h', '2h', '3h', '6h', '12h', '24h', '7d', '30d'] as const;
const RANGE_HOURS: Record<string, number> = { '1h': 1, '2h': 2, '3h': 3, '6h': 6, '12h': 12, '24h': 24, '7d': 168, '30d': 720 };

/** The longest window that can be picked: the longest preset, plus a day. */
export const MAX_WINDOW_MS = 31 * 86_400_000;
/** The shortest: one chart point, which is a minute at the finest. */
export const MIN_WINDOW_MS = 60_000;

export interface TimeWindow {
  /** The arguments to Flux's range(). */
  flux: string;
  /** The chart's aggregation window, sized so a chart stays readable. */
  every: string;
  /** Where the window starts. A preset's start is on the hour, like the hourly tables. */
  start: Date;
  /** Where a picked window ends; null for a preset, which runs to now. */
  stop: Date | null;
  /** A preset's length in hours; null for a picked window. */
  hours: number | null;
}

// Points are written every 60s by the collector flush.
function everyFor(spanMs: number): string {
  const h = spanMs / 3_600_000;
  if (h <= 1) return '1m';
  if (h <= 2) return '2m';
  if (h <= 6) return '5m';
  if (h <= 12) return '10m';
  if (h <= 24) return '15m';
  if (h <= 168) return '1h';
  return '6h';
}

// RFC 3339 only: Date also parses "2026" or "Nov 17", which no client sends.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The window a request asks for, or null when `from`/`to` are given but
 * aren't a usable window: not RFC 3339, out of order, shorter than a minute
 * or longer than 31 days. A window reaching into the future ends now.
 */
export function timeWindow(query: Record<string, unknown>, now = Date.now()): TimeWindow | null {
  if (query.from !== undefined || query.to !== undefined) {
    const from = String(query.from ?? ''), to = String(query.to ?? '');
    if (!ISO.test(from) || !ISO.test(to)) return null;
    const startMs = Date.parse(from), stopMs = Math.min(Date.parse(to), now);
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return null;
    const span = stopMs - startMs;
    if (span < MIN_WINDOW_MS || span > MAX_WINDOW_MS) return null;
    const start = new Date(startMs), stop = new Date(stopMs);
    // toISOString() is always RFC 3339, so it is safe as a Flux time literal.
    return { flux: `start: ${start.toISOString()}, stop: ${stop.toISOString()}`, every: everyFor(span), start, stop, hours: null };
  }
  const raw = String(query.range || '24h');
  const range = (RANGES as readonly string[]).includes(raw) ? raw : '24h';
  const hours = RANGE_HOURS[range];
  const start = new Date(now - hours * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return { flux: `start: -${range}`, every: everyFor(hours * 3_600_000), start, stop: null, hours };
}

export const BAD_WINDOW = 'Pick a window between a minute and 31 days long, with from before to.';
