/**
 * Scheduled bulk commands (#359).
 *
 * Once a minute: start any schedule whose next run has arrived, as an ordinary
 * run in the run history, or mark it missed when its time passed while the
 * manager wasn't running (a command runs at the time someone chose, or not at
 * all). Each run is checked again as its creator: the account must still exist
 * and be able to write, a site-limited account only reaches devices in its
 * sites, and secrets still need a fleet admin.
 *
 * Only one bulk run goes at a time. A scheduled run that finds another going
 * waits, and is marked missed if it still can't start after 15 minutes.
 */
import { query, queryOne } from '../config/database';
import { commandRunner } from './CommandRunner';
import { alertService } from './AlertService';
import { loadSiteRoles } from '../utils/siteRoles';
import { devicesDenied } from '../utils/siteAccess';
import { secretNames, missingSecrets } from './commandSecrets';
import { windowCovers, type MaintenanceWindowRow } from '../utils/maintenance';
import { nextRunAt, dueDecision, type ScheduleKind, type SimpleSchedule } from '../utils/commandSchedule';
import type { AuthPayload } from '../middleware/auth';

export interface ScheduleRow {
  id: number; name: string; command: string;
  device_ids: number[]; tag_ids: number[]; site_ids: number[];
  wave_size: number; halt_on_failure: boolean; use_change_guard: boolean;
  maintenance_only: boolean; alert_on_failure: boolean;
  kind: ScheduleKind; run_at: string | null; cron: string | null; simple: SimpleSchedule | null;
  enabled: boolean; next_run_at: string | null;
  created_by: string | null; created_by_user_id: number | null;
}

/** How long a scheduled run may wait for another run to finish. */
export const START_WAIT_MS = 15 * 60_000;

export async function appTimeZone(): Promise<string> {
  const row = await queryOne<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'app_timezone'`).catch(() => null);
  return typeof row?.value === 'string' && row.value ? row.value : 'UTC';
}

/** Every device a schedule reaches now: named, tagged, or in a site. */
export async function resolveTargets(s: Pick<ScheduleRow, 'device_ids' | 'tag_ids' | 'site_ids'>): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT d.id FROM devices d
      WHERE d.id = ANY($1::int[])
         OR d.site_id = ANY($3::int[])
         OR EXISTS (SELECT 1 FROM device_tags t WHERE t.device_id = d.id AND t.tag_id = ANY($2::int[]))
      ORDER BY d.name`,
    [s.device_ids ?? [], s.tag_ids ?? [], s.site_ids ?? []]);
  return rows.map((r) => r.id);
}

/** The creator as the request would have been, or why the schedule can't run as them. */
async function creatorOf(s: ScheduleRow): Promise<{ user: AuthPayload } | { refused: string }> {
  if (!s.created_by_user_id) return { refused: 'The account that made this schedule was removed.' };
  const u = await queryOne<{ id: number; username: string; role: string }>(`SELECT id, username, role FROM users WHERE id = $1`, [s.created_by_user_id]);
  if (!u) return { refused: 'The account that made this schedule was removed.' };
  const siteRoles = await loadSiteRoles(u.id);
  const user: AuthPayload = { userId: u.id, username: u.username, role: u.role, ...(siteRoles ? { siteRoles } : {}) };
  // A site-limited account can write where it's operator or admin in some site;
  // which devices that reaches is checked per device below.
  const roles = siteRoles ? Object.values(siteRoles) : [u.role];
  if (!roles.some((r) => r === 'admin' || r === 'operator')) return { refused: `${u.username} can no longer run commands (read-only).` };
  return { user };
}

class CommandScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor() {
    commandRunner.onFinish((runId, status) => this.runFinished(runId, status));
  }

  private aligner: ReturnType<typeof setTimeout> | null = null;

  /** Tick now, then at the start of every minute, so a 03:00 run starts at 03:00, not up to a minute after. */
  start(): void {
    if (this.timer || this.aligner) return;
    void this.tick();
    this.aligner = setTimeout(() => {
      this.aligner = null;
      void this.tick();
      this.timer = setInterval(() => { void this.tick(); }, 60_000);
    }, 60_000 - (Date.now() % 60_000) + 500);
  }

  stop(): void {
    if (this.aligner) { clearTimeout(this.aligner); this.aligner = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.startWaiting(now);
      const due = await query<ScheduleRow>(
        `SELECT * FROM command_schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at`, [now]);
      const tz = due.length ? await appTimeZone() : 'UTC';
      for (const s of due) await this.due(s, now, tz).catch((e) => console.error(`[Schedule] #${s.id}:`, e));
    } catch (e) {
      console.error('[Schedule] tick failed:', e);
    } finally {
      this.ticking = false;
    }
  }

  /** Claim one due time (so two processes can't both take it), then run it or mark it missed. */
  private async due(s: ScheduleRow, now: Date, tz: string): Promise<void> {
    const at = new Date(s.next_run_at!);
    const next = nextRunAt(s, now, tz);
    const claimed = await queryOne<{ id: number }>(
      `UPDATE command_schedules SET next_run_at = $2, enabled = $3, updated_at = NOW()
        WHERE id = $1 AND next_run_at = $4 RETURNING id`,
      [s.id, next, s.kind === 'once' ? false : s.enabled, at]);
    if (!claimed) return;
    if (dueDecision(at, now) === 'missed') {
      await this.missed(s, `It was due at ${at.toISOString()}, while MikroTik Manager wasn't running.`);
      return;
    }
    await this.fire(s);
  }

  /**
   * Make the run and start it (or leave it waiting for the runner). Also used
   * by Run now. Returns the run's id, or null when it couldn't run.
   */
  async fire(s: ScheduleRow): Promise<number | null> {
    const creator = await creatorOf(s);
    if ('refused' in creator) { await this.missed(s, creator.refused); return null; }
    const { user } = creator;

    if (secretNames(s.command).length) {
      if (user.role !== 'admin' || user.siteRoles) { await this.missed(s, 'It uses secrets, and only a fleet admin can run those.'); return null; }
      const missing = await missingSecrets(s.command);
      if (missing.length) { await this.missed(s, `Secret${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}.`); return null; }
    }

    let ids = await resolveTargets(s);
    let note: string | null = null;
    if (user.siteRoles) {
      const denied = new Set((await devicesDenied(user, ids, 'operator')).map(Number));
      if (denied.size) note = `${denied.size} device${denied.size === 1 ? ' is' : 's are'} outside ${user.username}'s sites and ${denied.size === 1 ? 'was' : 'were'} left out.`;
      ids = ids.filter((id) => !denied.has(id));
    }
    if (ids.length === 0) { await this.missed(s, note ?? 'No devices matched its devices, tags or sites.'); return null; }

    let outside = new Set<number>();
    if (s.maintenance_only) {
      const [windows, tz] = await Promise.all([
        query<MaintenanceWindowRow>(`SELECT device_ids, start_at, end_at, recurring_cron, active FROM maintenance_windows WHERE active`),
        appTimeZone(),
      ]);
      const now = new Date();
      outside = new Set(ids.filter((id) => !windows.some((w) => windowCovers(w, id, now, tz))));
    }

    const run = await queryOne<{ id: number }>(
      `INSERT INTO command_runs (name, command, wave_size, halt_on_failure, use_change_guard, created_by, schedule_id, note, status, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text, CASE WHEN $9::text = 'missed' THEN NOW() END) RETURNING id`,
      [s.name, s.command, s.wave_size, s.halt_on_failure, s.use_change_guard, `${s.created_by ?? user.username} (scheduled)`, s.id,
        outside.size === ids.length ? [note, 'None of its devices was in a maintenance window.'].filter(Boolean).join(' ') : note,
        outside.size === ids.length ? 'missed' : 'pending']);
    let wave = 0; let inWave = 0;
    for (const id of ids) {
      const skip = outside.has(id);
      if (!skip) { if (inWave === 0) wave++; inWave = (inWave + 1) % s.wave_size; }
      await query(
        `INSERT INTO command_run_devices (run_id, device_id, wave, status, error, finished_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [run!.id, id, Math.max(wave, 1), skip ? 'skipped' : 'pending', skip ? 'Outside a maintenance window' : null, skip ? new Date() : null]);
    }
    await query(`UPDATE command_schedules SET last_run_id = $2, last_status = $3 WHERE id = $1`,
      [s.id, run!.id, outside.size === ids.length ? 'missed' : 'pending']);
    if (outside.size === ids.length) { await this.alert(s, run!.id, 'missed', 'None of its devices was in a maintenance window.'); return run!.id; }
    await this.tryStart(run!.id);
    return run!.id;
  }

  private async tryStart(runId: number): Promise<boolean> {
    if (commandRunner.isRunning) return false;
    try { await commandRunner.start(runId); return true; } catch { return false; }
  }

  /** Scheduled runs waiting on another run: start one, or give up after the wait. */
  private async startWaiting(now: Date): Promise<void> {
    const waiting = await query<{ id: number; schedule_id: number; created_at: string }>(
      `SELECT id, schedule_id, created_at FROM command_runs WHERE status = 'pending' AND schedule_id IS NOT NULL ORDER BY id`);
    for (const r of waiting) {
      if (now.getTime() - new Date(r.created_at).getTime() > START_WAIT_MS) {
        const why = 'Another bulk run was still going after 15 minutes.';
        await query(`UPDATE command_runs SET status = 'missed', note = $2, finished_at = NOW() WHERE id = $1 AND status = 'pending'`, [r.id, why]);
        await query(`UPDATE command_run_devices SET status = 'skipped', finished_at = NOW() WHERE run_id = $1 AND status = 'pending'`, [r.id]);
        const s = await queryOne<ScheduleRow>(`SELECT * FROM command_schedules WHERE id = $1`, [r.schedule_id]);
        if (s) { await query(`UPDATE command_schedules SET last_status = 'missed' WHERE id = $1`, [s.id]); await this.alert(s, r.id, 'missed', why); }
        continue;
      }
      if (!(await this.tryStart(r.id))) return;
    }
  }

  /** A run that didn't happen, kept in the run history with the reason. */
  private async missed(s: ScheduleRow, why: string): Promise<void> {
    const run = await queryOne<{ id: number }>(
      `INSERT INTO command_runs (name, command, wave_size, halt_on_failure, use_change_guard, created_by, schedule_id, note, status, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'missed',NOW()) RETURNING id`,
      [s.name, s.command, s.wave_size, s.halt_on_failure, s.use_change_guard, `${s.created_by ?? 'schedule'} (scheduled)`, s.id, why]);
    await query(`UPDATE command_schedules SET last_run_id = $2, last_status = 'missed' WHERE id = $1`, [s.id, run!.id]);
    console.warn(`[Schedule] "${s.name}" missed: ${why}`);
    await this.alert(s, run!.id, 'missed', why);
  }

  /** A scheduled run ended: record it, and alert when anything failed. */
  private async runFinished(runId: number, status: string): Promise<void> {
    const run = await queryOne<{ schedule_id: number | null }>(`SELECT schedule_id FROM command_runs WHERE id = $1`, [runId]);
    if (!run?.schedule_id) return;
    const s = await queryOne<ScheduleRow>(`SELECT * FROM command_schedules WHERE id = $1`, [run.schedule_id]);
    if (!s) return;
    const counts = await query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM command_run_devices WHERE run_id = $1 GROUP BY status`, [runId]);
    const failed = counts.filter((c) => c.status === 'failed' || c.status === 'reverted').reduce((a, c) => a + c.n, 0);
    const outcome = status === 'completed' && failed === 0 ? 'completed' : status === 'completed' ? 'failed' : status;
    await query(`UPDATE command_schedules SET last_status = $2 WHERE id = $1`, [s.id, outcome]);
    if (outcome !== 'completed' && outcome !== 'cancelled') {
      const total = counts.reduce((a, c) => a + c.n, 0);
      await this.alert(s, runId, outcome, `${failed} of ${total} device${total === 1 ? '' : 's'} failed${status === 'halted' ? ', and the run halted' : ''}.`);
    }
  }

  private async alert(s: ScheduleRow, runId: number, outcome: string, detail: string): Promise<void> {
    if (!s.alert_on_failure) return;
    await alertService.dispatch('scheduled_command_failed',
      `Scheduled command "${s.name}" ${outcome === 'missed' ? "didn't run" : outcome === 'halted' ? 'halted' : 'failed'}: ${detail}`,
      { details: `Run #${runId}, under Bulk Commands → History.`, cooldownKey: `scheduled_command_failed:${s.id}:${runId}` },
    ).catch((e) => console.error('[Schedule] alert failed:', e));
  }
}

export const commandScheduler = new CommandScheduler();
