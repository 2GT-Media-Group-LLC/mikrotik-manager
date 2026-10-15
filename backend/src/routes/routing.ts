import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/routing/peers — every BGP peer and OSPF neighbour the slow polls
 * found (#279), across the fleet or the selected site, down ones first.
 * `?deviceId=` narrows it to one device.
 */
router.get('/peers', async (req: Request, res: Response) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = siteScopeByDevice(activeSite(req), 'r.device_id');
  if (scope) where.push(scope);
  const deviceId = Number(req.query.deviceId);
  if (req.query.deviceId !== undefined) {
    if (!Number.isInteger(deviceId)) return res.status(400).json({ error: 'deviceId must be a number' });
    params.push(deviceId);
    where.push(`r.device_id = $${params.length}`);
  }
  const rows = await query(
    `SELECT r.device_id, d.name AS device_name, d.status AS device_status, r.protocol, r.peer_key, r.name,
            r.remote_address, r.remote_as, r.remote_id, r.instance, r.detail, r.state, r.up, r.disabled,
            r.uptime, r.prefix_count, r.last_up_at, r.last_change_at, r.last_seen_at, r.updated_at
       FROM routing_peers r JOIN devices d ON d.id = r.device_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.up, r.disabled, d.name, r.protocol, r.name`,
    params
  );
  return res.json(rows);
});

export default router;
