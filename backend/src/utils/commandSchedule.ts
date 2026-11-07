/**
 * Scheduled bulk commands (#359): when a schedule runs, and what it was given.
 *
 * Three kinds:
 *   - once:   a single date and time;
 *   - simple: daily, weekly or monthly at a time of day, kept as the choices
 *             made (for editing) and compiled to cron;
 *   - cron:   five fields, as written.
 * Every time is in the manager's time zone (Settings → General). A schedule
 * keeps its next run time; the scheduler fires it when that arrives, or marks
 * it missed when the manager wasn't running then (it never runs late).
 */
import { CronExpressionParser } from 'cron-parser';

export type ScheduleKind = 'once' | 'simple' | 'cron';
export type SimpleFreq = 'daily' | 'weekly' | 'monthly';
export interface SimpleSchedule { freq: SimpleFreq; time: string; weekday?: number; monthday?: number }

/** How late a due schedule may still start. Later than this, it's missed. */
export const GRACE_MS = 5 * 60_000;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A simple schedule as cron: minute hour day-of-month month day-of-week. */
export function simpleToCron(s: SimpleSchedule): string {
  const [, h, m] = TIME.exec(s.time) ?? ['', '0', '0'];
  const minute = Number(m); const hour = Number(h);
  if (s.freq === 'weekly') return `${minute} ${hour} * * ${s.weekday ?? 1}`;
  if (s.freq === 'monthly') return `${minute} ${hour} ${s.monthday ?? 1} * *`;
  return `${minute} ${hour} * * *`;
}

/** What's wrong with a cron expression, or null. Five fields only, no seconds. */
export function cronError(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return 'Use five fields: minute, hour, day of month, month, day of week (like 0 3 * * 1).';
  try {
    CronExpressionParser.parse(expr.trim(), { tz: 'UTC' });
    return null;
  } catch (e) {
    return `Not a valid cron expression: ${(e as Error).message}.`;
  }
}

/** The next time a cron fires after `from`, in a zone. */
export function nextCron(expr: string, from: Date, timeZone: string): Date | null {
  try {
    return CronExpressionParser.parse(expr.trim(), { currentDate: from, tz: timeZone || 'UTC' }).next().toDate();
  } catch {
    return null;
  }
}

/** A schedule's next run after `from`; null when a one-off has passed. */
export function nextRunAt(s: { kind: ScheduleKind; run_at: Date | string | null; cron: string | null }, from: Date, timeZone: string): Date | null {
  if (s.kind === 'once') {
    const at = s.run_at ? new Date(s.run_at) : null;
    return at && at.getTime() > from.getTime() ? at : null;
  }
  return s.cron ? nextCron(s.cron, from, timeZone) : null;
}

/** Due now, too late (missed), or not yet. */
export function dueDecision(nextRun: Date, now: Date): 'fire' | 'missed' | 'wait' {
  const late = now.getTime() - nextRun.getTime();
  if (late < 0) return 'wait';
  return late <= GRACE_MS ? 'fire' : 'missed';
}

/** "Daily at 03:00", "Mondays at 03:00", "Monthly on the 1st at 03:00", or the cron. */
export function describeSchedule(s: { kind: ScheduleKind; run_at: Date | string | null; cron: string | null; simple: SimpleSchedule | null }): string {
  if (s.kind === 'once') return 'Once';
  if (s.kind === 'cron' || !s.simple) return `Cron ${s.cron ?? ''}`.trim();
  const { freq, time } = s.simple;
  if (freq === 'weekly') return `${WEEKDAYS[s.simple.weekday ?? 1]}s at ${time}`;
  if (freq === 'monthly') {
    const d = s.simple.monthday ?? 1;
    const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
    return `Monthly on the ${d}${suffix} at ${time}`;
  }
  return `Daily at ${time}`;
}

export interface ScheduleInput {
  name: string;
  command: string;
  device_ids: number[];
  tag_ids: number[];
  site_ids: number[];
  wave_size: number;
  halt_on_failure: boolean;
  use_change_guard: boolean;
  maintenance_only: boolean;
  alert_on_failure: boolean;
  kind: ScheduleKind;
  run_at: string | null;
  cron: string | null;
  simple: SimpleSchedule | null;
}

const idList = (v: unknown): number[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0) ? [...new Set(v as number[])] : null;

/**
 * A schedule from the form, or what's wrong with it, field by field. `now`
 * is for refusing a one-off in the past.
 */
export function parseScheduleInput(body: Record<string, unknown>, now = new Date()): { schedule: ScheduleInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const command = str('command');
  if (!command) errors.command = 'Enter the command to run.';
  else if (command.length > 20_000) errors.command = 'That command is too long.';
  const name = (str('name') || command.split('\n')[0]).slice(0, 120);

  const device_ids = idList(body.device_ids); const tag_ids = idList(body.tag_ids); const site_ids = idList(body.site_ids);
  if (!device_ids || !tag_ids || !site_ids) errors.targets = 'Devices, tags and sites must be ids.';
  else if (device_ids.length + tag_ids.length + site_ids.length === 0) errors.targets = 'Choose devices, a tag or a site.';

  const kind = str('kind') as ScheduleKind;
  let run_at: string | null = null; let cron: string | null = null; let simple: SimpleSchedule | null = null;
  if (kind === 'once') {
    const at = new Date(str('run_at'));
    if (Number.isNaN(at.getTime())) errors.run_at = 'Choose a date and time.';
    else if (at.getTime() <= now.getTime()) errors.run_at = 'Choose a time in the future.';
    else run_at = at.toISOString();
  } else if (kind === 'simple') {
    const s = (body.simple ?? {}) as Record<string, unknown>;
    const freq = s.freq as SimpleFreq;
    const time = typeof s.time === 'string' ? s.time : '';
    if (!['daily', 'weekly', 'monthly'].includes(freq)) errors.simple = 'Choose daily, weekly or monthly.';
    else if (!TIME.test(time)) errors.simple = 'Choose a time of day, like 03:00.';
    else if (freq === 'weekly' && !(Number.isInteger(s.weekday) && (s.weekday as number) >= 0 && (s.weekday as number) <= 6)) errors.simple = 'Choose a day of the week.';
    else if (freq === 'monthly' && !(Number.isInteger(s.monthday) && (s.monthday as number) >= 1 && (s.monthday as number) <= 28)) {
      errors.simple = 'Choose a day from 1 to 28, so it runs every month.';
    } else {
      simple = { freq, time, ...(freq === 'weekly' ? { weekday: s.weekday as number } : {}), ...(freq === 'monthly' ? { monthday: s.monthday as number } : {}) };
      cron = simpleToCron(simple);
    }
  } else if (kind === 'cron') {
    const c = str('cron');
    const err = cronError(c);
    if (err) errors.cron = err;
    else cron = c.replace(/\s+/g, ' ');
  } else {
    errors.kind = 'Choose once, simple or advanced.';
  }

  const wave = Number(body.wave_size ?? 1);
  if (!Number.isInteger(wave) || wave < 1 || wave > 50) errors.wave_size = 'Wave size is 1 to 50.';

  if (Object.keys(errors).length) return { errors };
  return {
    schedule: {
      name, command, device_ids: device_ids!, tag_ids: tag_ids!, site_ids: site_ids!, wave_size: wave,
      halt_on_failure: body.halt_on_failure !== false,
      // Opt-out, like a run: someone who hasn't thought about it gets the protection.
      use_change_guard: body.use_change_guard !== false,
      maintenance_only: body.maintenance_only === true,
      alert_on_failure: body.alert_on_failure !== false,
      kind, run_at, cron, simple,
    },
  };
}
