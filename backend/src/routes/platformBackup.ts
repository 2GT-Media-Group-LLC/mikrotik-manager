/**
 * Settings → Backup & Restore: backups of MikroTik Manager itself. Fleet
 * admins only (a backup holds every device credential, under the passphrase).
 */
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { query, queryOne } from '../config/database';
import { redis } from '../config/redis';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { encrypt } from '../utils/crypto';
import { logSafe } from '../utils/logSafe';
import {
  APP_VERSION, MIN_PASSPHRASE, getSchedule, loadDestinations, runBackup, deleteLocal, pruneLocal,
  startRestore, restoreStatus, clearFailedRestore, isRestoring, isBackupRunning, sealSecrets, toDestination, pinHostKey,
} from '../services/platformBackup/service';
import { readHeader, unlock, WrongPassphraseError, type BackupContents } from '../services/platformBackup/format';
import { versionNotNewer } from '../services/platformBackup/engine';
import { compareWithFile } from '../services/platformBackup/compare';
import { LOCAL_DIR, UPLOAD_DIR, ensureLocalDir, testDestination, type DestinationType } from '../services/platformBackup/destinations';

const router = Router();
const MAX_UPLOAD = 20 * 1024 * 1024 * 1024;
const CONTENTS: BackupContents[] = ['config', 'config+database'];
const TYPES: DestinationType[] = ['s3', 'sftp', 'email'];

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

// ─── Without a session ──────────────────────────────────────────────────────

// GET /api/platform-backup/restore/progress — just the phase, for the page to
// follow a restore through the restart (the session may not survive it).
router.get('/restore/progress', (_req, res) => {
  const s = restoreStatus();
  res.json({ phase: s.phase, message: s.message });
});

// GET /api/platform-backup/download/:token — a one-time, 2-minute link made by
// an admin, so a large backup streams straight to disk instead of the browser.
router.get('/download/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  if (!/^[a-f0-9]{48}$/.test(token)) return fail(res, 404, 'Not found');
  const id = await redis.getdel(`platform-backup:dl:${token}`).catch(() => null);
  if (!id) return fail(res, 404, 'This download link has expired. Start the download again.');
  const b = await queryOne<{ file_name: string }>(`SELECT file_name FROM platform_backups WHERE id = $1 AND status = 'success'`, [id]);
  if (!b) return fail(res, 404, 'Not found');
  const file = path.join(LOCAL_DIR, path.basename(b.file_name));
  if (!fs.existsSync(file)) return fail(res, 404, 'The backup file is no longer on this server.');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(b.file_name)}"`);
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  fs.createReadStream(file).pipe(res);
});

router.use(requireAuth, requireAdmin);

// ─── Overview ───────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const s = await getSchedule();
  const { passphrase_encrypted: _p, ...schedule } = s;
  void _p;
  const destinations = (await loadDestinations()).map((d) => ({
    id: d.id, type: d.type, name: d.name, enabled: d.enabled, keep: d.keep, config: d.config,
    secrets_set: Object.keys(d.secrets),
  }));
  const backups = await query(
    `SELECT b.id, b.file_name, b.contents, b.trigger, b.status, b.size_bytes, b.app_version, b.error, b.destinations,
            b.created_at, b.finished_at, u.username AS created_by
       FROM platform_backups b LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC LIMIT 200`);
  const st = restoreStatus();
  res.json({ app_version: APP_VERSION, min_passphrase: MIN_PASSPHRASE, schedule, destinations, backups, restore: st });
});

// ─── Schedule ───────────────────────────────────────────────────────────────

router.put('/schedule', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return fail(res, 400, 'enabled must be true or false'); set('enabled', b.enabled); }
  if (b.frequency !== undefined) { if (!['daily', 'weekly', 'monthly'].includes(b.frequency)) return fail(res, 400, 'frequency must be daily, weekly or monthly'); set('frequency', b.frequency); }
  if (b.time_of_day !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time_of_day))) return fail(res, 400, 'time_of_day must be HH:MM'); set('time_of_day', b.time_of_day); }
  if (b.weekday !== undefined) { const n = Number(b.weekday); if (!Number.isInteger(n) || n < 0 || n > 6) return fail(res, 400, 'weekday must be 0 (Sunday) to 6'); set('weekday', n); }
  if (b.monthday !== undefined) { const n = Number(b.monthday); if (!Number.isInteger(n) || n < 1 || n > 28) return fail(res, 400, 'monthday must be 1 to 28'); set('monthday', n); }
  if (b.contents !== undefined) { if (!CONTENTS.includes(b.contents)) return fail(res, 400, 'contents must be config or config+database'); set('contents', b.contents); }
  if (b.keep !== undefined) { const n = Number(b.keep); if (!Number.isInteger(n) || n < 1 || n > 365) return fail(res, 400, 'keep must be 1 to 365'); set('keep', n); }
  if (b.destination_ids !== undefined) {
    if (!Array.isArray(b.destination_ids) || b.destination_ids.some((x: unknown) => !Number.isInteger(x))) return fail(res, 400, 'destination_ids must be a list of ids');
    set('destination_ids', b.destination_ids);
  }
  if (b.passphrase !== undefined) {
    if (typeof b.passphrase !== 'string' || b.passphrase.length < MIN_PASSPHRASE) return fail(res, 400, `The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
    set('passphrase_encrypted', encrypt(b.passphrase));
  }
  const current = await getSchedule();
  const enabling = b.enabled === true || (b.enabled === undefined && current.enabled);
  if (enabling && !current.has_passphrase && b.passphrase === undefined) {
    return fail(res, 400, 'Set a passphrase before turning the schedule on: scheduled backups are encrypted with it.');
  }
  if (sets.length) await query(`UPDATE platform_backup_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, vals);
  if (b.keep !== undefined) await pruneLocal(Number(b.keep));
  const { passphrase_encrypted: _p, ...schedule } = await getSchedule();
  void _p;
  res.json(schedule);
});

// ─── Backups ────────────────────────────────────────────────────────────────

// POST /backups { contents, passphrase? | use_saved_passphrase, destination_ids? } — runs in the background.
router.post('/backups', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!CONTENTS.includes(b.contents)) return fail(res, 400, 'contents must be config or config+database');
  let passphrase = typeof b.passphrase === 'string' ? b.passphrase : '';
  if (b.use_saved_passphrase === true) {
    const s = await getSchedule();
    if (!s.passphrase_encrypted) return fail(res, 400, 'No passphrase is saved. Enter one.');
    const { decrypt } = await import('../utils/crypto');
    passphrase = decrypt(s.passphrase_encrypted);
  }
  if (passphrase.length < MIN_PASSPHRASE) return fail(res, 400, `The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  const ids = Array.isArray(b.destination_ids) ? b.destination_ids.filter((x: unknown) => Number.isInteger(x)) : [];
  if (isRestoring()) return fail(res, 409, 'A restore is running.');
  if (isBackupRunning()) return fail(res, 409, 'A platform backup is already running. Try again when it has finished.');
  runBackup({ contents: b.contents, passphrase, trigger: 'manual', userId: req.user?.userId ?? null, destinationIds: ids })
    .catch((e) => console.error('[platform-backup] manual backup failed:', logSafe((e as Error).message)));
  res.status(202).json({ message: 'Backup started' });
});

router.delete('/backups/:id', async (req: Request, res: Response) => {
  const b = await queryOne<{ id: number; file_name: string; status: string }>(`SELECT id, file_name, status FROM platform_backups WHERE id = $1`, [req.params.id]);
  if (!b) return fail(res, 404, 'Not found');
  if (b.status === 'running') return fail(res, 409, 'That backup is still running.');
  await deleteLocal(b.id, b.file_name);
  res.json({ message: 'Deleted' });
});

router.post('/backups/:id/download-link', async (req: Request, res: Response) => {
  const b = await queryOne<{ id: number }>(`SELECT id FROM platform_backups WHERE id = $1 AND status = 'success'`, [req.params.id]);
  if (!b) return fail(res, 404, 'Not found');
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set(`platform-backup:dl:${token}`, String(b.id), 'EX', 120);
  res.json({ url: `/api/platform-backup/download/${token}` });
});

// ─── Upload, check, restore ─────────────────────────────────────────────────

// POST /upload — the raw file as the body (streamed to disk, up to 20 GB).
router.post('/upload', async (req: Request, res: Response) => {
  ensureLocalDir();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(UPLOAD_DIR, `${id}.mtmbackup`);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let size = 0;
  let tooBig = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_UPLOAD && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); }
  });
  req.pipe(out);
  out.on('error', () => {});
  await new Promise<void>((resolve) => { req.on('end', resolve); req.on('error', resolve); req.on('close', resolve); });
  await new Promise<void>((resolve) => (out.writableFinished || out.destroyed ? resolve() : out.on('finish', () => resolve())));
  if (tooBig) { await fs.promises.unlink(file).catch(() => {}); return fail(res, 413, 'The file is larger than 20 GB.'); }
  try {
    const { header } = await readHeader(file);
    res.json({ upload_id: id, header, size });
  } catch (err) {
    await fs.promises.unlink(file).catch(() => {});
    fail(res, 400, (err as Error).message);
  }
});

async function sourceFile(b: { backup_id?: unknown; upload_id?: unknown }): Promise<{ file: string; upload: boolean } | null> {
  if (b.upload_id !== undefined) {
    const id = String(b.upload_id);
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    const file = path.join(UPLOAD_DIR, `${id}.mtmbackup`);
    return fs.existsSync(file) ? { file, upload: true } : null;
  }
  const row = await queryOne<{ file_name: string }>(`SELECT file_name FROM platform_backups WHERE id = $1 AND status = 'success'`, [b.backup_id]);
  if (!row) return null;
  const file = path.join(LOCAL_DIR, path.basename(row.file_name));
  return fs.existsSync(file) ? { file, upload: false } : null;
}

// POST /check { backup_id | upload_id, passphrase } — is this passphrase right, and what's in it?
router.post('/check', async (req: Request, res: Response) => {
  const src = await sourceFile(req.body ?? {});
  if (!src) return fail(res, 404, 'Backup not found');
  try {
    const { header } = await readHeader(src.file);
    unlock(header, String(req.body?.passphrase ?? ''));
    res.json({ ok: true, header, restorable: versionNotNewer(header.app_version, APP_VERSION) });
  } catch (err) {
    fail(res, err instanceof WrongPassphraseError ? 400 : 422, (err as Error).message);
  }
});

// POST /compare { backup_id | upload_id, passphrase } — what a restore would change; reads only.
router.post('/compare', async (req: Request, res: Response) => {
  const src = await sourceFile(req.body ?? {});
  if (!src) return fail(res, 404, 'Backup not found');
  if (isRestoring()) return fail(res, 409, 'A restore is running.');
  try {
    const { header } = await readHeader(src.file);
    unlock(header, String(req.body?.passphrase ?? ''));
    res.json(await compareWithFile(src.file, String(req.body.passphrase)));
  } catch (err) {
    fail(res, err instanceof WrongPassphraseError ? 400 : 422, (err as Error).message);
  }
});

// POST /restore { backup_id | upload_id, passphrase, mode: config|full, confirm: "RESTORE" }
router.post('/restore', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (b.confirm !== 'RESTORE') return fail(res, 400, 'Type RESTORE to confirm.');
  if (!['config', 'full'].includes(b.mode)) return fail(res, 400, 'mode must be config or full');
  const src = await sourceFile(b);
  if (!src) return fail(res, 404, 'Backup not found');
  try {
    const { header } = await readHeader(src.file);
    unlock(header, String(b.passphrase ?? ''));
    await startRestore({ file: src.file, passphrase: String(b.passphrase), mode: b.mode, userId: req.user?.userId ?? null, deleteAfter: src.upload });
    console.log(`[platform-backup] restore (${b.mode}) started by ${logSafe(req.user?.username ?? '?')}`);
    res.status(202).json({ message: 'Restore started' });
  } catch (err) {
    fail(res, err instanceof WrongPassphraseError ? 400 : 409, (err as Error).message);
  }
});

router.post('/restore/clear', (_req, res) => { clearFailedRestore(); res.json(restoreStatus()); });

// ─── Destinations ───────────────────────────────────────────────────────────

function destinationInput(b: Record<string, unknown>, partial: boolean): { error: string } | {
  type?: DestinationType; name?: string; enabled?: boolean; keep?: number; config?: Record<string, unknown>; secrets?: Record<string, string>;
} {
  const out: { type?: DestinationType; name?: string; enabled?: boolean; keep?: number; config?: Record<string, unknown>; secrets?: Record<string, string> } = {};
  if (!partial || b.type !== undefined) {
    if (!TYPES.includes(b.type as DestinationType)) return { error: 'type must be s3, sftp or email' };
    out.type = b.type as DestinationType;
  }
  if (!partial || b.name !== undefined) {
    const n = String(b.name ?? '').trim();
    if (!n || n.length > 100) return { error: 'A name of up to 100 characters is needed' };
    out.name = n;
  }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' }; out.enabled = b.enabled; }
  if (b.keep !== undefined) { const n = Number(b.keep); if (!Number.isInteger(n) || n < 1 || n > 365) return { error: 'keep must be 1 to 365' }; out.keep = n; }
  if (b.config !== undefined) {
    if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) return { error: 'config must be an object' };
    const c = b.config as Record<string, unknown>;
    // Only known, non-secret settings are kept.
    const allowed = ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'pathStyle', 'host', 'port', 'username', 'directory', 'hostKey', 'channelId', 'recipients'];
    out.config = Object.fromEntries(Object.entries(c).filter(([k]) => allowed.includes(k)));
    if (out.config.endpoint !== undefined && !/^https?:\/\/[^\s/]+/.test(String(out.config.endpoint))) return { error: 'The endpoint must be a URL, e.g. https://s3.us-east-1.amazonaws.com' };
    if (out.config.port !== undefined && out.config.port !== '' && !(Number.isInteger(Number(out.config.port)) && Number(out.config.port) > 0 && Number(out.config.port) < 65536)) return { error: 'port must be 1 to 65535' };
    if (out.config.port !== undefined) out.config.port = out.config.port === '' ? undefined : Number(out.config.port);
    if (out.config.recipients !== undefined && !Array.isArray(out.config.recipients)) return { error: 'recipients must be a list' };
    if (out.config.channelId !== undefined) out.config.channelId = Number(out.config.channelId);
  }
  if (b.secrets !== undefined) {
    if (!b.secrets || typeof b.secrets !== 'object') return { error: 'secrets must be an object' };
    const allowed = ['secretAccessKey', 'password', 'privateKey', 'passphrase'];
    out.secrets = Object.fromEntries(Object.entries(b.secrets as Record<string, unknown>)
      .filter(([k, v]) => allowed.includes(k) && typeof v === 'string')) as Record<string, string>;
  }
  return out;
}

router.post('/destinations', async (req: Request, res: Response) => {
  const d = destinationInput(req.body ?? {}, false);
  if ('error' in d) return fail(res, 400, d.error);
  const row = await queryOne<{ id: number }>(
    `INSERT INTO platform_backup_destinations (type, name, enabled, keep, config, secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [d.type, d.name, d.enabled ?? true, d.keep ?? 14, JSON.stringify(d.config ?? {}), sealSecrets(d.secrets ?? {})]);
  res.status(201).json({ id: row!.id });
});

router.put('/destinations/:id', async (req: Request, res: Response) => {
  const cur = (await loadDestinations([Number(req.params.id)]))[0];
  if (!cur) return fail(res, 404, 'Not found');
  const d = destinationInput({ ...req.body, type: undefined }, true);
  if ('error' in d) return fail(res, 400, d.error);
  // A secret left empty keeps the saved one; changing the host forgets its pinned key.
  const secrets = { ...cur.secrets, ...Object.fromEntries(Object.entries(d.secrets ?? {}).filter(([, v]) => v !== '')) };
  const config = { ...cur.config, ...(d.config ?? {}) };
  if (cur.type === 'sftp' && d.config && (d.config.host !== undefined && d.config.host !== cur.config.host)) config.hostKey = null;
  await query(
    `UPDATE platform_backup_destinations SET name = $2, enabled = $3, keep = $4, config = $5, secret_encrypted = $6, updated_at = NOW() WHERE id = $1`,
    [cur.id, d.name ?? cur.name, d.enabled ?? cur.enabled, d.keep ?? cur.keep, JSON.stringify(config), sealSecrets(secrets)]);
  res.json({ message: 'Saved' });
});

router.delete('/destinations/:id', async (req: Request, res: Response) => {
  await query(`DELETE FROM platform_backup_destinations WHERE id = $1`, [req.params.id]);
  await query(`UPDATE platform_backup_settings SET destination_ids = array_remove(destination_ids, $1::int) WHERE id = 1`, [req.params.id]);
  res.json({ message: 'Deleted' });
});

router.post('/destinations/:id/test', async (req: Request, res: Response) => {
  const row = await queryOne<Parameters<typeof toDestination>[0]>(`SELECT * FROM platform_backup_destinations WHERE id = $1`, [req.params.id]);
  if (!row) return fail(res, 404, 'Not found');
  try {
    const r = await testDestination(toDestination(row));
    await pinHostKey(row.id, r.hostKey);
    res.json({ ok: true, message: r.message, host_key: r.hostKey ?? null });
  } catch (err) {
    res.status(422).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
