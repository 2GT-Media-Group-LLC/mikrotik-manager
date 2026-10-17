/**
 * Platform backup of MikroTik Manager itself: making backups (now or on the
 * schedule), sending them to destinations, keeping the newest N, and
 * restoring with the app paused, a backup of the current state taken first,
 * and a restart afterwards so every cache starts from the restored data.
 */
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';
import { cronMatches } from '../../utils/cron';
import { logSafe } from '../../utils/logSafe';
import { alertService } from '../AlertService';
import { exportRecords, restoreFromFile, versionNotNewer, type RestoreMode, type RestoreResult } from './engine';
import { writeBackup, readHeader, type BackupContents, type BackupHeader } from './format';
import {
  LOCAL_DIR, UPLOAD_DIR, FILE_PREFIX, ensureLocalDir, sendTo, pruneAt,
  type Destination, type DestinationType,
} from './destinations';

export const APP_VERSION = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as { version: string }).version; }
  catch { return '0.0.0'; }
})();

export const MIN_PASSPHRASE = 12;
/** Pre-restore backups are kept apart from the schedule's count. */
const KEEP_PRE_RESTORE = 3;

// ─── State ──────────────────────────────────────────────────────────────────

export interface RestoreState {
  phase: 'idle' | 'pre-backup' | 'restoring' | 'restarting' | 'failed';
  message: string;
  startedAt: string | null;
  result?: RestoreResult;
  error?: string;
}
let restoreState: RestoreState = { phase: 'idle', message: '', startedAt: null };
let backupRunning = false;

/** True while a restore runs: the API answers 503 and the poller stands still. */
export function isRestoring(): boolean {
  return restoreState.phase === 'pre-backup' || restoreState.phase === 'restoring' || restoreState.phase === 'restarting';
}
export function restoreStatus(): RestoreState { return restoreState; }

// ─── Settings and destinations ──────────────────────────────────────────────

export interface ScheduleSettings {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time_of_day: string;
  weekday: number;
  monthday: number;
  contents: BackupContents;
  keep: number;
  destination_ids: number[];
  has_passphrase: boolean;
  last_run_at: string | null;
}

export async function getSchedule(): Promise<ScheduleSettings & { passphrase_encrypted: string | null }> {
  await query(`INSERT INTO platform_backup_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const r = (await queryOne<ScheduleSettings & { passphrase_encrypted: string | null }>(
    `SELECT enabled, frequency, time_of_day, weekday, monthday, contents, keep, destination_ids,
            passphrase_encrypted, (passphrase_encrypted IS NOT NULL) AS has_passphrase, last_run_at
       FROM platform_backup_settings WHERE id = 1`))!;
  return r;
}

/** The cron expression the schedule amounts to. */
export function scheduleCron(s: Pick<ScheduleSettings, 'frequency' | 'time_of_day' | 'weekday' | 'monthday'>): string {
  const [h, m] = s.time_of_day.split(':').map(Number);
  if (s.frequency === 'weekly') return `${m} ${h} * * ${s.weekday}`;
  if (s.frequency === 'monthly') return `${m} ${h} ${s.monthday} * *`;
  return `${m} ${h} * * *`;
}

interface DestinationRow {
  id: number; type: DestinationType; name: string; enabled: boolean; keep: number;
  config: Record<string, unknown>; secret_encrypted: string | null;
}

export function toDestination(r: DestinationRow): Destination {
  let secrets: Record<string, string> = {};
  if (r.secret_encrypted) {
    try { secrets = JSON.parse(decrypt(r.secret_encrypted)); } catch { secrets = {}; }
  }
  return { id: r.id, type: r.type, name: r.name, enabled: r.enabled, keep: r.keep, config: r.config, secrets };
}

export async function loadDestinations(ids?: number[]): Promise<Destination[]> {
  const rows = await query<DestinationRow>(
    ids ? `SELECT * FROM platform_backup_destinations WHERE id = ANY($1::int[]) ORDER BY id`
      : `SELECT * FROM platform_backup_destinations ORDER BY id`, ids ? [ids] : []);
  return rows.map(toDestination);
}

/** Remember an SFTP server's host key the first time it's used. */
export async function pinHostKey(id: number, hostKey: string | undefined): Promise<void> {
  if (!hostKey) return;
  await query(
    `UPDATE platform_backup_destinations SET config = jsonb_set(config, '{hostKey}', to_jsonb($2::text)), updated_at = NOW()
      WHERE id = $1 AND type = 'sftp' AND COALESCE(config->>'hostKey', '') = ''`, [id, hostKey]);
}

export function sealSecrets(secrets: Record<string, string>): string | null {
  const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v !== ''));
  return Object.keys(clean).length ? encrypt(JSON.stringify(clean)) : null;
}

// ─── Making a backup ────────────────────────────────────────────────────────

export type Trigger = 'manual' | 'scheduled' | 'pre-restore';

function fileNameFor(contents: BackupContents, trigger: Trigger): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const what = contents === 'config' ? 'config' : 'full';
  return `${FILE_PREFIX}${stamp}-${what}${trigger === 'pre-restore' ? '-prerestore' : ''}.mtmbackup`;
}

export interface BackupOutcome {
  id: number;
  fileName: string;
  ok: boolean;
  error?: string;
  destinations: { id: number; name: string; type: string; ok: boolean; error?: string; pruned?: number }[];
}

/**
 * Make a backup, send it to `destinationIds`, and prune. Destination failures
 * don't fail the backup itself (the local copy stands) but are reported, and
 * alerted on.
 */
/** True while a backup is being written. */
export function isBackupRunning(): boolean { return backupRunning; }

export async function runBackup(opts: {
  contents: BackupContents; passphrase: string; trigger: Trigger; userId?: number | null;
  destinationIds?: number[]; keep?: number;
}): Promise<BackupOutcome> {
  if (opts.passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  if (backupRunning) throw new Error('A platform backup is already running.');
  backupRunning = true;
  ensureLocalDir();
  const fileName = fileNameFor(opts.contents, opts.trigger);
  const final = path.join(LOCAL_DIR, fileName);
  const partial = `${final}.partial`;
  const row = (await queryOne<{ id: number }>(
    `INSERT INTO platform_backups (file_name, contents, trigger, status, app_version, created_by)
     VALUES ($1, $2, $3, 'running', $4, $5) RETURNING id`,
    [fileName, opts.contents, opts.trigger, APP_VERSION, opts.userId ?? null]))!;
  const outcome: BackupOutcome = { id: row.id, fileName, ok: false, destinations: [] };
  try {
    await writeBackup(partial, opts.passphrase, { appVersion: APP_VERSION, contents: opts.contents }, exportRecords(opts.contents, APP_VERSION));
    await fs.promises.rename(partial, final);
    const size = (await fs.promises.stat(final)).size;
    outcome.ok = true;

    for (const d of await loadDestinations(opts.destinationIds ?? [])) {
      if (!d.enabled) continue;
      const res: BackupOutcome['destinations'][number] = { id: d.id, name: d.name, type: d.type, ok: false };
      try {
        const { hostKey } = await sendTo(d, final, fileName);
        await pinHostKey(d.id, hostKey);
        res.ok = true;
        if (opts.trigger !== 'pre-restore') res.pruned = await pruneAt(d, d.keep).catch(() => 0);
      } catch (err) {
        res.error = (err as Error).message;
      }
      outcome.destinations.push(res);
    }

    await query(
      `UPDATE platform_backups SET status = 'success', size_bytes = $2, destinations = $3, finished_at = NOW() WHERE id = $1`,
      [row.id, size, JSON.stringify(outcome.destinations)]);
    await pruneLocal(opts.keep);
    console.log(`[platform-backup] ${fileName}: ${(size / 1048576).toFixed(1)} MB, ${opts.trigger}`);
  } catch (err) {
    outcome.error = (err as Error).message;
    await fs.promises.unlink(partial).catch(() => {});
    await query(`UPDATE platform_backups SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [row.id, outcome.error]);
    console.error(`[platform-backup] ${fileName} failed: ${logSafe(outcome.error)}`);
  } finally {
    backupRunning = false;
  }

  const failedDest = outcome.destinations.filter((d) => !d.ok);
  if (!outcome.ok || failedDest.length) {
    const what = !outcome.ok
      ? `The ${opts.trigger} platform backup failed: ${outcome.error}`
      : `The ${opts.trigger} platform backup ${fileName} was made, but didn't reach ${failedDest.map((d) => `${d.name} (${d.error})`).join('; ')}`;
    await alertService.dispatch('platform_backup_failed', what, { cooldownKey: `platform_backup_failed:${opts.trigger}` });
  }
  return outcome;
}

/** Keep the newest `keep` scheduled/manual backups on this server, and the last few pre-restore ones. */
export async function pruneLocal(keep?: number): Promise<void> {
  const k = keep ?? (await getSchedule()).keep;
  const drop = await query<{ id: number; file_name: string }>(
    `SELECT id, file_name FROM (
       SELECT id, file_name, row_number() OVER (PARTITION BY (trigger = 'pre-restore') ORDER BY created_at DESC) AS n,
              trigger FROM platform_backups WHERE status = 'success'
     ) x WHERE (trigger <> 'pre-restore' AND n > $1) OR (trigger = 'pre-restore' AND n > $2)`, [Math.max(1, k), KEEP_PRE_RESTORE]);
  for (const b of drop) await deleteLocal(b.id, b.file_name);
}

export async function deleteLocal(id: number, fileName: string): Promise<void> {
  await fs.promises.unlink(path.join(LOCAL_DIR, path.basename(fileName))).catch(() => {});
  await query(`DELETE FROM platform_backups WHERE id = $1`, [id]);
}

/** Remove uploaded files that were never restored, after a day. */
async function pruneUploads(): Promise<void> {
  const names = await fs.promises.readdir(UPLOAD_DIR).catch(() => [] as string[]);
  const cutoff = Date.now() - 24 * 3600_000;
  for (const n of names) {
    const f = path.join(UPLOAD_DIR, path.basename(n));
    const st = await fs.promises.stat(f).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.promises.unlink(f).catch(() => {});
  }
}

/** Called every minute by the poller: run the schedule when it's due. */
export async function scheduleTick(timeZone: string): Promise<void> {
  if (isRestoring() || backupRunning) return;
  await pruneUploads();
  const s = await getSchedule();
  if (!s.enabled || !s.passphrase_encrypted) return;
  const now = new Date();
  if (!cronMatches(scheduleCron(s), now, timeZone)) return;
  // Once per scheduled minute, even if the tick comes twice.
  if (s.last_run_at && now.getTime() - new Date(s.last_run_at).getTime() < 90_000) return;
  await query(`UPDATE platform_backup_settings SET last_run_at = NOW() WHERE id = 1`);
  let passphrase: string;
  try { passphrase = decrypt(s.passphrase_encrypted); } catch {
    await alertService.dispatch('platform_backup_failed', 'The scheduled platform backup could not run: its saved passphrase could not be decrypted. Set it again in Settings → Backup & Restore.', { cooldownKey: 'platform_backup_failed:passphrase' });
    return;
  }
  await runBackup({ contents: s.contents, passphrase, trigger: 'scheduled', destinationIds: s.destination_ids, keep: s.keep })
    .catch((e) => console.error('[platform-backup] scheduled run failed:', logSafe((e as Error).message)));
}

// ─── Restoring ──────────────────────────────────────────────────────────────

/**
 * Restore in the background: pause the app, back up the current state with
 * the same passphrase, restore, then restart. Returns as soon as it has
 * started; restoreStatus() follows it.
 */
export async function startRestore(opts: {
  file: string; passphrase: string; mode: RestoreMode; userId?: number | null; deleteAfter?: boolean;
}): Promise<BackupHeader> {
  if (isRestoring()) throw new Error('A restore is already running.');
  if (backupRunning) throw new Error('A platform backup is running; try again when it has finished.');
  const { header } = await readHeader(opts.file);
  // Refuse what the engine would refuse, before pausing anything.
  if (opts.mode === 'full' && header.contents !== 'config+database') {
    throw new Error('This backup holds configuration only, so it can only be restored as configuration.');
  }
  if (!versionNotNewer(header.app_version, APP_VERSION)) {
    throw new Error(`This backup is from MikroTik Manager ${header.app_version}, newer than this one (${APP_VERSION}). Update first.`);
  }
  restoreState = { phase: 'pre-backup', message: 'Backing up the current state first', startedAt: new Date().toISOString() };
  void (async () => {
    try {
      const pre = await runBackup({
        contents: opts.mode === 'full' ? 'config+database' : 'config', passphrase: opts.passphrase,
        trigger: 'pre-restore', userId: opts.userId,
      });
      if (!pre.ok) throw new Error(`The backup of the current state failed, so nothing was restored: ${pre.error}`);
      restoreState = { ...restoreState, phase: 'restoring', message: 'Restoring' };
      const result = await restoreFromFile(opts.file, opts.passphrase, opts.mode, APP_VERSION,
        (m) => { restoreState = { ...restoreState, message: m }; });
      restoreState = { ...restoreState, phase: 'restarting', message: 'Restored. MikroTik Manager is restarting.', result };
      console.log(`[platform-backup] restored (${opts.mode}): ${result.tables} tables, ${result.rows} rows, ${result.reencrypted} credentials re-encrypted; restarting`);
      if (opts.deleteAfter) await fs.promises.unlink(opts.file).catch(() => {});
      // A moment for the status to be read, then a clean start: the container's
      // restart policy brings it back, migrations run, caches start empty.
      setTimeout(() => process.exit(0), 3000);
    } catch (err) {
      restoreState = { ...restoreState, phase: 'failed', message: 'The restore failed. Nothing was changed.', error: (err as Error).message };
      console.error('[platform-backup] restore failed:', logSafe((err as Error).message));
    }
  })();
  return header;
}

export function clearFailedRestore(): void {
  if (restoreState.phase === 'failed') restoreState = { phase: 'idle', message: '', startedAt: null };
}
