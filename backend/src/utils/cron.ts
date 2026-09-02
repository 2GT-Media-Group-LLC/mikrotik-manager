/**
 * Cron matching in a named timezone.
 *
 * Split out of PollerService because the bug it fixes was invisible in place:
 * scheduling used `Date`'s own accessors, which read the *process* timezone.
 * The shipped container runs UTC, so a "02:00" backup fired at 02:00 UTC no
 * matter where the operator was — seven hours early on the US west coast, and
 * on the wrong day for anyone far enough east (#117).
 *
 * Zone handling goes through Intl rather than offset arithmetic, which gets
 * daylight saving right without a date library or a table of rules.
 */

export interface ZonedParts {
  minute: number;
  hour: number;
  /** Day of month, 1-31. */
  dom: number;
  /** Month, 1-12 — cron's numbering, not JavaScript's. */
  month: number;
  /** Day of week, 0-6 with Sunday as 0. */
  dow: number;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of an instant in a given zone. Falls back to UTC if unknown. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
      }).formatToParts(date).map((p) => [p.type, p.value])
    );
    return {
      minute: Number(parts.minute),
      // Some environments render midnight as hour "24".
      hour: Number(parts.hour) % 24,
      dom: Number(parts.day),
      month: Number(parts.month),
      dow: DOW[parts.weekday] ?? 0,
    };
  } catch {
    return {
      minute: date.getUTCMinutes(), hour: date.getUTCHours(), dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1, dow: date.getUTCDay(),
    };
  }
}

/** Does one cron field match a value? Supports `*`, lists, ranges and steps. */
export function matchField(field: string, val: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((f) => {
    if (f.includes('/')) {
      const [base, step] = f.split('/');
      const start = base === '*' ? 0 : Number(base);
      const by = Number(step);
      if (!Number.isFinite(by) || by <= 0) return false;
      return val >= start && (val - start) % by === 0;
    }
    if (f.includes('-')) {
      const [lo, hi] = f.split('-').map(Number);
      return val >= lo && val <= hi;
    }
    return Number(f) === val;
  });
}

/**
 * Does a 5-field cron expression match this instant, read in `timeZone`?
 *
 * Day-of-month and day-of-week follow the standard rule: when both are
 * restricted the job runs if *either* matches, not both.
 */
export function cronMatches(cron: string, at: Date, timeZone = 'UTC'): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = parts;
  const now = zonedParts(at, timeZone);

  if (!matchField(minuteField, now.minute)) return false;
  if (!matchField(hourField, now.hour)) return false;
  if (!matchField(monthField, now.month)) return false;

  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';
  const domMatch = matchField(domField, now.dom);
  const dowMatch = matchField(dowField, now.dow);

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}
