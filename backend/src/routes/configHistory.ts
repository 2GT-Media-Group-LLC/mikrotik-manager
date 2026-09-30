import { Router, Request, Response } from 'express';
import { deviceSiteAccess, deviceIdParam } from '../utils/siteAccess';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { BackupService, describeRestore } from '../services/BackupService';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';

const router = Router();
router.use(requireAuth);
// Every route starts with the device id; a site-scoped account only reaches its own sites' devices (P1-7).
router.use(deviceSiteAccess(deviceIdParam));

const backupService = new BackupService();

const SECTIONS = ['interfaces', 'vlans', 'routes', 'firewall', 'dhcp', 'dns'] as const;

interface SnapshotRow {
  id: number;
  device_id: number;
  config_json: Record<string, unknown[]>;
  config_text: string | null;
  config_hash: string | null;
  change_summary: string | null;
  backup_id: number | null;
  collected_at: string;
  contains_secrets: boolean | null;
}

/**
 * Snapshots taken from RouterOS v6 before hide-sensitive was used can hold
 * passwords and keys, so only admins may read them, as with secret backups.
 */
const SECRET_SNAPSHOT_MESSAGE =
  'This snapshot was taken from a RouterOS v6 device before passwords were left out, so it may contain them. Only admins can view it.';

function mayRead(req: Request, row: { contains_secrets: boolean | null }): boolean {
  return !row.contains_secrets || req.user?.role === 'admin';
}

/**
 * The .rsc text for a snapshot. New snapshots store it in `config_text`; legacy
 * snapshots (captured before the export-based rewrite) only have the old
 * section JSON, which we render to a readable form so old↔new diffs still work.
 */
function snapshotText(row: { config_text: string | null; config_json: Record<string, unknown[]> | null }): string {
  if (row.config_text) return row.config_text;
  const cfg = row.config_json || {};
  const parts: string[] = ['# (legacy snapshot — reconstructed from collected data)'];
  for (const name of SECTIONS) {
    parts.push(`# ${name}`, JSON.stringify(cfg[name] ?? [], null, 2), '');
  }
  return parts.join('\n');
}

// GET /api/config-history/:deviceId — list snapshots (metadata only, no full payload)
router.get('/:deviceId', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, device_id, config_hash, change_summary, backup_id, collected_at,
            (backup_id IS NOT NULL) AS has_backup, COALESCE(contains_secrets, false) AS contains_secrets
     FROM device_configs
     WHERE device_id = $1
     ORDER BY collected_at DESC`,
    [req.params.deviceId]
  );
  res.json(rows);
});

// GET /api/config-history/:deviceId/:id — full config for a single snapshot
router.get('/:deviceId/:id', async (req: Request, res: Response) => {
  const row = await queryOne<SnapshotRow>(
    `SELECT id, device_id, config_json, config_text, config_hash, change_summary, backup_id, collected_at, contains_secrets
     FROM device_configs WHERE id = $1 AND device_id = $2`,
    [req.params.id, req.params.deviceId]
  );
  if (!row) return res.status(404).json({ error: 'Snapshot not found' });
  if (!mayRead(req, row)) return res.status(403).json({ error: SECRET_SNAPSHOT_MESSAGE });
  return res.json({ ...row, text: snapshotText(row) });
});

// GET /api/config-history/:deviceId/:fromId/diff/:toId — both snapshots' .rsc text
router.get('/:deviceId/:fromId/diff/:toId', async (req: Request, res: Response) => {
  const [from, to] = await Promise.all([
    queryOne<SnapshotRow>(
      `SELECT id, config_text, config_json, change_summary, collected_at, contains_secrets FROM device_configs WHERE id = $1 AND device_id = $2`,
      [req.params.fromId, req.params.deviceId]
    ),
    queryOne<SnapshotRow>(
      `SELECT id, config_text, config_json, change_summary, collected_at, contains_secrets FROM device_configs WHERE id = $1 AND device_id = $2`,
      [req.params.toId, req.params.deviceId]
    ),
  ]);
  if (!from || !to) return res.status(404).json({ error: 'Snapshot not found' });
  if (!mayRead(req, from) || !mayRead(req, to)) return res.status(403).json({ error: SECRET_SNAPSHOT_MESSAGE });

  return res.json({
    from: { id: from.id, text: snapshotText(from), collected_at: from.collected_at },
    to: { id: to.id, text: snapshotText(to), collected_at: to.collected_at },
  });
});

// POST /api/config-history/:deviceId/capture — capture a fresh snapshot on demand
router.post('/:deviceId/capture', requireWrite, async (req: Request, res: Response) => {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.deviceId]);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const collector = new DeviceCollector(device);
  try {
    await collector.connect();
    const created = await collector.snapshotConfig('manual');
    const latest = await queryOne(
      `SELECT id, config_hash, change_summary, backup_id, collected_at,
              (backup_id IS NOT NULL) AS has_backup
       FROM device_configs WHERE device_id = $1 ORDER BY collected_at DESC LIMIT 1`,
      [device.id]
    );
    return res.json({
      created,
      message: created
        ? 'Snapshot captured'
        : 'No configuration changes since the last snapshot',
      snapshot: latest,
    });
  } catch (err) {
    return res.status(500).json({ error: `Capture failed: ${(err as Error).message}` });
  } finally {
    collector.disconnect();
  }
});

// POST /api/config-history/:deviceId/:id/rollback — restore the .rsc backup linked to this snapshot
router.post('/:deviceId/:id/rollback', requireWrite, async (req: Request, res: Response) => {
  const snap = await queryOne<{ backup_id: number | null }>(
    `SELECT backup_id FROM device_configs WHERE id = $1 AND device_id = $2`,
    [req.params.id, req.params.deviceId]
  );
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  if (!snap.backup_id) {
    return res.status(400).json({ error: 'No restorable backup is linked to this snapshot' });
  }

  try {
    const outcome = await backupService.restoreBackup(snap.backup_id, { userId: req.user?.userId ?? null });
    const message = describeRestore(outcome);
    // Only a complete (or self-reverting) restore is a success; the UI shows the
    // message either way, and a partial one says exactly where it stopped.
    const ok = outcome.status === 'applied' || outcome.status === 'reverting';
    return res.status(ok ? 200 : 422).json({ ...outcome, message, ...(ok ? {} : { error: message }) });
  } catch (err) {
    return res.status(500).json({ error: `Rollback failed: ${(err as Error).message}` });
  }
});

// DELETE /api/config-history/:deviceId/:id — delete a snapshot and its linked backup
router.delete('/:deviceId/:id', requireWrite, async (req: Request, res: Response) => {
  const snap = await queryOne<{ id: number; backup_id: number | null }>(
    `SELECT id, backup_id FROM device_configs WHERE id = $1 AND device_id = $2`,
    [req.params.id, req.params.deviceId]
  );
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  if (snap.backup_id) {
    await backupService.deleteBackup(snap.backup_id).catch(() => { /* best-effort */ });
  }
  await query(`DELETE FROM device_configs WHERE id = $1`, [snap.id]);
  return res.json({ message: 'Snapshot deleted' });
});

export default router;
