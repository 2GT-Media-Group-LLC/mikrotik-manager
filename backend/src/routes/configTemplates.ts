import { Router } from 'express';
import { requireAuth } from '../middleware/auth';

/**
 * Config Templates were merged into command templates (#163) and existing
 * ones were converted at startup (services/convertConfigTemplates.ts).
 *
 * The old endpoints answer 410 Gone with where to go instead, rather than a
 * bare 404 that would look like a broken install to a script calling them.
 */
const router = Router();
router.use(requireAuth);

// Every method and path: Express 5 no longer accepts a bare '*' path.
router.use((_req, res) => {
  res.status(410).json({
    error: 'Config Templates have been merged into command templates. Use /api/command-templates, '
      + 'and run a template through /api/commands/runs. Existing Config Templates were converted automatically.',
  });
});

export default router;
