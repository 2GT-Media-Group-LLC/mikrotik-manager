import type { FleetCveReport } from '../services/cveFeed';

/**
 * Which CVE matches are worth an alert (#224): ones that certainly apply to a
 * RouterOS version the fleet runs, and are known to be exploited or rated
 * critical or high. Each (CVE, version) pair is announced once; `alerted`
 * holds the pairs already announced.
 */
export interface CveAlertItem {
  version: string;
  devices: string[];
  cves: { id: string; severity: string | null; known_exploited: boolean; fixed_in: string | null }[];
}

const SERIOUS = new Set(['CRITICAL', 'HIGH']);
export const cveAlertKey = (cveId: string, version: string) => `${cveId}@${version}`;

export function cveAlertsFor(report: FleetCveReport, alerted: ReadonlySet<string>): { items: CveAlertItem[]; current: string[] } {
  const items: CveAlertItem[] = [];
  const current: string[] = [];
  for (const v of report.versions) {
    const serious = v.cves.filter((c) => !c.uncertain && (c.known_exploited || SERIOUS.has((c.severity ?? '').toUpperCase())));
    current.push(...serious.map((c) => cveAlertKey(c.id, v.version)));
    const fresh = serious.filter((c) => !alerted.has(cveAlertKey(c.id, v.version)));
    if (fresh.length === 0) continue;
    items.push({
      version: v.version,
      devices: v.devices.map((d) => d.name.trim()),
      cves: fresh.map((c) => ({ id: c.id, severity: c.severity, known_exploited: c.known_exploited, fixed_in: c.fixed_in })),
    });
  }
  return { items, current };
}

/** The alert text: one line per affected version. */
export function cveAlertMessage(items: CveAlertItem[]): { message: string; details: string } {
  const count = items.reduce((n, i) => n + i.cves.length, 0);
  const message = `${count} serious RouterOS CVE${count === 1 ? '' : 's'} affect${count === 1 ? 's' : ''} devices in the fleet`;
  const details = items.map((i) => {
    const list = i.cves.map((c) => `${c.id}${c.known_exploited ? ' (exploited)' : ''}${c.fixed_in ? `, fixed in ${c.fixed_in}` : ''}`).join('; ');
    const devs = i.devices.length > 5 ? `${i.devices.slice(0, 5).join(', ')} and ${i.devices.length - 5} more` : i.devices.join(', ');
    return `RouterOS ${i.version} (${devs}): ${list}`;
  }).join('\n');
  return { message, details };
}
