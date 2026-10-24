export type TimeFormat = 'browser' | '12h' | '24h';
export type TimeFormatPreference = 'system' | TimeFormat;

export function isTimeFormat(value: unknown): value is TimeFormat {
  return value === 'browser' || value === '12h' || value === '24h';
}

export function isTimeFormatPreference(value: unknown): value is TimeFormatPreference {
  return value === 'system' || isTimeFormat(value);
}

export function timeFormatPreferences(row: { time_format?: unknown; system_default?: unknown }) {
  return {
    preference: isTimeFormat(row.time_format) ? row.time_format : 'system' as TimeFormatPreference,
    system_default: isTimeFormat(row.system_default) ? row.system_default : 'browser' as TimeFormat,
  };
}
