/**
 * RoMON settings (#311): a fleet default, and one per group or site. Secrets
 * go in and are never sent back; the list says only whether one is set.
 *
 * Fleet admins set the fleet default and group settings; a site's own admin
 * may set that site's.
 */
import { Router, Request, Response } from 'express';
import { queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { listRomonSettings, saveRomonSetting, deleteRomonSetting } from '../services/romon';

const router = Router();
router.use(requireAuth);

type Scope = 'fleet' | 'group' | 'site';

function parseTarget(body: Record<string, unknown>): { scope: Scope; id: number | null } | { error: string } {
  const scope = body.scope;
  if (scope !== 'fleet' && scope !== 'group' && scope !== 'site') return { error: 'scope must be fleet, group or site' };
  if (scope === 'fleet') return { scope, id: null };
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: 'id is required for a group or site' };
  return { scope, id };
}

/** Fleet admins anything; a site admin only their own site. */
function mayEdit(req: Request, scope: Scope, id: number | null): boolean {
  const user = req.user;
  if (!user) return false;
  if (!user.siteRoles) return user.role === 'admin';
  return scope === 'site' && id != null && user.siteRoles[id] === 'admin';
}

async function exists(scope: Scope, id: number | null): Promise<boolean> {
  if (scope === 'fleet') return true;
  const table = scope === 'site' ? 'sites' : 'site_groups';
  return !!(await queryOne(`SELECT 1 FROM ${table} WHERE id = $1`, [id]));
}

// GET /api/romon/settings
router.get('/settings', async (req: Request, res: Response) => {
  const rows = await listRomonSettings();
  const own = req.user?.siteRoles ? new Set(Object.keys(req.user.siteRoles).map(Number)) : null;
  // A limited account sees the fleet default and its own sites' settings.
  res.json(own ? rows.filter((r) => r.scope === 'fleet' || (r.scope === 'site' && r.id != null && own.has(r.id))) : rows);
});

// PUT /api/romon/settings { scope, id?, enabled, secret? } — secret: omitted keeps it, null removes it
router.put('/settings', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = parseTarget(body);
  if ('error' in target) return res.status(400).json({ error: target.error });
  if (!mayEdit(req, target.scope, target.id)) return res.status(403).json({ error: 'You need admin access for that setting.' });
  if (!(await exists(target.scope, target.id))) return res.status(404).json({ error: `That ${target.scope} doesn't exist` });
  if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  let secret: string | null | undefined;
  if (body.secret === undefined) secret = undefined;
  else if (body.secret === null || body.secret === '') secret = null;
  else if (typeof body.secret === 'string') {
    // RouterOS keeps secrets as a comma-separated list; one secret per setting here.
    if (body.secret.length > 128 || body.secret.includes(',')) {
      return res.status(400).json({ error: 'The secret can be up to 128 characters, without commas.' });
    }
    secret = body.secret;
  } else return res.status(400).json({ error: 'secret must be text' });
  await saveRomonSetting(target.scope, target.id, body.enabled, secret);
  res.json({ ok: true });
});

// DELETE /api/romon/settings { scope, id? } — the site or group falls back to the next level
router.delete('/settings', async (req: Request, res: Response) => {
  const target = parseTarget((req.body ?? {}) as Record<string, unknown>);
  if ('error' in target) return res.status(400).json({ error: target.error });
  if (!mayEdit(req, target.scope, target.id)) return res.status(403).json({ error: 'You need admin access for that setting.' });
  await deleteRomonSetting(target.scope, target.id);
  res.json({ ok: true });
});

export default router;
