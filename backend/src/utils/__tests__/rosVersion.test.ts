import {
  parseRosVersion, compareRosVersions, isNewerRosVersion, updateAvailable,
} from '../rosVersion';

describe('compareRosVersions', () => {
  it('orders releases numerically, not as strings', () => {
    // "7.9" > "7.10" as text, which is how a string test gets this wrong.
    expect(compareRosVersions('7.10.0', '7.9.0')).toBe(1);
    expect(compareRosVersions('7.24.3', '7.24.2')).toBe(1);
    expect(compareRosVersions('6.49.10', '7.1')).toBe(-1);
  });

  it('treats a missing trailing part as zero', () => {
    expect(compareRosVersions('7.24', '7.24.0')).toBe(0);
    expect(compareRosVersions('7.24', '7.24.1')).toBe(-1);
  });

  // A pre-release leads to the release, so it must sort before it.
  it('orders pre-releases before the release they precede', () => {
    expect(compareRosVersions('7.25beta3', '7.25')).toBe(-1);
    expect(compareRosVersions('7.25', '7.25beta3')).toBe(1);
    expect(compareRosVersions('7.16rc1', '7.16')).toBe(-1);
  });

  it('orders alpha < beta < rc, then by number', () => {
    expect(compareRosVersions('7.25alpha1', '7.25beta1')).toBe(-1);
    expect(compareRosVersions('7.25beta1', '7.25rc1')).toBe(-1);
    expect(compareRosVersions('7.25beta2', '7.25beta3')).toBe(-1);
    expect(compareRosVersions('7.25beta3', '7.25beta3')).toBe(0);
  });

  it('ignores a trailing channel in parentheses', () => {
    expect(compareRosVersions('7.24.3 (stable)', '7.24.3')).toBe(0);
    expect(compareRosVersions('7.24.3 (stable)', '7.24.2')).toBe(1);
  });

  // Refusing to order what it cannot read beats inventing an order.
  it('treats unreadable versions as equal rather than guessing', () => {
    for (const bad of ['', null, undefined, 'unknown', 'n/a']) {
      expect(compareRosVersions(bad, '7.24.3')).toBe(0);
      expect(compareRosVersions('7.24.3', bad)).toBe(0);
    }
  });
});

describe('parseRosVersion', () => {
  it('reads the shapes RouterOS actually reports', () => {
    expect(parseRosVersion('7.24.3')!.parts).toEqual([7, 24, 3]);
    expect(parseRosVersion('6.49')!.parts).toEqual([6, 49]);
    const beta = parseRosVersion('7.25beta3')!;
    expect(beta.parts).toEqual([7, 25]);
    expect(beta.preNum).toBe(3);
  });

  it('returns null for anything it cannot read', () => {
    for (const bad of ['', '   ', null, undefined, 'stable', 'v-next']) {
      expect(parseRosVersion(bad)).toBeNull();
    }
  });
});

describe('updateAvailable', () => {
  /**
   * The reported bug. A device on 7.24.3 whose channel offers 7.24.2 was told
   * a new version was available, because the old test only asked whether the
   * two strings differed.
   */
  it('does not offer an older release as an update', () => {
    expect(updateAvailable({
      installed: '7.24.3', latest: '7.24.2', status: 'New version is available',
    })).toBe(false);
  });

  it('offers a genuinely newer release', () => {
    expect(updateAvailable({
      installed: '7.24.2', latest: '7.24.3', status: 'New version is available',
    })).toBe(true);
  });

  it('is quiet when the versions match', () => {
    expect(updateAvailable({
      installed: '7.24.3', latest: '7.24.3', status: 'System is already up to date',
    })).toBe(false);
  });

  // The device's word is a fallback for when the numbers cannot be read — not
  // an override of them.
  it('falls back to the reported status only when a version is unreadable', () => {
    expect(updateAvailable({ installed: '7.24.3', latest: '', status: 'New version is available' })).toBe(true);
    expect(updateAvailable({ installed: '', latest: '', status: 'System is already up to date' })).toBe(false);
    expect(updateAvailable({ installed: '7.24.3', latest: null, status: null })).toBe(false);
  });

  it('does not treat a pre-release as an upgrade from the release', () => {
    expect(updateAvailable({ installed: '7.25', latest: '7.25beta3' })).toBe(false);
    expect(updateAvailable({ installed: '7.24.3', latest: '7.25beta3' })).toBe(true);
  });
});

describe('isNewerRosVersion', () => {
  it('is strictly newer', () => {
    expect(isNewerRosVersion('7.24.3', '7.24.2')).toBe(true);
    expect(isNewerRosVersion('7.24.2', '7.24.3')).toBe(false);
    expect(isNewerRosVersion('7.24.3', '7.24.3')).toBe(false);
  });
});
