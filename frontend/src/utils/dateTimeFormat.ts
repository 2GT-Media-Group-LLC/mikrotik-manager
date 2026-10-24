export type TimeFormat = 'browser' | '12h' | '24h';
export type DateTimeValue = Date | string | number;
export type DateTimeOptions = Omit<Intl.DateTimeFormatOptions, 'hour12' | 'hourCycle'>;

export function isTimeFormat(value: unknown): value is TimeFormat {
  return value === 'browser' || value === '12h' || value === '24h';
}

/** Include an hour: a date-only formatter does not report its hour cycle. */
export function resolveTimeFormat(preference: TimeFormat, locales?: string | string[]): '12h' | '24h' {
  if (preference !== 'browser') return preference;
  return new Intl.DateTimeFormat(locales, { hour: 'numeric' }).resolvedOptions().hour12 ? '12h' : '24h';
}

/** Display only. Never use these strings as API values or to construct a cron. */
export function createDateTimeFormat(preference: TimeFormat = 'browser', locales?: string | string[]) {
  const hourCycle = resolveTimeFormat(preference, locales) === '12h' ? 'h12' : 'h23';
  const cache = new Map<string, Intl.DateTimeFormat>();

  const display = (value: DateTimeValue, options: DateTimeOptions): string => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    const key = JSON.stringify(options);
    let formatter = cache.get(key);
    if (!formatter) {
      // h23 keeps midnight at 00:00, including under an en-US browser locale.
      formatter = new Intl.DateTimeFormat(locales, { ...options, hourCycle });
      cache.set(key, formatter);
    }
    return formatter.format(date);
  };

  const formatTime = (value: DateTimeValue, options: DateTimeOptions = {}): string =>
    display(value, { hour: '2-digit', minute: '2-digit', ...options });

  const formatDateTime = (value: DateTimeValue, options: DateTimeOptions = {}): string =>
    display(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...options });

  // A schedule's wall-clock time is not an instant. UTC avoids local DST gaps
  // when formatting it, without converting or changing the scheduled hour.
  const formatClockTime = (hour: number, minute: number): string =>
    formatTime(new Date(Date.UTC(2000, 0, 1, hour, minute)), { timeZone: 'UTC' });

  return { formatTime, formatDateTime, formatClockTime };
}

export type DateTimeFormatters = ReturnType<typeof createDateTimeFormat>;
