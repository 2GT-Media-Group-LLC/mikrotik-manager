import { presetCaller, canManagePresetSite, canSeePreset, presetUseRefusal } from '../presetAccess';

const fleetAdmin = presetCaller({ role: 'admin' });
const fleetOperator = presetCaller({ role: 'operator' });
const siteAdmin = presetCaller({ role: 'admin', siteRoles: { 2: 'admin', 3: 'operator' } });
const fleetWide = { site_id: null, allow_operator_use: true };
const fleetAdminOnly = { site_id: null, allow_operator_use: false };
const site2AdminOnly = { site_id: 2, allow_operator_use: false };
const site3Open = { site_id: 3, allow_operator_use: true };
const site9Open = { site_id: 9, allow_operator_use: true };

describe('credential preset access (#228)', () => {
  it('lets fleet admins manage anything, site admins only their own sites', () => {
    expect(canManagePresetSite(fleetAdmin, null)).toBe(true);
    expect(canManagePresetSite(fleetAdmin, 9)).toBe(true);
    expect(canManagePresetSite(siteAdmin, 2)).toBe(true);
    expect(canManagePresetSite(siteAdmin, 3)).toBe(false); // only operator there
    expect(canManagePresetSite(siteAdmin, null)).toBe(false); // fleet-wide is a fleet object
    expect(canManagePresetSite(fleetOperator, null)).toBe(false);
  });

  it('shows each account only what it may use', () => {
    expect([fleetWide, fleetAdminOnly, site2AdminOnly, site3Open, site9Open].map((r) => canSeePreset(siteAdmin, r)))
      .toEqual([true, false, true, true, false]);
    expect([fleetWide, fleetAdminOnly, site2AdminOnly, site3Open].map((r) => canSeePreset(fleetOperator, r)))
      .toEqual([true, false, false, true]);
    expect(canSeePreset(fleetAdmin, site2AdminOnly)).toBe(true);
  });

  it('applies a site preset only to devices in that site', () => {
    expect(presetUseRefusal(siteAdmin, site2AdminOnly, 2)).toBeNull();
    expect(presetUseRefusal(siteAdmin, site2AdminOnly, 3)).toMatch(/another site/);
    expect(presetUseRefusal(fleetAdmin, site3Open, 9)).toMatch(/another site/);
    expect(presetUseRefusal(fleetOperator, fleetWide, 5)).toBeNull();
  });

  it('keeps admin-only fleet presets away from site admins and operators', () => {
    expect(presetUseRefusal(siteAdmin, fleetAdminOnly, 2)).toMatch(/administrators/);
    expect(presetUseRefusal(fleetOperator, fleetAdminOnly, 2)).toMatch(/administrators/);
    expect(presetUseRefusal(fleetAdmin, fleetAdminOnly, 2)).toBeNull();
  });
});
