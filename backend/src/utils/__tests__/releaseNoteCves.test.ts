import { parseReleaseNoteCves, releasePlan, releaseNoteFixes, releaseName } from '../releaseNoteCves';

// download.mikrotik.com/routeros/<version>/CHANGELOG, as published.
const V64923 = "What's new in 6.49.23 (2026-10-07):\n\n*) system - improve stability (includes CVE-2026-84411);\n";
const V64922 = "What's new in 6.49.22 (2026-09-16):\n\n*) system - improve stability (includes CVE-2026-67281);\n";
const V7245 = "What's new in 7.24.5 (2026-09-29):\n\n*) bridge - disable DHCP snooping ip binding table (introduced in v7.24);\n*) system - improve stability;\n";

describe('parseReleaseNoteCves', () => {
  it('finds the CVE and keeps the line naming it', () => {
    expect(parseReleaseNoteCves(V64923)).toEqual([{ id: 'CVE-2026-84411', line: 'system - improve stability (includes CVE-2026-84411)' }]);
  });
  it('finds none in notes without one', () => {
    expect(parseReleaseNoteCves(V7245)).toEqual([]);
  });
  it('takes several per line, once each, case-insensitively', () => {
    const r = parseReleaseNoteCves('*) ssh - fix (cve-2026-1111, CVE-2026-22222);\n*) winbox - CVE-2026-1111 again;');
    expect(r.map((c) => c.id)).toEqual(['CVE-2026-1111', 'CVE-2026-22222']);
  });
});

describe('releasePlan', () => {
  it('reads the patch releases up to the latest in the same line', () => {
    expect(releasePlan('6.49.20', '6.49.23')).toEqual([{ major: 6, minor: 49, fromPatch: 21, toPatch: 23 }]);
  });
  it('walks intermediate minors to their end, and the latest minor to the latest', () => {
    expect(releasePlan('7.22.3', '7.24.5')).toEqual([
      { major: 7, minor: 22, fromPatch: 4, toPatch: null },
      { major: 7, minor: 23, fromPatch: 0, toPatch: null },
      { major: 7, minor: 24, fromPatch: 0, toPatch: 5 },
    ]);
  });
  it('reads nothing when up to date, newer, or on another major', () => {
    expect(releasePlan('6.49.23', '6.49.23')).toEqual([]);
    expect(releasePlan('7.24.5', '7.24.4')).toEqual([]);
    expect(releasePlan('6.49.22', '7.24.5')).toEqual([]);
  });
  it('names a .0 release the way MikroTik does', () => {
    expect(releaseName(7, 25, 0)).toBe('7.25');
    expect(releaseName(6, 49, 23)).toBe('6.49.23');
  });
});

describe('releaseNoteFixes', () => {
  const notes = [
    { version: '6.49.22', cves: parseReleaseNoteCves(V64922) },
    { version: '6.49.23', cves: parseReleaseNoteCves(V64923) },
    { version: '7.24.6', cves: [{ id: 'CVE-2026-9999', line: 'ssh - fix (CVE-2026-9999)' }] },
    { version: '7.25', cves: [{ id: 'CVE-2026-9999', line: 'ssh - fix (CVE-2026-9999)' }] },
  ];

  it("counts a fix in a later release against Stanley's 6.49.22", () => {
    const r = releaseNoteFixes('6.49.22', notes);
    expect([...r.keys()]).toEqual(['CVE-2026-84411']);
    expect(r.get('CVE-2026-84411')).toEqual({ fixedIn: '6.49.23', line: 'system - improve stability (includes CVE-2026-84411)' });
  });

  it('counts both against an older release, and none against the newest', () => {
    expect([...releaseNoteFixes('6.49.21', notes).keys()].sort()).toEqual(['CVE-2026-67281', 'CVE-2026-84411']);
    expect(releaseNoteFixes('6.49.23', notes).size).toBe(0);
  });

  it('keeps v6 fixes off v7, and uses the earliest release that names a CVE', () => {
    expect(releaseNoteFixes('7.24.5', notes).get('CVE-2026-9999')?.fixedIn).toBe('7.24.6');
    expect(releaseNoteFixes('7.24.6', notes).size).toBe(0);
    expect(releaseNoteFixes('7.24.5', notes).has('CVE-2026-84411')).toBe(false);
  });
});
