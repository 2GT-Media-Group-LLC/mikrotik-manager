/**
 * Groups of sites (#306): a customer with several sites, chosen from the site
 * switcher so every page narrows to that customer, and a unit access can be
 * given for. A site belongs to at most one group.
 *
 * Fleet-wide accounts manage groups (they decide whose sites are whose); an
 * account limited to particular sites sees the groups its sites are in, with
 * only those sites listed.
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { groupsChanged } from '../services/siteGroups';
import { accountsOnlyReaching } from '../utils/siteRoles';

const router = Router();
router.use(requireAuth);

const MAX_NAME = 120;

function refuseUnlessFleet(req: Request, res: Response): boolean {
  if (!req.user?.siteRoles) return true;
  res.status(403).json({ error: 'Only fleet-wide accounts can manage groups.' });
  return false;
}

function cleanName(raw: unknown): { name?: string; error?: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Group name is required' };
  if (name.length > MAX_NAME) return { error: `Group name must be ${MAX_NAME} characters or fewer` };
  return { name };
}

/** Site ids from a request: every one a positive integer naming an existing site. */
async function cleanSiteIds(raw: unknown): Promise<{ ids?: number[]; error?: string }> {
  if (!Array.isArray(raw)) return { error: 'site_ids must be a list of site ids' };
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) return { error: 'Invalid site id' };
  if (ids.length) {
    const found = await query<{ id: number }>(`SELECT id FROM sites WHERE id = ANY($1::int[])`, [ids]);
    if (found.length !== ids.length) return { error: 'A site does not exist' };
  }
  return { ids };
}

// GET /api/site-groups
router.get('/', async (req: Request, res: Response) => {
  const own = req.user?.siteRoles ? Object.keys(req.user.siteRoles).map(Number) : null;
  const rows = await query<{ id: number; name: string; notes: string | null; site_ids: number[] | null; device_count: string; online_count: string }>(
    `SELECT g.id, g.name, g.notes,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.id), NULL) AS site_ids,
            COUNT(d.id)::text AS device_count,
            COUNT(d.id) FILTER (WHERE d.status = 'online')::text AS online_count
       FROM site_groups g
       LEFT JOIN sites s ON s.group_id = g.id ${own ? 'AND s.id = ANY($1::int[])' : ''}
       LEFT JOIN devices d ON d.site_id = s.id
      GROUP BY g.id
      ORDER BY LOWER(g.name)`, own ? [own] : []);
  res.json(rows
    // A limited account sees only groups holding one of its sites.
    .filter((g) => !own || (g.site_ids?.length ?? 0) > 0)
    .map((g) => ({
      id: g.id, name: g.name, notes: g.notes, site_ids: g.site_ids ?? [],
      device_count: parseInt(g.device_count, 10), online_count: parseInt(g.online_count, 10),
    })));
});

// POST /api/site-groups { name, notes?, site_ids? }
router.post('/', requireWrite, async (req: Request, res: Response) => {
  if (!refuseUnlessFleet(req, res)) return;
  const { name, error } = cleanName(req.body?.name);
  if (error) { res.status(400).json({ error }); return; }
  const sites = req.body?.site_ids === undefined ? { ids: [] as number[] } : await cleanSiteIds(req.body.site_ids);
  if (sites.error) { res.status(400).json({ error: sites.error }); return; }
  const clash = await queryOne(`SELECT 1 FROM site_groups WHERE LOWER(name) = LOWER($1)`, [name]);
  if (clash) { res.status(409).json({ error: 'A group with that name already exists' }); return; }
  const group = await transaction(async (client) => {
    const r = await client.query<{ id: number; name: string; notes: string | null }>(
      `INSERT INTO site_groups (name, notes) VALUES ($1, $2) RETURNING id, name, notes`,
      [name, typeof req.body?.notes === 'string' ? req.body.notes.trim() || null : null]);
    if (sites.ids!.length) await client.query(`UPDATE sites SET group_id = $1 WHERE id = ANY($2::int[])`, [r.rows[0].id, sites.ids]);
    return r.rows[0];
  });
  groupsChanged();
  res.status(201).json({ ...group, site_ids: sites.ids });
});

// PUT /api/site-groups/:id { name?, notes?, site_ids? } — site_ids replaces the membership
router.put('/:id', requireWrite, async (req: Request, res: Response) => {
  if (!refuseUnlessFleet(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid group id' }); return; }
  const existing = await queryOne<{ id: number }>(`SELECT id FROM site_groups WHERE id = $1`, [id]);
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }
  let name: string | null = null;
  if (req.body?.name !== undefined) {
    const n = cleanName(req.body.name);
    if (n.error) { res.status(400).json({ error: n.error }); return; }
    name = n.name!;
    const clash = await queryOne(`SELECT 1 FROM site_groups WHERE LOWER(name) = LOWER($1) AND id <> $2`, [name, id]);
    if (clash) { res.status(409).json({ error: 'A group with that name already exists' }); return; }
  }
  const sites = req.body?.site_ids === undefined ? null : await cleanSiteIds(req.body.site_ids);
  if (sites?.error) { res.status(400).json({ error: sites.error }); return; }
  await transaction(async (client) => {
    await client.query(
      `UPDATE site_groups SET name = COALESCE($1, name),
              notes = CASE WHEN $2::boolean THEN $3 ELSE notes END
        WHERE id = $4`,
      [name, req.body?.notes !== undefined, typeof req.body?.notes === 'string' ? req.body.notes.trim() || null : null, id]);
    if (sites) {
      // A site moved here leaves whatever group it was in: one owner per site.
      await client.query(`UPDATE sites SET group_id = NULL WHERE group_id = $1 AND NOT (id = ANY($2::int[]))`, [id, sites.ids]);
      if (sites.ids!.length) await client.query(`UPDATE sites SET group_id = $1 WHERE id = ANY($2::int[])`, [id, sites.ids]);
    }
  });
  groupsChanged();
  res.json({ ok: true });
});

// DELETE /api/site-groups/:id — its sites stay, just without a group
router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
  if (!refuseUnlessFleet(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid group id' }); return; }
  const group = await queryOne<{ name: string }>(`SELECT name FROM site_groups WHERE id = $1`, [id]);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  // Deleting it removes the access given through it. An account with no other
  // access would become fleet-wide: refuse rather than widen it.
  const stranded = await accountsOnlyReaching({ groupId: id });
  if (stranded.length > 0) {
    res.status(409).json({
      error: `${stranded.join(', ')} ${stranded.length === 1 ? 'has' : 'have'} access only through "${group.name}". `
           + 'Give them other access, or remove the account, before deleting the group.',
      accounts: stranded,
    });
    return;
  }
  await query(`DELETE FROM site_groups WHERE id = $1`, [id]);
  groupsChanged();
  res.json({ ok: true });
});

export default router;
