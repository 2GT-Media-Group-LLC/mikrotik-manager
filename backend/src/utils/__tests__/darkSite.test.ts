import { DARK_SITE_FEATURES, DARK_SITE_KEYS, internetAllowed } from '../darkSite';

describe('internetAllowed', () => {
  it('defaults to on for an install that has never set the key', () => {
    expect(internetAllowed({}, 'update_check_enabled')).toBe(true);
  });

  it('turns off only on an explicit false', () => {
    expect(internetAllowed({ update_check_enabled: false }, 'update_check_enabled')).toBe(false);
  });

  it('treats anything else as on, matching the default', () => {
    for (const v of [true, null, undefined, 'no', 0, '']) {
      expect(internetAllowed({ k: v }, 'k')).toBe(true);
    }
  });
});

describe('DARK_SITE_FEATURES', () => {
  it('keeps the maps key that already exists, so current settings carry over', () => {
    expect(DARK_SITE_KEYS).toContain('maps_enabled');
  });

  it('has no duplicate keys', () => {
    expect(new Set(DARK_SITE_KEYS).size).toBe(DARK_SITE_KEYS.length);
  });

  it('states a destination and a cost for every feature', () => {
    for (const f of DARK_SITE_FEATURES) {
      expect(f.destination.length).toBeGreaterThan(0);
      expect(f.cost.length).toBeGreaterThan(0);
    }
  });
});
