import { Router } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';

const router = Router();
router.use(requireAuth);

const KINDS = ['ipsec', 'pppoe-server', 'ppp-session', 'pppoe-client', 'eoip', 'gre', 'ipip'];

/**
 * GET /api/tunnels — IPsec peers, PPPoE servers and clients, active PPP
 * sessions and EoIP/GRE/IPIP tunnels the slow polls found (#310), across the
 * fleet or the selected site, down ones first. `?deviceId=` and `?kind=`
 * narrow it. Read-only.
 */
router.get('/', async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = siteScopeByDevice(activeSite(req), 't.device_id');
  if (scope) where.push(scope);
  if (req.query.deviceId !== undefined) {
    const deviceId = Number(req.query.deviceId);
    if (!Number.isInteger(deviceId)) return res.status(400).json({ error: 'deviceId must be a number' });
    params.push(deviceId);
    where.push(`t.device_id = $${params.length}`);
  }
  if (req.query.kind !== undefined) {
    if (!KINDS.includes(String(req.query.kind))) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    params.push(String(req.query.kind));
    where.push(`t.kind = $${params.length}`);
  }
  const rows = await query(
    `SELECT t.device_id, d.name AS device_name, d.status AS device_status, t.kind, t.tunnel_key, t.name,
            t.local_address, t.remote_address, t.detail, t.status, t.state, t.uptime,
            t.last_up_at, t.last_change_at, t.updated_at
       FROM device_tunnels t JOIN devices d ON d.id = t.device_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE t.status WHEN 'down' THEN 0 WHEN 'idle' THEN 1 WHEN 'up' THEN 2 ELSE 3 END,
               d.name, t.kind, t.name`,
    params
  );
  return res.json(rows);
});

export default router;
