/**
 * Downtime inside a reporting window (outside review P2-25).
 *
 * Availability used to count only outages that *started* inside the window,
 * and an outage still in progress counted as zero. A device down for days
 * showed 100% uptime in the dashboard, the fleet summary and the scheduled
 * customer report. Every outage that overlaps the window now counts, clipped
 * to it, and one still in progress lasts until now.
 */

export interface OutageRow {
  went_offline_at: string | Date;
  came_back_online_at: string | Date | null;
}

/** Seconds of `o` that fall between windowStart and now. */
export function outageSecondsInWindow(o: OutageRow, windowStart: Date, now: Date = new Date()): number {
  const start = Math.max(new Date(o.went_offline_at).getTime(), windowStart.getTime());
  const end = Math.min(o.came_back_online_at ? new Date(o.came_back_online_at).getTime() : now.getTime(), now.getTime());
  return end > start ? Math.round((end - start) / 1000) : 0;
}

/** The outage's whole length so far: to its end, or to now while it lasts. */
export function outageLengthSeconds(o: OutageRow, now: Date = new Date()): number {
  const end = o.came_back_online_at ? new Date(o.came_back_online_at).getTime() : now.getTime();
  return Math.max(0, Math.round((end - new Date(o.went_offline_at).getTime()) / 1000));
}

/**
 * SQL for the same thing, over device_availability rows aliased `alias`, with
 * the window length as an interval expression (e.g. `$1::interval`). Use with
 * OUTAGE_OVERLAPS in the WHERE clause.
 */
export function outageSecondsSql(window: string, alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `EXTRACT(EPOCH FROM (LEAST(COALESCE(${a}came_back_online_at, NOW()), NOW()) - GREATEST(${a}went_offline_at, NOW() - ${window})))`;
}

/** WHERE condition: the outage overlaps the last `window`. */
export function outageOverlapsSql(window: string, alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}came_back_online_at IS NULL OR ${a}came_back_online_at > NOW() - ${window}) AND ${a}went_offline_at < NOW()`;
}
