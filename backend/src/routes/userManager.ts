/**
 * User Manager, RouterOS's RADIUS server, under Services (#251).
 *
 *   GET  /api/user-manager                      devices running it (in the active site)
 *   GET  /api/user-manager/:id                  a live read of one (no passwords or secrets)
 *   POST /api/user-manager/:id/sessions/:sid/remove   clear a stuck session
 *   POST /api/user-manager/recheck              look for it again on the next slow poll
 *   POST|PUT|DELETE /api/user-manager/:id/users[/:uid]   users, with a VLAN for 802.1X (#360)
 *   POST /api/user-manager/:id/link-dot1x        a switch's 802.1X authenticates here (#360)
 */
import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite, requireSiteAdmin, isSiteScoped } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeDevices } from '../utils/siteScope';
import { deviceSiteAccess, deviceIdParam, guardIdParams, devicesDenied, strictId } from '../utils/siteAccess';
import { readUserManager, removeSession, saveUser, removeUser, upsertRouter } from '../services/userManager';
import { isItemId, parseUmUser } from '../utils/userManager';
import { isSealed } from '../utils/sealed';
import { withVlanAttributes, newSharedSecret } from '../utils/dot1xEdit';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import { randomBytes } from 'crypto';
import net from 'net';
import type { DeviceRow } from '../services/mikrotik/DeviceCollector';
import { RouterOSTrapError } from '../services/mikrotik/RouterOSClient';

const router = Router();
router.use(requireAuth);
// Ids are plain numbers, read the same way by the site check and the handler (GHSA-j9x4-qwcj-p8v8).
guardIdParams(router, ['id'], 'Device not found');

router.get('/', async (req, res) => {
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
router.post('/recheck', requireWrite, async (req, res) => {
  const scope = siteScopeDevices(activeSite(req));
  await query(`UPDATE devices SET user_manager_checked_at = NULL ${scope ? `WHERE ${scope}` : ''}`);
  res.json({ ok: true });
});

async function serverDevice(req: Request, res: Response): Promise<DeviceRow | null> {
  const d = await queryOne<DeviceRow & { user_manager: boolean | null }>(`SELECT * FROM devices WHERE id = $1`, [Number(req.params.id)]);
  if (!d || d.user_manager !== true) { res.status(404).json({ error: 'That device doesn’t run User Manager' }); return null; }
  return d;
}

router.get('/:id', deviceSiteAccess(deviceIdParam), async (req, res) => {
  const d = await serverDevice(req, res);
  if (!d) return;
  try {
    res.json({ device: { id: d.id, name: d.name.trim(), ip_address: d.ip_address }, ...(await readUserManager(d)) });
  } catch (e) {
    res.status(502).json({ error: `Couldn’t read User Manager on ${d.name.trim()}: ${(e as Error).message}` });
  }
});

router.post('/:id/sessions/:sid/remove', deviceSiteAccess(deviceIdParam), requireWrite, async (req, res) => {
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

// ─── Users and 802.1X (#360) ─────────────────────────────────────────────────
// A User Manager user can be what a firewall or switch grants admin on, so
// writing users is for admins of the server's site.

function sendWriteError(res: Response, d: DeviceRow, e: unknown) {
  const msg = (e as Error).message;
  if (e instanceof RouterOSTrapError) return res.status(400).json({ error: `${d.name.trim()} refused: ${msg}` });
  return res.status(502).json({ error: `Couldn’t reach ${d.name.trim()}: ${msg}` });
}

const userOpts = { isSealed, withVlanAttributes };

router.post('/:id/users', deviceSiteAccess(deviceIdParam), requireSiteAdmin, async (req, res) => {
  const p = parseUmUser(req.body ?? {}, true, userOpts);
  if ('error' in p) return res.status(400).json({ error: p.error, field: p.field });
  const d = await serverDevice(req, res);
  if (!d) return;
  try { await saveUser(d, null, p.fields); res.status(201).json({ ok: true }); } catch (e) { sendWriteError(res, d, e); }
});

router.put('/:id/users/:uid', deviceSiteAccess(deviceIdParam), requireSiteAdmin, async (req, res) => {
  const uid = String(req.params.uid);
  if (!isItemId(uid)) return res.status(400).json({ error: 'That isn’t a user id' });
  const p = parseUmUser(req.body ?? {}, false, userOpts);
  if ('error' in p) return res.status(400).json({ error: p.error, field: p.field });
  const d = await serverDevice(req, res);
  if (!d) return;
  try { await saveUser(d, uid, p.fields); res.json({ ok: true }); } catch (e) { sendWriteError(res, d, e); }
});

router.delete('/:id/users/:uid', deviceSiteAccess(deviceIdParam), requireSiteAdmin, async (req, res) => {
  const uid = String(req.params.uid);
  if (!isItemId(uid)) return res.status(400).json({ error: 'That isn’t a user id' });
  const d = await serverDevice(req, res);
  if (!d) return;
  try { await removeUser(d, uid); res.json({ ok: true }); } catch (e) { sendWriteError(res, d, e); }
});

/**
 * POST /api/user-manager/:id/link-dot1x { device_id, um_address?, nas_address? }
 *
 * Have a switch's 802.1X ask this User Manager: a new shared secret is set on
 * both ends. User Manager accepts the switch at `nas_address` (its management
 * address unless given), and the switch gets a RADIUS entry for 802.1X at
 * `um_address` (the server's management address unless given), or its
 * existing one there takes the new secret. The switch side is a guarded change.
 */
router.post('/:id/link-dot1x', deviceSiteAccess(deviceIdParam), requireSiteAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const switchId = strictId(body.device_id);
  if (!switchId) return res.status(400).json({ error: 'Choose the switch.', field: 'device_id' });
  for (const k of ['um_address', 'nas_address']) {
    if (body[k] !== undefined && body[k] !== '' && !(typeof body[k] === 'string' && net.isIP(body[k] as string))) {
      return res.status(400).json({ error: 'That isn’t an IP address.', field: k });
    }
  }
  const um = await serverDevice(req, res);
  if (!um) return;
  // Admin on the switch too: its RADIUS settings decide who gets onto its ports.
  if (isSiteScoped(req.user) && (await devicesDenied(req.user!, [switchId], 'admin')).length > 0) {
    return res.status(404).json({ error: 'Switch not found' });
  }
  const sw = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [switchId]);
  if (!sw) return res.status(404).json({ error: 'Switch not found' });
  const umAddress = (body.um_address as string) || um.ip_address;
  const nasAddress = (body.nas_address as string) || sw.ip_address;
  if (!net.isIP(umAddress) || !net.isIP(nasAddress)) {
    return res.status(400).json({ error: 'Give the addresses as IP addresses: one of the devices is managed by name.', field: net.isIP(umAddress) ? 'nas_address' : 'um_address' });
  }
  const secret = newSharedSecret(randomBytes);
  let umResult: 'added' | 'updated';
  try {
    umResult = await upsertRouter(um, sw.name.trim(), nasAddress, secret);
  } catch (e) {
    return sendWriteError(res, um, e);
  }
  await withGuardedChange(switchId, req, res,
    { kind: 'radius.set', summary: `802.1X authenticates against User Manager on ${um.name.trim()} (${umAddress})` },
    async (c) => {
      const radius = (await c.getDot1x()).radius;
      const there = radius.find((r) => (r['address'] || '') === umAddress);
      if (there?.['.id']) {
        const services = new Set((there['service'] || '').split(',').filter(Boolean));
        services.add('dot1x');
        await c.setMenuItem('/radius', there['.id'], { secret, service: [...services].join(',') });
      } else {
        await c.addMenuItem('/radius', { address: umAddress, service: 'dot1x', secret, comment: `User Manager on ${um.name.trim()}` });
      }
      return {
        message: `${sw.name.trim()} now asks User Manager on ${um.name.trim()} for 802.1X (${umResult === 'added' ? 'added to' : 'secret changed in'} its RADIUS clients).`,
      };
    });
});

export default router;
