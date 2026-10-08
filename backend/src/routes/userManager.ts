/**
 * User Manager, RouterOS's RADIUS server, under Services (#251).
 *
 *   GET  /api/user-manager                      devices running it (in the active site)
 *   GET  /api/user-manager/:id                  a live read of one (no passwords or secrets)
 *   POST /api/user-manager/:id/sessions/:sid/remove   clear a stuck session
 *   POST /api/user-manager/recheck              look for it again on the next slow poll
 */
import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeDevices } from '../utils/siteScope';
import { deviceSiteAccess, deviceIdParam } from '../utils/siteAccess';
import { readUserManager, removeSession } from '../services/userManager';
import { isItemId } from '../utils/userManager';
import type { DeviceRow } from '../services/mikrotik/DeviceCollector';
import { RouterOSTrapError } from '../services/mikrotik/RouterOSClient';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  const scope = siteScopeDevices(activeSite(req));
  const servers = await query<{ id: number; name: string; ip_address: string; status: string; model: string | null }>(
    `SELECT id, name, ip_address, status, model FROM devices WHERE user_manager = TRUE ${scope ? `AND ${scope}` : ''} ORDER BY name`);
  const checked = await queryOne<{ unchecked: string; oldest: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE user_manager_checked_at IS NULL) AS unchecked, MIN(user_manager_checked_at) AS oldest
       FROM devices ${scope ? `WHERE ${scope}` : ''}`);
  res.json({
    servers: servers.map((s) => ({ ...s, name: s.name.trim() })),
    unchecked: Number(checked?.unchecked ?? 0),
    oldest_check: checked?.oldest ?? null,
  });
});

// Look again on the next slow poll: for a device where User Manager was just
// switched on, instead of waiting for the daily check.
router.post('/recheck', requireWrite, async (req: Request, res: Response) => {
  const scope = siteScopeDevices(activeSite(req));
  await query(`UPDATE devices SET user_manager_checked_at = NULL ${scope ? `WHERE ${scope}` : ''}`);
  res.json({ ok: true });
});

async function serverDevice(req: Request, res: Response): Promise<DeviceRow | null> {
  const d = await queryOne<DeviceRow & { user_manager: boolean | null }>(`SELECT * FROM devices WHERE id = $1`, [Number(req.params.id)]);
  if (!d || d.user_manager !== true) { res.status(404).json({ error: 'That device doesn’t run User Manager' }); return null; }
  return d;
}

router.get('/:id', deviceSiteAccess(deviceIdParam), async (req: Request, res: Response) => {
  const d = await serverDevice(req, res);
  if (!d) return;
  try {
    res.json({ device: { id: d.id, name: d.name.trim(), ip_address: d.ip_address }, ...(await readUserManager(d)) });
  } catch (e) {
    res.status(502).json({ error: `Couldn’t read User Manager on ${d.name.trim()}: ${(e as Error).message}` });
  }
});

router.post('/:id/sessions/:sid/remove', deviceSiteAccess(deviceIdParam), requireWrite, async (req: Request, res: Response) => {
  const sid = String(req.params.sid);
  if (!isItemId(sid)) return res.status(400).json({ error: 'That isn’t a session id' });
  const d = await serverDevice(req, res);
  if (!d) return;
  try {
    await removeSession(d, sid);
    res.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof RouterOSTrapError) return res.status(400).json({ error: `${d.name.trim()} refused: ${msg}` });
    res.status(502).json({ error: `Couldn’t reach ${d.name.trim()}: ${msg}` });
  }
});

export default router;
