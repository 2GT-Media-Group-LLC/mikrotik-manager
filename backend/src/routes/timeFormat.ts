import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { queryOne } from '../config/database';
import { isTimeFormatPreference, timeFormatPreferences } from '../utils/timeFormat';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const DEFAULT_COLUMN = `(SELECT value FROM app_settings WHERE key = 'time_format_default') AS system_default`;

// Every account can read and change only its own display preference, including SSO/site viewers.
router.get('/', async (req: Request, res: Response) => {
  const row = await queryOne<{ time_format: string | null; system_default: unknown }>(
    `SELECT time_format, ${DEFAULT_COLUMN} FROM users WHERE id = $1`, [req.user!.userId],
  );
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  return res.json(timeFormatPreferences(row));
});

router.put('/', async (req: Request, res: Response) => {
  const preference: unknown = req.body?.preference;
  if (!isTimeFormatPreference(preference)) {
    return res.status(400).json({ error: 'preference must be system, browser, 12h or 24h.' });
  }
  const row = await queryOne<{ time_format: string | null; system_default: unknown }>(
    `UPDATE users SET time_format = $1 WHERE id = $2 RETURNING time_format, ${DEFAULT_COLUMN}`,
    [preference === 'system' ? null : preference, req.user!.userId],
  );
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  return res.json(timeFormatPreferences(row));
});

export default router;
