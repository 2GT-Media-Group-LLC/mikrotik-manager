import {
  packageFileName, parseNewest, parseSha256File, planFiles, versionsToPrune, supportsLocalUpdate,
  matchLocalUpdate, clampKeepVersions, isMirrorFolder, downloadUrl, newestCompleteFrom, type FleetDevice,
} from '../firmwareMirror';

describe('packageFileName (#193)', () => {
  it('builds RouterOS 7 names, x86 without an architecture', () => {
    expect(packageFileName('routeros', '7.24.5', 'arm')).toBe('routeros-7.24.5-arm.npk');
    expect(packageFileName('wifi-qcom', '7.24.5', 'arm64')).toBe('wifi-qcom-7.24.5-arm64.npk');
    expect(packageFileName('routeros', '7.24.5', 'x86_64')).toBe('routeros-7.24.5.npk');
    expect(packageFileName('routeros', '7.24.5', 'x86')).toBe('routeros-7.24.5.npk');
    expect(packageFileName('routeros', '7.24.5', 'MIPSBE')).toBe('routeros-7.24.5-mipsbe.npk');
  });
  it('refuses anything that is not a package, architecture or version', () => {
    expect(packageFileName('../etc', '7.24.5', 'arm')).toBeNull();
    expect(packageFileName('routeros', '7.24.5;rm', 'arm')).toBeNull();
    expect(packageFileName('routeros', '6.49.22', 'arm')).toBeNull();
    expect(packageFileName('routeros', '7.25rc1', 'arm')).toBeNull();
    expect(packageFileName('routeros', '7.24.5', 'arm/../x')).toBeNull();
  });
  it('points at MikroTik', () => {
    expect(downloadUrl('7.24.5', 'routeros-7.24.5-arm.npk'))
      .toBe('https://download.mikrotik.com/routeros/7.24.5/routeros-7.24.5-arm.npk');
  });
});

describe('MikroTik answers', () => {
  it('reads the newest version', () => {
    expect(parseNewest('7.24.5 1790691687')).toBe('7.24.5');
    expect(parseNewest('7.25rc1 1790864328')).toBeNull();
    expect(parseNewest('<html>')).toBeNull();
  });
  it('reads a .sha256 file', () => {
    expect(parseSha256File('62f02a07d8262ffe4e7dde57566a8c30b82a8ff05383e7bd8bc75c4c297c8d4e  routeros-7.24.5-arm.npk'))
      .toBe('62f02a07d8262ffe4e7dde57566a8c30b82a8ff05383e7bd8bc75c4c297c8d4e');
    expect(parseSha256File('not a hash')).toBeNull();
  });
});

describe('supportsLocalUpdate', () => {
  it('needs RouterOS 7.17 or later', () => {
    expect(supportsLocalUpdate('7.24.4')).toBe(true);
    expect(supportsLocalUpdate('7.17')).toBe(true);
    expect(supportsLocalUpdate('7.16.2')).toBe(false);
    expect(supportsLocalUpdate('6.49.22')).toBe(false);
    expect(supportsLocalUpdate(null)).toBe(false);
  });
});

describe('planFiles', () => {
  const d = (id: number, arch: string | null, pkgs: string[] | null, ver = '7.24.4'): FleetDevice =>
    ({ id, name: `d${id}`, architecture: arch, installed_packages: pkgs, ros_version: ver });

  it('needs every installed package for every architecture, once', () => {
    const plan = planFiles([
      d(1, 'arm', ['routeros', 'wifi-qcom']),
      d(2, 'arm', ['routeros', 'wifi-qcom']),
      d(3, 'arm64', ['routeros']),
      d(4, 'x86_64', ['routeros', 'container']),
    ], '7.24.5');
    expect(plan.files.map((f) => f.filename)).toEqual([
      'container-7.24.5.npk',
      'routeros-7.24.5-arm.npk',
      'routeros-7.24.5-arm64.npk',
      'routeros-7.24.5.npk',
      'wifi-qcom-7.24.5-arm.npk',
    ]);
    expect(plan.skipped).toEqual([]);
  });
  it('says which devices it cannot serve', () => {
    const plan = planFiles([d(1, 'arm', ['routeros'], '7.16.2'), d(2, null, null), d(3, 'mipsbe', ['routeros'], '6.49.22')], '7.24.5');
    expect(plan.files).toEqual([]);
    expect(plan.skipped.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(plan.skipped[0].reason).toMatch(/older than 7\.17/);
  });
});

describe('versionsToPrune', () => {
  it('keeps the newest N', () => {
    expect(versionsToPrune(['7.23.7', '7.24.5', '7.24.4', '7.22.1'], 3)).toEqual(['7.22.1']);
    expect(versionsToPrune(['7.24.5', '7.24.4'], 1)).toEqual(['7.24.4']);
    expect(versionsToPrune(['7.24.5'], 3)).toEqual([]);
  });
  it('never keeps fewer than one or more than five', () => {
    expect(versionsToPrune(['7.24.5', '7.24.4'], 0)).toEqual(['7.24.4']);
    expect(clampKeepVersions(9)).toBe(5);
    expect(clampKeepVersions('x')).toBe(3);
    expect(clampKeepVersions(0)).toBe(1);
  });
});

describe('matchLocalUpdate', () => {
  const rows = [
    { '.id': '*1', name: 'wifi-qcom', version: '7.24.5', status: 'available' },
    { '.id': '*2', name: 'routeros', version: '7.24.5', status: 'available' },
    { '.id': '*3', name: 'routeros', version: '7.24.4', status: 'installed' },
  ];
  it('finds one entry per installed package at the target version', () => {
    expect(matchLocalUpdate(rows, ['routeros', 'wifi-qcom'], '7.24.5'))
      .toEqual({ ok: true, ids: [{ name: 'routeros', id: '*2' }, { name: 'wifi-qcom', id: '*1' }] });
  });
  it('refuses when any installed package is missing', () => {
    expect(matchLocalUpdate(rows, ['routeros', 'container'], '7.24.5')).toEqual({ ok: false, missing: ['container'] });
  });
});

describe('isMirrorFolder', () => {
  it('accepts a plain folder name only', () => {
    expect(isMirrorFolder('mtm-packages')).toBe(true);
    expect(isMirrorFolder('../x')).toBe(false);
    expect(isMirrorFolder('a/b')).toBe(false);
    expect(isMirrorFolder('')).toBe(false);
  });
});

describe('newestCompleteFrom', () => {
  const files = [
    { version: '7.24.5', filename: 'routeros-7.24.5-arm.npk' },
    { version: '7.24.4', filename: 'routeros-7.24.4-arm.npk' },
    { version: '7.24.4', filename: 'wifi-qcom-7.24.4-arm.npk' },
  ];
  it('picks the newest version with every package', () => {
    expect(newestCompleteFrom(files, 'arm', ['routeros'])).toBe('7.24.5');
    // 7.24.5 lacks wifi-qcom, so a device with it is offered 7.24.4 only.
    expect(newestCompleteFrom(files, 'arm', ['routeros', 'wifi-qcom'])).toBe('7.24.4');
  });
  it('offers nothing for an architecture or package it lacks', () => {
    expect(newestCompleteFrom(files, 'arm64', ['routeros'])).toBeNull();
    expect(newestCompleteFrom(files, 'arm', ['container'])).toBeNull();
    expect(newestCompleteFrom(files, null, ['routeros'])).toBeNull();
  });
});

