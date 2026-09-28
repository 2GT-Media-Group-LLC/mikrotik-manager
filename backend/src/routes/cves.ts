import { Router, Request, Response } from 'express';
import { requireAuth, requireWrite } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { fleetCveReport, refreshCveFeed } from '../services/cveFeed';

/** Known RouterOS vulnerabilities for the fleet's versions (#175). */
const router = Router();
router.use(requireAuth);

// GET /api/security/cves — the stored list matched against the site's versions
router.get('/', async (req: Request, res: Response) => {
  res.json(await fleetCveReport(activeSite(req)));
});

// POST /api/security/cves/refresh — fetch the lists now instead of waiting for the daily run
router.post('/refresh', requireWrite, async (req: Request, res: Response) => {
  try {
    await refreshCveFeed();
  } catch (err) {
    const msg = (err as Error).message;
    // Turned off on purpose is not an upstream failure.
    const status = /Dark Site Mode/.test(msg) ? 409 : 502;
    return res.status(status).json({ error: `Could not refresh the vulnerability list: ${msg}` });
  }
  return res.json(await fleetCveReport(activeSite(req)));
});

export default router;
