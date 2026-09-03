/**
 * Turning a RouterOS log timestamp into a real instant.
 *
 * RouterOS writes log times in the **device's own timezone** and never says so.
 * Treating them as UTC shifts every event by the device's offset — reported as
 * an event log seven hours out from the device page (#117).
 *
 * It also uses more than one format. A device may report any of:
 *
 *   2026-09-03 08:37:38     full date, space separated
 *   sep/03/2026 08:37:38    month name, with year
 *   sep/03 08:37:38         month name, no year
 *   08:37:38                time only, for entries from today
 *
 * The space-separated form was not handled at all, so those timestamps silently
 * became the moment of collection rather than the moment of the event — which
 * looks correct on a live poll and is badly wrong for any backlog, where a
 * thousand historical lines all arrive stamped "now".
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Offset of a zone, in milliseconds, at a given instant. */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asIfUtc - utcMs;
}

/**
 * Wall-clock fields in a named zone → the UTC instant they describe.
 *
 * Two passes, because the offset depends on the instant and the instant depends
 * on the offset. The second pass settles daylight-saving boundaries, where the
 * first guess can land on the wrong side of a transition.
 */
export function wallClockToUtc(
  y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = offsetMsAt(guess, timeZone);
  offset = offsetMsAt(guess - offset, timeZone);
  return new Date(guess - offset);
}

/** Wall-clock fields pulled out of a log timestamp, before any zone is applied. */
interface WallClock { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** Split a RouterOS timestamp into wall-clock fields. Null when unrecognised. */
export function parseWallClock(timeStr: string, now: Date): WallClock | null {
  const t = (timeStr || '').trim();
  if (!t) return null;

  // 2026-09-03 08:37:38  — what current RouterOS returns over the API.
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  }

  // sep/03/2026 08:37:38  or  sep/03 08:37:38
  m = t.match(/^([a-z]{3})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2}):(\d{2})/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) return null;
    return {
      // Without a year RouterOS means the current one on the device.
      y: m[3] ? +m[3] : now.getUTCFullYear(),
      mo, d: +m[2], h: +m[4], mi: +m[5], s: +m[6],
    };
  }

  // 08:37:38 — today, on the device.
  m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    return {
      y: now.getUTCFullYear(), mo: now.getUTCMonth() + 1, d: now.getUTCDate(),
      h: +m[1], mi: +m[2], s: +m[3],
    };
  }
  return null;
}

export interface DeviceClock {
  /** IANA name from /system/clock, e.g. "America/Los_Angeles". */
  timeZoneName?: string | null;
  /** RouterOS gmt-offset, e.g. "-07:00". Used when the zone name is unusable. */
  gmtOffset?: string | null;
}

/** RouterOS gmt-offset ("-07:00", "+0530", "25200") to milliseconds. */
export function parseGmtOffsetMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = String(raw).trim();
  const m = t.match(/^([+-])(\d{1,2}):?(\d{2})$/);
  if (m) {
    const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
    return m[1] === '-' ? -ms : ms;
  }
  const secs = Number(t);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

/**
 * A RouterOS log timestamp as a real instant.
 *
 * Returns null when the format is unrecognised *or* the device's timezone is
 * unknown — deliberately, so the caller decides rather than this guessing. A
 * wrong timestamp is worse than an obviously approximate one, because it looks
 * authoritative.
 */
export function parseDeviceLogTime(
  timeStr: string, clock: DeviceClock, now = new Date(),
): Date | null {
  const wall = parseWallClock(timeStr, now);
  if (!wall) return null;

  if (clock.timeZoneName) {
    try {
      return wallClockToUtc(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, clock.timeZoneName);
    } catch {
      // Fall through to the numeric offset below.
    }
  }

  const offsetMs = parseGmtOffsetMs(clock.gmtOffset);
  if (offsetMs != null) {
    return new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - offsetMs);
  }
  return null;
}
