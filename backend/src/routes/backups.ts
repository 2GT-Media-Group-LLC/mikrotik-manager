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

// GET /api/backups
router.get('/', async (req: Request, res: Response) => {
  const { deviceId } = req.query;
  let sql = `
    SELECT b.*, d.name as device_name
    FROM backups b JOIN devices d ON d.id = b.device_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (deviceId) {
    sql += ` AND b.device_id = $1`;
    params.push(deviceId);
  }
  const siteFilter = siteScopeByDevice(activeSite(req), 'b.device_id');
  if (siteFilter) sql += ` AND ${siteFilter}`;
  sql += ' ORDER BY b.created_at DESC';

  const backups = await query(sql, params);
  res.json(backups);
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

export default router;
