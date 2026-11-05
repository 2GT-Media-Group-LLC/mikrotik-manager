import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { loadMlagPairs, mlagPresent } from '../services/mlag';

const router = Router();
router.use(requireAuth);

/** GET /api/mlag — MLAG pairs in view with their state, bonds and health checks (#376). Read-only. */
router.get('/', async (req, res) => {
  res.json(await loadMlagPairs(activeSite(req)));
});

/** GET /api/mlag/present — whether any device in view runs MLAG, for the sidebar. */
router.get('/present', async (req, res) => {
  res.json({ present: await mlagPresent(activeSite(req)) });
});

export default router;
