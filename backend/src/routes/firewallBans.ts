import { Router } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeByDevice } from '../utils/siteScope';

/**
 * GET /api/firewall-bans: every address brute-force protection (#405) has
 * banned, across the fleet or the selected site, from the slow polls.
 * Unbanning is on each device's Firewall tab.
 */
const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const scope = siteScopeByDevice(activeSite(req), 'b.device_id');
  const rows = await query(
    `SELECT b.device_id, d.name AS device_name, b.address, b.time_left, b.first_seen, b.updated_at
       FROM firewall_bans b JOIN devices d ON d.id = b.device_id
      ${scope ? `WHERE ${scope}` : ''}
      ORDER BY b.first_seen DESC LIMIT 1000`);
  res.json(rows);
});

export default router;
