import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import { firmwareOrchestrator } from '../services/FirmwareOrchestrator';

const router = Router();
router.use(requireAuth);

// GET /api/firmware/overview — fleet versions + latest rollout
router.get('/overview', async (_req: Request, res: Response) => {
  const [devices, latestRollout] = await Promise.all([
    query(`SELECT id, name, device_type, status, model, ros_version, latest_ros_version,
                  firmware_update_available, firmware_version, upgrade_firmware_version,
                  routerboard_upgrade_available
           FROM devices ORDER BY name ASC`),
    queryOne<{ id: number }>(`SELECT id FROM firmware_rollouts ORDER BY created_at DESC LIMIT 1`),
  ]);
  res.json({
    devices,
    latestRolloutId: latestRollout?.id ?? null,
    runningRolloutId: firmwareOrchestrator.running,
  });
});

// POST /api/firmware/check-all — refresh update availability on all online devices
router.post('/check-all', requireWrite, async (_req: Request, res: Response) => {
  const devices = await query<DeviceRow>(`SELECT * FROM devices WHERE status='online'`);
  const settled = await Promise.allSettled(devices.map(async (d) => {
    const c = new DeviceCollector(d);
    try {
      await c.connect();
      const s = await c.checkForUpdates();
      const installed = (s['installed-version'] || '').trim();
      const latest = (s['latest-version'] || '').trim();
      const available = !!latest && latest !== installed;
      await query(
        `UPDATE devices SET ros_version=COALESCE(NULLIF($2,''), ros_version),
                latest_ros_version=NULLIF($3,''), firmware_update_available=$4 WHERE id=$1`,
        [d.id, installed, latest, available]);
      return { name: d.name, installed, latest, available };
    } finally { c.disconnect(); }
  }));
  res.json({
    results: settled.map((s, i) => s.status === 'fulfilled'
      ? { ...s.value, ok: true }
      : { name: devices[i].name, ok: false, error: (s.reason as Error)?.message }),
  });
});

// POST /api/firmware/rollouts — create a rollout (optionally scheduled)
router.post('/rollouts', requireWrite, async (req: Request, res: Response) => {
  const { name, halt_on_failure, pre_backup, routerboot_after, scheduled_at, devices, start } = req.body as {
    name?: string; halt_on_failure?: boolean; pre_backup?: boolean; routerboot_after?: boolean; scheduled_at?: string | null;
    devices?: { device_id: number; wave: number }[]; start?: boolean;
  };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!Array.isArray(devices) || devices.length === 0) return res.status(400).json({ error: 'devices array is required' });
  for (const d of devices) {
    if (!Number.isInteger(d.device_id) || !Number.isInteger(d.wave) || d.wave < 1 || d.wave > 9) {
      return res.status(400).json({ error: 'each device needs device_id and wave (1-9)' });
    }
  }
  if (scheduled_at && isNaN(Date.parse(scheduled_at))) return res.status(400).json({ error: 'scheduled_at must be a valid timestamp' });

  const rollout = await queryOne<{ id: number }>(
    `INSERT INTO firmware_rollouts (name, halt_on_failure, pre_backup, routerboot_after, scheduled_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name.trim().slice(0, 100), halt_on_failure !== false, pre_backup !== false, routerboot_after === true, scheduled_at || null]);
  for (const d of devices) {
    await query(
      `INSERT INTO firmware_rollout_devices (rollout_id, device_id, wave) VALUES ($1,$2,$3)`,
      [rollout!.id, d.device_id, d.wave]);
  }

  if (start && !scheduled_at) {
    try { await firmwareOrchestrator.start(rollout!.id); }
    catch (e) { return res.status(409).json({ error: (e as Error).message, id: rollout!.id }); }
  }
  res.status(201).json({ id: rollout!.id });
});

// GET /api/firmware/rollouts — recent rollouts with progress counts
router.get('/rollouts', async (_req: Request, res: Response) => {
  const rows = await query(`
    SELECT r.*,
           COUNT(d.id)::int AS device_count,
           COUNT(d.id) FILTER (WHERE d.status = 'success')::int AS success_count,
           COUNT(d.id) FILTER (WHERE d.status = 'failed')::int  AS failed_count
    FROM firmware_rollouts r
    LEFT JOIN firmware_rollout_devices d ON d.rollout_id = r.id
    GROUP BY r.id ORDER BY r.created_at DESC LIMIT 20`);
  res.json(rows);
});

// GET /api/firmware/rollouts/:id — full rollout detail
router.get('/rollouts/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const [rollout, devices] = await Promise.all([
    queryOne(`SELECT * FROM firmware_rollouts WHERE id=$1`, [id]),
    query(`
      SELECT rd.*, dev.name AS device_name, dev.device_type, dev.model
      FROM firmware_rollout_devices rd JOIN devices dev ON dev.id = rd.device_id
      WHERE rd.rollout_id = $1 ORDER BY rd.wave ASC, rd.id ASC`, [id]),
  ]);
  if (!rollout) return res.status(404).json({ error: 'Rollout not found' });
  res.json({ ...rollout, devices });
});

// POST /api/firmware/rollouts/:id/start
router.post('/rollouts/:id/start', requireWrite, async (req: Request, res: Response) => {
  try {
    await firmwareOrchestrator.start(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// GET /api/firmware/changelog/:version — proxy MikroTik's per-version release
// notes (download.mikrotik.com/routeros/<ver>/CHANGELOG) so the UI can show
// "what's new" without a CORS-blocked cross-origin fetch. Released changelogs
// are immutable, so successful fetches are cached for the process lifetime.
const changelogCache = new Map<string, string>();
const CHANGELOG_CACHE_MAX = 100;

router.get('/changelog/:version', async (req: Request, res: Response) => {
  const version = String(req.params.version).trim();
  // RouterOS versions: 7.23.1, 7.16, 6.49.10, plus rc/beta suffixes (7.20rc3)
  if (!/^\d+\.\d+(\.\d+)?(rc\d+|beta\d+)?$/i.test(version)) {
    return res.status(400).json({ error: 'Invalid RouterOS version' });
  }
  const url = `https://download.mikrotik.com/routeros/${version}/CHANGELOG`;

  const cached = changelogCache.get(version);
  if (cached) return res.json({ version, url, text: cached });

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      return res.status(404).json({ error: `No changelog found for ${version}`, url });
    }
    const text = await resp.text();
    if (changelogCache.size >= CHANGELOG_CACHE_MAX) changelogCache.clear();
    changelogCache.set(version, text);
    res.json({ version, url, text });
  } catch {
    res.status(502).json({ error: 'Could not reach the MikroTik changelog server', url });
  }
});

// POST /api/firmware/rollouts/:id/cancel — stops before the next device (an
// in-flight upgrade is never interrupted mid-write)
router.post('/rollouts/:id/cancel', requireWrite, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const rollout = await queryOne<{ status: string }>(`SELECT status FROM firmware_rollouts WHERE id=$1`, [id]);
  if (!rollout) return res.status(404).json({ error: 'Rollout not found' });
  if (rollout.status === 'pending') {
    await query(`UPDATE firmware_rollouts SET status='cancelled', finished_at=NOW() WHERE id=$1`, [id]);
    await query(`UPDATE firmware_rollout_devices SET status='skipped', error='Rollout cancelled' WHERE rollout_id=$1 AND status='pending'`, [id]);
    return res.json({ ok: true });
  }
  firmwareOrchestrator.cancel(id);
  res.json({ ok: true, note: 'Cancelling after the in-flight device finishes' });
});

export default router;
