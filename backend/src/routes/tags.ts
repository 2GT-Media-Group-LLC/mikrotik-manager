import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite, requireAdmin } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /api/tags — list all tags with device count
router.get('/', async (_req: Request, res: Response) => {
  const tags = await query<{ id: number; name: string; color: string; device_count: string }>(
    `SELECT t.id, t.name, t.color, COUNT(dt.device_id)::text AS device_count
     FROM tags t
     LEFT JOIN device_tags dt ON dt.tag_id = t.id
     GROUP BY t.id ORDER BY t.name`
  );
  res.json(tags.map(t => ({ ...t, device_count: parseInt(t.device_count, 10) })));
});

// POST /api/tags — create tag (admin only)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { name, color } = req.body as { name: string; color?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'Tag name is required' }); return; }
  const rows = await query<{ id: number; name: string; color: string }>(
    `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id, name, color`,
    [name.trim(), color || '#6366f1']
  );
  res.status(201).json(rows[0]);
});

// PUT /api/tags/:id — rename or recolor (admin only)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  const { name, color } = req.body as { name?: string; color?: string };
  const rows = await query<{ id: number; name: string; color: string }>(
    `UPDATE tags SET
       name  = COALESCE($1, name),
       color = COALESCE($2, color)
     WHERE id = $3 RETURNING id, name, color`,
    [name?.trim() || null, color || null, req.params.id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Tag not found' }); return; }
  res.json(rows[0]);
});

// DELETE /api/tags/:id (admin only)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  await query(`DELETE FROM tags WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/tags/:id/devices — assign tag to devices (operator+)
router.post('/:id/devices', requireWrite, async (req: Request, res: Response) => {
  const tagId = parseInt(req.params.id, 10);
  const { deviceIds, action } = req.body as { deviceIds: unknown; action: 'add' | 'remove' };
  const ids = Array.isArray(deviceIds) ? deviceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'deviceIds array required' });
    return;
  }
  const tag = await query(`SELECT id FROM tags WHERE id = $1`, [tagId]);
  if (!tag.length) {
    res.status(404).json({ error: 'Tag not found' });
    return;
  }
  // One statement either way. Used for bulk tagging from the Devices page
  // (#161), where a selection can be hundreds of devices.
  const changed = action === 'remove'
    ? await query(
        `DELETE FROM device_tags WHERE tag_id = $1 AND device_id = ANY($2::int[]) RETURNING device_id`,
        [tagId, ids])
    : await query(
        `INSERT INTO device_tags (device_id, tag_id)
         SELECT d.id, $1 FROM devices d WHERE d.id = ANY($2::int[])
         ON CONFLICT DO NOTHING RETURNING device_id`,
        [tagId, ids]);
  res.json({ ok: true, changed: changed.length });
});

// GET /api/tags/device/:deviceId — tags for a specific device
router.get('/device/:deviceId', async (req: Request, res: Response) => {
  const tags = await query<{ id: number; name: string; color: string }>(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN device_tags dt ON dt.tag_id = t.id
     WHERE dt.device_id = $1 ORDER BY t.name`,
    [req.params.deviceId]
  );
  res.json(tags);
});

export default router;
