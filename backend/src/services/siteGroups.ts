/**
 * Which sites each group holds (#306), for the site scope of every request
 * made with a group chosen in the site switcher. Read from the database at
 * most every few seconds per group; any change to groups or to a site's group
 * forgets it at once.
 */
import { query } from '../config/database';
import { forgetAllSessionAccounts } from '../utils/sessionState';

const TTL_MS = 10_000;
const cache = new Map<number, { at: number; sites: number[] }>();

export async function groupSites(groupId: number): Promise<number[]> {
  const hit = cache.get(groupId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.sites;
  const rows = await query<{ id: number }>(`SELECT id FROM sites WHERE group_id = $1 ORDER BY id`, [groupId]);
  const sites = rows.map((r) => r.id);
  cache.set(groupId, { at: Date.now(), sites });
  return sites;
}

/**
 * A group or a site's group changed: forget the cached group sites, and the
 * cached accounts, whose sites may come through that group.
 */
export function groupsChanged(): void {
  cache.clear();
  forgetAllSessionAccounts();
}
