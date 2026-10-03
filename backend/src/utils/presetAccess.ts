/**
 * Who may see, manage and use a credential preset (#228).
 *
 * A preset is either fleet-wide (site_id null) or belongs to one site.
 * - Fleet admins see and manage all of them.
 * - A site admin manages the presets of the sites they administer, and uses
 *   them even when restricted to admins. Fleet-wide presets they use as an
 *   operator would (P1-7): admin-only ones stay fleet objects.
 * - Everyone else sees and uses only presets open to operators, in their own
 *   sites or fleet-wide.
 * - A site's preset is only ever applied to a device in that site.
 */
export interface PresetCaller {
  fleetAdmin: boolean;
  /** Sites this account administers (site-scoped accounts). */
  adminSites: number[];
  /** Sites this account belongs to; null for a fleet-wide account. */
  memberSites: number[] | null;
}

export interface PresetRowLike {
  site_id: number | null;
  allow_operator_use: boolean | null;
}

export function presetCaller(user: { role?: string; siteRoles?: Record<number | string, string> } | undefined): PresetCaller {
  if (!user) return { fleetAdmin: false, adminSites: [], memberSites: [] };
  if (!user.siteRoles) return { fleetAdmin: user.role === 'admin', adminSites: [], memberSites: null };
  const entries = Object.entries(user.siteRoles);
  return {
    fleetAdmin: false,
    adminSites: entries.filter(([, r]) => r === 'admin').map(([s]) => Number(s)),
    memberSites: entries.map(([s]) => Number(s)),
  };
}

const operatorUse = (row: PresetRowLike) => row.allow_operator_use !== false;
const adminOf = (c: PresetCaller, site: number | null) => site != null && c.adminSites.includes(site);

/** Can this account create, change or delete a preset for `siteId` (null = fleet-wide)? */
export function canManagePresetSite(c: PresetCaller, siteId: number | null): boolean {
  return c.fleetAdmin || adminOf(c, siteId);
}

export function canSeePreset(c: PresetCaller, row: PresetRowLike): boolean {
  if (c.fleetAdmin) return true;
  if (row.site_id == null) return operatorUse(row);
  const member = c.memberSites == null || c.memberSites.includes(row.site_id);
  return member && (operatorUse(row) || adminOf(c, row.site_id));
}

/** Can this account apply the preset to a device in `deviceSiteId`? A reason when not. */
export function presetUseRefusal(c: PresetCaller, row: PresetRowLike, deviceSiteId: number | null): string | null {
  if (row.site_id != null && row.site_id !== deviceSiteId) {
    return 'This credential preset belongs to another site, so it can only be used on devices there';
  }
  if (!operatorUse(row) && !c.fleetAdmin && !adminOf(c, row.site_id)) {
    return 'This credential preset is restricted to administrators';
  }
  return null;
}
