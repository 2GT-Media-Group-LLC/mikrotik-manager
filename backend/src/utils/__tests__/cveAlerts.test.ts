import { cveAlertsFor, cveAlertMessage, cveAlertKey } from '../cveAlerts';
import type { FleetCveReport } from '../../services/cveFeed';

const cve = (id: string, over: Partial<FleetCveReport['versions'][number]['cves'][number]> = {}) => ({
  id, severity: 'MEDIUM', score: 5, known_exploited: false, published: null, summary: '', fixed_in: '7.24.2',
  hardware_specific: false, uncertain: null, ...over,
});
const report = {
  enabled: true, fetched_at: null, last_error: null, total_cves: 4, unranged: 0,
  versions: [
    {
      version: '7.24.1', devices: [{ id: 1, name: 'sw1' }, { id: 2, name: 'sw2 ' }], corrected: [],
      cves: [
        cve('CVE-2026-67277', { severity: 'HIGH', known_exploited: true }),
        cve('CVE-2026-1111', { severity: 'CRITICAL' }),
        cve('CVE-2026-2222'),                                          // medium: no alert
        cve('CVE-2026-3333', { severity: 'HIGH', uncertain: 'v6 only' }), // uncertain: no alert
      ],
    },
    { version: '7.24.4', devices: [{ id: 3, name: 'ap1' }], corrected: [], cves: [] },
  ],
} as FleetCveReport;

describe('CVE alerts (#224)', () => {
  it('alerts on certain matches that are exploited, critical or high', () => {
    const { items, current } = cveAlertsFor(report, new Set());
    expect(items).toHaveLength(1);
    expect(items[0].cves.map((c) => c.id)).toEqual(['CVE-2026-67277', 'CVE-2026-1111']);
    expect(items[0].devices).toEqual(['sw1', 'sw2']);
    expect(current).toEqual([cveAlertKey('CVE-2026-67277', '7.24.1'), cveAlertKey('CVE-2026-1111', '7.24.1')]);
  });
  it('announces each CVE and version pair once', () => {
    const { items } = cveAlertsFor(report, new Set([cveAlertKey('CVE-2026-67277', '7.24.1')]));
    expect(items[0].cves.map((c) => c.id)).toEqual(['CVE-2026-1111']);
    expect(cveAlertsFor(report, new Set(cveAlertsFor(report, new Set()).current)).items).toEqual([]);
  });
  it('writes a readable message', () => {
    const { message, details } = cveAlertMessage(cveAlertsFor(report, new Set()).items);
    expect(message).toBe('2 serious RouterOS CVEs affect devices in the fleet');
    expect(details).toBe('RouterOS 7.24.1 (sw1, sw2): CVE-2026-67277 (exploited), fixed in 7.24.2; CVE-2026-1111, fixed in 7.24.2');
  });
});
