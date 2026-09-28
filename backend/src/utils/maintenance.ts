import { cronMatches } from './cron';

/**
 * Whether a maintenance window covers a device right now (P2-26).
 *
 * Two things used to stop windows working at all:
 *   - The UI never offered a device choice and saved an empty list, which
 *     matched no device. An empty list now means every device.
 *   - `recurring_cron` was stored but never read, so a weekly window worked
 *     once. For a repeating window, `start_at` is the first occurrence (it
 *     suppresses nothing before then) and `end_at - start_at` is how long each
 *     occurrence lasts; the cron says when an occurrence starts, in the
 *     manager's time zone.
 */

export interface MaintenanceWindowRow {
  device_ids: number[] | null;
  start_at: string | Date;
  end_at: string | Date;
  recurring_cron: string | null;
  active: boolean;
}

/** Occurrences longer than a week are treated as a week, to bound the search. */
const MAX_OCCURRENCE_MIN = 7 * 24 * 60;

export function windowCovers(
  w: MaintenanceWindowRow, deviceId: number, now: Date = new Date(), timeZone = 'UTC'
): boolean {
  if (!w.active) return false;
  const ids = w.device_ids ?? [];
  if (ids.length > 0 && !ids.includes(deviceId)) return false;

  const start = new Date(w.start_at).getTime();
  const end = new Date(w.end_at).getTime();
  if (!(end > start)) return false;
  const t = now.getTime();

  const cron = w.recurring_cron?.trim();
  if (!cron) return t >= start && t <= end;

  if (t < start) return false;
  const durationMin = Math.min(Math.ceil((end - start) / 60_000), MAX_OCCURRENCE_MIN);
  const thisMinute = Math.floor(t / 60_000) * 60_000;
  for (let i = 0; i <= durationMin; i++) {
    const at = thisMinute - i * 60_000;
    if (at < start - 60_000) break;
    if (cronMatches(cron, new Date(at), timeZone) && t <= at + (end - start)) return true;
  }
  return false;
}
