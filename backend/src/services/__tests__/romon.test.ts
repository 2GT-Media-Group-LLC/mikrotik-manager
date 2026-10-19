import { romonChecks, romonSetParams, sendingSecret, type RomonSetting } from '../romon';

const site = (over: Partial<RomonSetting> = {}): RomonSetting => ({ enabled: true, secret: 's3cret', source: { scope: 'site', name: 'Branch 7' }, ...over });

describe('RoMON checks (#311)', () => {
  it('flags RoMON off where the site wants it on', () => {
    const c = romonChecks({ enabled: 'false' }, site());
    expect(c.map((x) => x.id)).toEqual(['romon-off']);
    expect(c[0].fix).toBe('romon');
    expect(c[0].detail).toContain('site Branch 7');
  });

  it('is quiet when on with the right secret, or when nothing is set', () => {
    expect(romonChecks({ enabled: 'true', secrets: 's3cret' }, site())).toEqual([]);
    expect(romonChecks({ enabled: 'false' }, null)).toEqual([]);
  });

  it('flags a different secret, comparing the one the device sends with', () => {
    expect(romonChecks({ enabled: 'true', secrets: 'old,s3cret' }, site()).map((x) => x.id)).toEqual(['romon-secret']);
    expect(romonChecks({ enabled: 'true', secrets: 's3cret,old' }, site())).toEqual([]);
  });

  it("doesn't guess when the device hides its secrets", () => {
    // An API user without the sensitive policy doesn't see them.
    expect(romonChecks({ enabled: 'true' }, site())).toEqual([]);
  });

  it('a setting with no secret only checks on/off, and the fix leaves secrets alone', () => {
    expect(romonChecks({ enabled: 'true', secrets: 'anything' }, site({ secret: null }))).toEqual([]);
    expect(romonSetParams(site({ secret: null }))).toEqual({ enabled: 'yes' });
    expect(romonSetParams(site())).toEqual({ enabled: 'yes', secrets: 's3cret' });
  });

  it('the sending secret is the first of the list', () => {
    expect(sendingSecret('a,b')).toBe('a');
    expect(sendingSecret('')).toBe('');
    expect(sendingSecret(undefined)).toBeUndefined();
  });
});
