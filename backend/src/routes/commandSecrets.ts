/**
 * Secret values for commands (#259). Fleet admins only. A value is written
 * (typed, or generated here) and never read back: the list shows names and
 * when they changed.
 */
import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { SECRET_NAME, generateSecret, listSecrets, saveSecret } from '../services/commandSecrets';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', async (_req: Request, res: Response) => {
  res.json(await listSecrets());
});

// POST { name, value } or { name, generate: true }. Replaces a value of the same name.
router.post('/', async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  if (!SECRET_NAME.test(name)) return res.status(400).json({ error: 'A name uses letters, digits, dash and underscore, up to 64.' });
  let value: string;
  if (req.body?.generate === true) value = generateSecret();
  else {
    value = typeof req.body?.value === 'string' ? req.body.value : '';
    if (!value) return res.status(400).json({ error: 'Give a value, or ask for one to be generated.' });
    if (value.length > 512) return res.status(400).json({ error: 'A value is at most 512 characters.' });
    // A secret ends up inside a RouterOS command; a quote or newline in it
    // would end the string it's placed in.
    if (/["\r\n\\$]/.test(value)) return res.status(400).json({ error: 'A value can’t contain quotes, backslashes, $ or line breaks.' });
  }
  await saveSecret(name, value, req.user?.username ?? null);
  return res.status(201).json({ ok: true, name });
});

router.delete('/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!SECRET_NAME.test(name)) return res.status(400).json({ error: 'Not a secret name' });
  await query(`DELETE FROM command_secrets WHERE name = $1`, [name]);
  return res.json({ ok: true });
});

export default router;
