import { createDateTimeFormat, type TimeFormat } from './dateTimeFormat';

// Friendly <-> cron translation for the Scheduled Backups setting. The backend
// still consumes a 5-field cron string (backup_schedule_cron); this keeps the UI
// to simple Frequency / time / day choices and hides cron from the user.

export type BackupFrequency = 'daily' | 'weekly' | 'monthly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sun .. 6=Sat (used when weekly)
  dayOfMonth: number; // 1-28 (used when monthly)
}

export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

const DEFAULT_SCHEDULE: BackupSchedule = {
  frequency: 'daily',
  hour: 2,
  minute: 0,
  weekday: 0,
  dayOfMonth: 1,
};

function intOr(field: string, fallback: number): number {
  return /^\d+$/.test(field) ? parseInt(field, 10) : fallback;
}

/** Parse a stored cron string into friendly schedule fields (best effort). */
export function parseBackupCron(cron: string | undefined | null): BackupSchedule {
  if (!cron) return { ...DEFAULT_SCHEDULE };
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return { ...DEFAULT_SCHEDULE };

  const [m, h, dom, , dow] = parts;
  const minute = intOr(m, DEFAULT_SCHEDULE.minute);
  const hour = intOr(h, DEFAULT_SCHEDULE.hour);

  if (dow !== '*' && /^\d+$/.test(dow)) {
    return { ...DEFAULT_SCHEDULE, frequency: 'weekly', hour, minute, weekday: parseInt(dow, 10) % 7 };
  }
  if (dom !== '*' && /^\d+$/.test(dom)) {
    return { ...DEFAULT_SCHEDULE, frequency: 'monthly', hour, minute, dayOfMonth: parseInt(dom, 10) };
  }
  return { ...DEFAULT_SCHEDULE, frequency: 'daily', hour, minute };
}

/** Build a 5-field cron string from friendly schedule fields. */
export function scheduleToCron(s: BackupSchedule): string {
  if (s.frequency === 'weekly') return `${s.minute} ${s.hour} * * ${s.weekday}`;
  if (s.frequency === 'monthly') return `${s.minute} ${s.hour} ${s.dayOfMonth} * *`;
  return `${s.minute} ${s.hour} * * *`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatTime(hour: number, minute: number, timeFormat: TimeFormat = 'browser', locales?: string | string[]): string {
  return createDateTimeFormat(timeFormat, locales).formatClockTime(hour, minute);
}

/** Human description, e.g. "Every Sunday at 3:00 AM". */
export function describeBackupSchedule(s: BackupSchedule, timeFormat: TimeFormat = 'browser', locales?: string | string[]): string {
  const t = formatTime(s.hour, s.minute, timeFormat, locales);
  if (s.frequency === 'weekly') return `Every ${WEEKDAY_NAMES[s.weekday]} at ${t}`;
  if (s.frequency === 'monthly') return `Monthly on the ${ordinal(s.dayOfMonth)} at ${t}`;
  return `Every day at ${t}`;
}
