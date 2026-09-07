import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeDevices, siteScopeByNullableDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';

const router = Router();
router.use(requireAuth);

// GET /api/search?q=<term>
router.get('/', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ devices: [], clients: [], events: [] });
  }

  const like = `%${q}%`;
  const siteId = activeSite(req);
  const devFilter = siteScopeDevices(siteId);
  const clientFilter = siteScopeByNullableDevice(siteId, 'c.device_id');
  const eventFilter = siteScopeByNullableDevice(siteId, 'e.device_id');

  const [devices, clients, events] = await Promise.all([
    query(
      `SELECT id, name, ip_address, model, device_type, status
       FROM devices
       WHERE (name ILIKE $1 OR ip_address ILIKE $1 OR model ILIKE $1 OR serial_number ILIKE $1)
         ${devFilter ? `AND ${devFilter}` : ''}
       ORDER BY (status = 'online') DESC, name ASC
       LIMIT 6`,
      [like]
    ),
    query(
      `SELECT c.mac_address, c.hostname, c.ip_address, c.device_id, c.active,
              d.name as device_name
       FROM clients c
       LEFT JOIN devices d ON d.id = c.device_id
       WHERE (c.mac_address ILIKE $1 OR c.hostname ILIKE $1 OR c.ip_address ILIKE $1)
         ${clientFilter ? `AND ${clientFilter}` : ''}
       ORDER BY c.active DESC, c.last_seen DESC
       LIMIT 6`,
      [like]
    ),
    query(
      `SELECT e.id, e.message, e.severity, e.event_time, e.topic, e.device_id,
              d.name as device_name
       FROM events e
       LEFT JOIN devices d ON d.id = e.device_id
       WHERE (e.message ILIKE $1 OR e.topic ILIKE $1 OR d.name ILIKE $1)
         ${eventFilter ? `AND ${eventFilter}` : ''}
       ORDER BY e.event_time DESC
       LIMIT 6`,
      [like]
    ),
  ]);

  res.json({ devices, clients, events });
});

export default router;
