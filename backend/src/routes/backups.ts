import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { BackupService } from '../services/BackupService';

const router = Router();
router.use(requireAuth);

const backupService = new BackupService();

/** Preview reads the file into memory, so it needs a ceiling. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** A bulk delete is irreversible; keep one click from reaching an unbounded set. */
const MAX_BULK_DELETE = 200;

// GET /api/backups — filter by device, type, date range and free text (#134)
router.get('/', async (req: Request, res: Response) => {
  const { deviceId, type, from, to, search } = req.query as Record<string, string | undefined>;

  const filters: string[] = [];
  const params: unknown[] = [];
  /**
   * Bind a value and return its placeholder.
   *
   * Derived from params.length rather than a hand-kept counter: with a counter,
   * the last filter's increment is dead and whoever adds the next one inherits a
   * stale index. This cannot get out of step.
   */
  const bind = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (deviceId) filters.push(`b.device_id = ${bind(deviceId)}`);
  if (type)     filters.push(`b.backup_type = ${bind(type)}`);
  // Dates are inclusive at both ends: a picker showing "to: 3 Sep" should include
  // everything that happened on the 3rd, not stop at its first instant.
  if (from)     filters.push(`b.created_at >= ${bind(from)}`);
  if (to)       filters.push(`b.created_at < (${bind(to)}::date + INTERVAL '1 day')`);
  if (search) {
    const p = bind(`%${search}%`);
    filters.push(`(b.filename ILIKE ${p} OR b.notes ILIKE ${p} OR d.name ILIKE ${p})`);
  }

  const siteFilter = siteScopeByDevice(activeSite(req), 'b.device_id');
  if (siteFilter) filters.push(siteFilter);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const backups = await query(
    `SELECT b.*, d.name as device_name
       FROM backups b JOIN devices d ON d.id = b.device_id
       ${where}
      ORDER BY b.created_at DESC`,
    params
  );
  res.json(backups);
});

// GET /api/backups/types — the backup types actually present, for the filter
router.get('/types', async (req: Request, res: Response) => {
  const siteFilter = siteScopeByDevice(activeSite(req), 'b.device_id');
  const rows = await query<{ backup_type: string; n: string }>(
    `SELECT b.backup_type, COUNT(*)::text AS n
       FROM backups b
       ${siteFilter ? `WHERE ${siteFilter}` : ''}
      GROUP BY b.backup_type ORDER BY b.backup_type`
  );
  res.json(rows.map((r) => ({ type: r.backup_type, count: parseInt(r.n, 10) })));
});

/**
 * POST /api/backups/bulk-delete
 *
 * Deleting a backup cascades to the config snapshot that shares it — they are
 * deliberately one artifact so they cannot drift apart. Doing that fifty times
 * from one click deserves to say so, so the count of snapshots that will go with
 * them is reported here and shown in the confirmation.
 */
router.post('/bulk-delete', requireWrite, async (req: Request, res: Response) => {
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  const clean = ids.map((v) => parseInt(String(v), 10)).filter(Number.isInteger);
  if (clean.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (clean.length > MAX_BULK_DELETE) {
    return res.status(400).json({ error: `Cannot delete more than ${MAX_BULK_DELETE} backups at once` });
  }

  // Only ever touch backups in the active site, so a bulk action cannot reach
  // across into another site's history.
  const siteFilter = siteScopeByDevice(activeSite(req), 'device_id');
  const allowed = await query<{ id: number }>(
    `SELECT id FROM backups WHERE id = ANY($1::int[]) ${siteFilter ? `AND ${siteFilter}` : ''}`,
    [clean]
  );
  const allowedIds = allowed.map((r) => r.id);
  if (allowedIds.length === 0) return res.status(404).json({ error: 'No matching backups' });

  let deleted = 0;
  const failures: { id: number; error: string }[] = [];
  for (const id of allowedIds) {
    try { await backupService.deleteBackup(id); deleted++; }
    catch (e) { failures.push({ id, error: (e as Error).message }); }
  }
  return res.json({ deleted, requested: clean.length, failures });
});

// GET /api/backups/bulk-delete/preview?ids=1,2,3 — what a bulk delete would remove
router.get('/bulk-delete/preview', async (req: Request, res: Response) => {
  const ids = String(req.query.ids || '')
    .split(',').map((v) => parseInt(v, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.json({ backups: 0, snapshots: 0, devices: [] });

  const siteFilter = siteScopeByDevice(activeSite(req), 'b.device_id');
  const rows = await query<{ n: string; snapshots: string }>(
    `SELECT COUNT(*)::text AS n,
            COUNT(dc.id)::text AS snapshots
       FROM backups b
       LEFT JOIN device_configs dc ON dc.backup_id = b.id
      WHERE b.id = ANY($1::int[]) ${siteFilter ? `AND ${siteFilter}` : ''}`,
    [ids]
  );
  const devices = await query<{ name: string; n: string }>(
    `SELECT d.name, COUNT(*)::text AS n
       FROM backups b JOIN devices d ON d.id = b.device_id
      WHERE b.id = ANY($1::int[]) ${siteFilter ? `AND ${siteFilter}` : ''}
      GROUP BY d.name ORDER BY d.name`,
    [ids]
  );
  return res.json({
    backups: parseInt(rows[0]?.n || '0', 10),
    snapshots: parseInt(rows[0]?.snapshots || '0', 10),
    devices: devices.map((d) => ({ name: d.name, count: parseInt(d.n, 10) })),
  });
});

// POST /api/backups
router.post('/', requireWrite, async (req: Request, res: Response) => {
  const { deviceId, notes } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  const device = await queryOne<any>(
    `SELECT id, name, ip_address, ssh_port, ssh_username, ssh_password_encrypted,
            api_username, api_password_encrypted
     FROM devices WHERE id = $1`,
    [deviceId]
  );
  if (!device) return res.status(404).json({ error: 'Device not found' });

  try {
    const backupId = await backupService.createBackup(device, notes);
    const backup = await queryOne(`SELECT * FROM backups WHERE id = $1`, [backupId]);
    return res.status(201).json(backup);
  } catch (err) {
    return res.status(500).json({ error: `Backup failed: ${(err as Error).message}` });
  }
});

// GET /api/backups/:id/download
router.get('/:id/download', async (req: Request, res: Response) => {
  const backup = await queryOne<{ file_path: string; filename: string }>(
    `SELECT file_path, filename FROM backups WHERE id = $1`,
    [req.params.id]
  );
  if (!backup) return res.status(404).json({ error: 'Backup not found' });
  if (!fs.existsSync(backup.file_path)) {
    return res.status(404).json({ error: 'Backup file not found on disk' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);
  res.setHeader('Content-Type', 'text/plain');
  return res.sendFile(path.resolve(backup.file_path));
});

// POST /api/backups/:id/restore
router.post('/:id/restore', requireWrite, async (req: Request, res: Response) => {
  const backup = await queryOne(`SELECT id FROM backups WHERE id = $1`, [req.params.id]);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  try {
    await backupService.restoreBackup(parseInt(req.params.id));
    return res.json({ message: 'Restore initiated successfully' });
  } catch (err) {
    return res.status(500).json({ error: `Restore failed: ${(err as Error).message}` });
  }
});

// DELETE /api/backups/:id
router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
  const backup = await queryOne(`SELECT id FROM backups WHERE id = $1`, [req.params.id]);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  await backupService.deleteBackup(parseInt(req.params.id));
  return res.json({ message: 'Backup deleted' });
});

/**
 * Read a backup's text.
 *
 * Backups are `/export compact` output, i.e. plain RouterOS script — not the
 * binary `.backup` blob — so they can be read in place instead of downloaded
 * and opened elsewhere (#134).
 */
async function readBackupText(id: string | number): Promise<
  { meta: BackupMeta; text: string } | { error: string; status: number }
> {
  const meta = await queryOne<BackupMeta>(
    `SELECT b.id, b.filename, b.size_bytes, b.backup_type, b.notes, b.created_at,
            b.file_path, b.device_id, d.name AS device_name
       FROM backups b JOIN devices d ON d.id = b.device_id
      WHERE b.id = $1`,
    [id]
  );
  if (!meta) return { error: 'Backup not found', status: 404 };

  // Open once, then stat and read *that handle*.
  //
  // Checking existence, then size, then reading re-resolves the path three
  // times, and the file can change or vanish between them: a delete landing
  // mid-sequence turned a clean 404 into an unhandled throw
  // (CodeQL js/file-system-race). One handle means the size that was checked
  // and the bytes that were read are the same file.
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(meta.file_path, 'r');
  } catch {
    return { error: 'Backup file not found on disk', status: 404 };
  }
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_PREVIEW_BYTES) {
      return {
        error: `This backup is ${Math.round(stat.size / 1024)} KB, too large to preview. Download it instead.`,
        status: 413,
      };
    }
    return { meta, text: await handle.readFile('utf8') };
  } catch (e) {
    return { error: `Could not read the backup file: ${(e as Error).message}`, status: 500 };
  } finally {
    await handle.close().catch(() => {});
  }
}

interface BackupMeta {
  id: number;
  filename: string;
  size_bytes: number | null;
  backup_type: string | null;
  notes: string | null;
  created_at: string;
  file_path: string;
  device_id: number;
  device_name: string;
}

// GET /api/backups/:id/content — preview in place
router.get('/:id/content', async (req: Request, res: Response) => {
  const result = await readBackupText(req.params.id);
  if ('error' in result) return res.status(result.status).json({ error: result.error });
  const { file_path: _omit, ...meta } = result.meta;
  return res.json({ ...meta, content: result.text });
});

// GET /api/backups/:fromId/diff/:toId — compare two backups
// Mirrors the config-history diff contract: both texts are returned and the
// browser renders them with the same lineDiff used for config snapshots.
router.get('/:fromId/diff/:toId', async (req: Request, res: Response) => {
  const [from, to] = await Promise.all([
    readBackupText(req.params.fromId),
    readBackupText(req.params.toId),
  ]);
  for (const r of [from, to]) {
    if ('error' in r) return res.status(r.status).json({ error: r.error });
  }
  const f = from as { meta: BackupMeta; text: string };
  const t = to as { meta: BackupMeta; text: string };
  return res.json({
    from: { id: f.meta.id, filename: f.meta.filename, device_name: f.meta.device_name,
            created_at: f.meta.created_at, text: f.text },
    to:   { id: t.meta.id, filename: t.meta.filename, device_name: t.meta.device_name,
            created_at: t.meta.created_at, text: t.text },
  });
});

export default router;
