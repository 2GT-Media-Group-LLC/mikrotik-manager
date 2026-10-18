import { query } from '../config/database';

const RANK = new Map<string, number>([['viewer', 0], ['operator', 1], ['admin', 2]]);

/**
 * Merge site roles: a site reached twice (directly and through its group, #306)
 * gets the higher of the two roles.
 */
export function mergeSiteRoles(rows: { site_id: number; role: string }[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rows) {
    const had = out[r.site_id];
    if (had === undefined || (RANK.get(r.role) ?? -1) > (RANK.get(had) ?? -1)) out[r.site_id] = r.role;
  }
  return out;
}

/**
 * The sites an account is limited to, with its role in each, or null for a
 * fleet-wide account (P1-7, #306).
 *
 * An account is limited as soon as it has any site or group role, even when
 * those reach no site at all (a group with no sites yet): it then sees nothing,
 * never everything. Only an account with no rows in either table is
 * fleet-wide.
 */
export async function loadSiteRoles(userId: number): Promise<Record<number, string> | null> {
  const rows = await query<{ site_id: number | null; role: string; via: string }>(
    `SELECT site_id, role, 'site' AS via FROM user_site_roles WHERE user_id = $1
     UNION ALL
     SELECT s.id AS site_id, ugr.role, 'group' AS via
       FROM user_group_roles ugr LEFT JOIN sites s ON s.group_id = ugr.group_id
      WHERE ugr.user_id = $1`, [userId]);
  if (rows.length === 0) return null;
  return mergeSiteRoles(rows.filter((r): r is { site_id: number; role: string; via: string } => r.site_id != null));
}

/**
 * Accounts whose every site and group role is in the given set, so removing
 * those would leave them with none and make them fleet-wide. Deleting a site
 * or a group checks this first (#306): an account limited to one customer
 * must not quietly gain the whole fleet because that customer's site went.
 */
export async function accountsOnlyReaching(target: { siteId?: number; groupId?: number }): Promise<string[]> {
  const rows = await query<{ username: string }>(
    `SELECT u.username FROM users u
      WHERE (EXISTS (SELECT 1 FROM user_site_roles r WHERE r.user_id = u.id)
             OR EXISTS (SELECT 1 FROM user_group_roles g WHERE g.user_id = u.id))
        AND NOT EXISTS (SELECT 1 FROM user_site_roles r WHERE r.user_id = u.id AND r.site_id IS DISTINCT FROM $1::int)
        AND NOT EXISTS (SELECT 1 FROM user_group_roles g WHERE g.user_id = u.id AND g.group_id IS DISTINCT FROM $2::int)
      ORDER BY u.username`, [target.siteId ?? null, target.groupId ?? null]);
  return rows.map((r) => r.username);
}
