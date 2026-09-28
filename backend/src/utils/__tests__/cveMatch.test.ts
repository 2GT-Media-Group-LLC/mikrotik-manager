import fixture from './fixtures-nvd-routeros.json';
import { parseNvdResponse, parseKevResponse, affects, fixedIn, versionInRange, rangeFromCpeMatch } from '../cveMatch';

// Real NVD 2.0 entries for RouterOS (fetched 2026-09-28).
const cves = parseNvdResponse(fixture);
const byId = (id: string) => cves.find((c) => c.id === id)!;

describe('parseNvdResponse', () => {
  it('reads every RouterOS range of a CVE, one per release line', () => {
    const c = byId('CVE-2026-67277');
    expect(c.ranges).toEqual([
      { startIncluding: '6.0', endExcluding: '6.49.21' },
      { startIncluding: '7.0', endExcluding: '7.23.4' },
      { startIncluding: '7.24', endExcluding: '7.24.2' },
    ]);
    expect(c.score).toBe(8.8);
    expect(c.severity).toBe('HIGH');
    expect(c.cvssVersion).toBe('4.0');
  });

  it('marks a CVE listed for "all versions" with no range as unranged, not as affecting everything', () => {
    const c = byId('CVE-2018-5951');
    expect(c.unranged).toBe(true);
    expect(affects(c, '7.24.4')).toBe(false);
  });
});

describe('matching', () => {
  const kev = byId('CVE-2026-67277');

  it('flags versions inside a range and clears versions past the fix', () => {
    expect(affects(kev, '6.48.6')).toBe(true);
    expect(affects(kev, '6.49.21')).toBe(false);
    expect(affects(kev, '7.23.3')).toBe(true);
    expect(affects(kev, '7.23.4')).toBe(false);
    expect(affects(kev, '7.24.1')).toBe(true);
    expect(affects(kev, '7.24.4')).toBe(false);   // this fleet
  });

  it('names the first fixed release on the matching line', () => {
    expect(fixedIn(kev, '6.48.6')).toBe('6.49.21');
    expect(fixedIn(kev, '7.24.1')).toBe('7.24.2');
  });

  it('matches an exact version, including release candidates', () => {
    expect(rangeFromCpeMatch({ criteria: 'cpe:2.3:o:mikrotik:routeros:6.42:rc11:*:*:*:*:*:*', vulnerable: true }))
      .toEqual({ exact: '6.42rc11' });
    expect(versionInRange('6.42rc11', { exact: '6.42rc11' })).toBe(true);
    expect(versionInRange('6.42', { exact: '6.42rc11' })).toBe(false);
  });

  it('treats a bound that is not a version as no usable range (NVD lists CVE-2021-3014 up to "2021-01-04")', () => {
    const [c] = parseNvdResponse({ vulnerabilities: [{ cve: {
      id: 'CVE-2021-3014',
      configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:o:mikrotik:routeros:*:*:*:*:*:*:*:*', versionEndIncluding: '2021-01-04' }] }] }],
    } }] });
    expect(c.unranged).toBe(true);
    expect(affects(c, '7.24.4')).toBe(false);
  });

  it('ignores other products and non-vulnerable entries', () => {
    expect(rangeFromCpeMatch({ criteria: 'cpe:2.3:h:mikrotik:rb750:-:*:*:*:*:*:*:*', vulnerable: false })).toBeUndefined();
    expect(rangeFromCpeMatch({ criteria: 'cpe:2.3:o:mikrotik:routeros:6.40:*:*:*:*:*:*:*', vulnerable: false })).toBeUndefined();
  });
});

describe('parseKevResponse', () => {
  it('collects only MikroTik entries', () => {
    const ids = parseKevResponse({ vulnerabilities: [
      { cveID: 'CVE-2026-67277', vendorProject: 'MikroTik' },
      { cveID: 'CVE-2021-44228', vendorProject: 'Apache' },
    ] });
    expect([...ids]).toEqual(['CVE-2026-67277']);
  });
});
