/**
 * The site a device being added joins, when the request names one (#306):
 * an existing site by id, or a site by name, made on the spot if there isn't
 * one, so a fleet can be imported with its sites rather than mapped by hand
 * afterwards. A group named with a new site is found or made too, and the
 * site put in it.
 *
 * Making sites and groups takes a fleet-wide account, as on the Sites page.
 * An account limited to particular sites can name only its own, where it is at
 * least an operator.
 */
import { queryOne, transaction } from '../config/database';
import { groupsChanged } from './siteGroups';

export interface SiteChoice { site_id?: unknown; site_name?: unknown; group_name?: unknown }

type Who = { siteRoles?: Record<number, string> | null };
export type SiteResolution =
  | { ok: true; siteId: number | null; named: boolean }
  | { ok: false; status: number; error: string };

const MAX_NAME = 120;

function mayAddTo(user: Who, siteId: number): boolean {
  if (!user.siteRoles) return true;
  const role = user.siteRoles[siteId];
  return role === 'admin' || role === 'operator';
}

/**
 * Resolve a request's site choice. `named` is false when it named none, and
 * the caller should fall back to the active site as before.
 */
export async function resolveSiteChoice(user: Who, input: SiteChoice): Promise<SiteResolution> {
  if (input.site_id !== undefined && input.site_id !== null && input.site_id !== '') {
    const id = Number(input.site_id);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, status: 400, error: 'Invalid site' };
    const site = await queryOne<{ id: number }>(`SELECT id FROM sites WHERE id = $1`, [id]);
    if (!site || (user.siteRoles && !user.siteRoles[id])) return { ok: false, status: 400, error: 'That site does not exist' };
    if (!mayAddTo(user, id)) return { ok: false, status: 403, error: 'You need operator access to that site to add devices to it.' };
    return { ok: true, siteId: id, named: true };
  }
  const name = typeof input.site_name === 'string' ? input.site_name.trim() : '';
  if (!name) return { ok: true, siteId: null, named: false };
  if (name.length > MAX_NAME) return { ok: false, status: 400, error: `Site name must be ${MAX_NAME} characters or fewer` };
  const existing = await queryOne<{ id: number }>(`SELECT id FROM sites WHERE LOWER(name) = LOWER($1)`, [name]);
  if (existing) {
    if (user.siteRoles && !user.siteRoles[existing.id]) return { ok: false, status: 403, error: `You don't have access to the site "${name}".` };
    if (!mayAddTo(user, existing.id)) return { ok: false, status: 403, error: 'You need operator access to that site to add devices to it.' };
    return { ok: true, siteId: existing.id, named: true };
  }
  if (user.siteRoles) return { ok: false, status: 403, error: `There's no site called "${name}", and only fleet-wide accounts can make one.` };
  const groupName = typeof input.group_name === 'string' ? input.group_name.trim() : '';
  if (groupName.length > MAX_NAME) return { ok: false, status: 400, error: `Group name must be ${MAX_NAME} characters or fewer` };
  const siteId = await transaction(async (client) => {
    // Two adds naming the same new site at once must make it once.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sites:create-by-name'))`);
    const again = await client.query<{ id: number }>(`SELECT id FROM sites WHERE LOWER(name) = LOWER($1)`, [name]);
    if (again.rows[0]) return again.rows[0].id;
    let groupId: number | null = null;
    if (groupName) {
      const g = await client.query<{ id: number }>(`SELECT id FROM site_groups WHERE LOWER(name) = LOWER($1)`, [groupName]);
      groupId = g.rows[0]?.id ?? (await client.query<{ id: number }>(
        `INSERT INTO site_groups (name) VALUES ($1) RETURNING id`, [groupName])).rows[0].id;
    }
    const r = await client.query<{ id: number }>(`INSERT INTO sites (name, group_id) VALUES ($1, $2) RETURNING id`, [name, groupId]);
    return r.rows[0].id;
  });
  if (groupName) groupsChanged();
  return { ok: true, siteId, named: true };
}

