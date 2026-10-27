/**
 * Narrowing a page's site-owned entries (credential presets, jump hosts) to
 * the sites in view, as every other page does (#306).
 */

/** The sites in view: the one chosen, a group's, or null for every site. */
export function sitesInView(
  currentSiteId: number | null,
  currentGroupId: number | null,
  sites: { id: number; group_id?: number | null }[],
): number[] | null {
  if (currentSiteId != null) return [currentSiteId];
  if (currentGroupId != null) return sites.filter((s) => s.group_id === currentGroupId).map((s) => s.id);
  return null;
}

/** Whether an entry belongs in the view. A fleet-wide one (no site) applies everywhere. */
export function inView(siteId: number | null | undefined, view: number[] | null): boolean {
  return view == null || siteId == null || view.includes(siteId);
}

/**
 * The site a new entry starts in, as a form value ('' = fleet-wide): the site
 * in view when the account may put one there, else fleet-wide for a fleet
 * admin, else the first site it may use (one in view if it can). An install
 * with a single site keeps fleet-wide, so a site added later shares it.
 */
export function newEntrySite(view: number[] | null, choices: { id: number }[], fleetAdmin: boolean): string {
  const ids = choices.map((c) => c.id);
  if (view?.length === 1 && ids.includes(view[0]) && !(fleetAdmin && ids.length <= 1)) return String(view[0]);
  if (fleetAdmin) return '';
  const first = ids.find((id) => view == null || view.includes(id)) ?? ids[0];
  return first != null ? String(first) : '';
}
