/**
 * Rogue-AP inputs from the database, shared by the Wireless page and the
 * Operations insights (outside review J7).
 *
 * Our hardware (BSSIDs and interface MACs) is fleet-wide: an AP of yours in
 * another site is still yours. Our SSIDs are per site: a neighbour at one
 * customer broadcasting "Guest" isn't an evil twin because another customer's
 * managed AP is also called "Guest".
 */
import { query } from '../config/database';
import { siteScopeByDevice, type SiteScope } from '../utils/siteScope';
import { classifyScans, type ScannedNetwork } from '../utils/rogueAp';

export async function classifyLatestScans(scope: SiteScope) {
  const scanFilter = siteScopeByDevice(scope, 'a.device_id');
  const [scans, radios, ifaceMacs] = await Promise.all([
    query<{ device_id: number; device_name: string; site_id: number | null; scanned_at: string; data: unknown }>(`
      SELECT DISTINCT ON (a.device_id) a.device_id, d.name AS device_name, d.site_id, a.scanned_at, a.data
      FROM ap_scan_data a JOIN devices d ON d.id = a.device_id
      ${scanFilter ? `WHERE ${scanFilter}` : ''}
      ORDER BY a.device_id, a.scanned_at DESC`),
    query<{ ssid: string | null; mac_address: string | null; frequency: number | null; site_id: number | null }>(
      `SELECT wi.ssid, wi.mac_address, wi.frequency, d.site_id
         FROM wireless_interfaces wi JOIN devices d ON d.id = wi.device_id`),
    query<{ mac_address: string }>(`SELECT mac_address FROM interfaces WHERE mac_address IS NOT NULL`),
  ]);

  const ownSsidsBySite = new Map<number | null, Set<string>>();
  for (const r of radios) {
    if (!r.ssid) continue;
    const set = ownSsidsBySite.get(r.site_id) ?? new Set<string>();
    set.add(r.ssid);
    ownSsidsBySite.set(r.site_id, set);
  }
  const ownBssids = new Set([
    ...radios.map((r) => (r.mac_address || '').toLowerCase()).filter(Boolean),
    ...ifaceMacs.map((r) => r.mac_address.toLowerCase()),
  ]);
  const ownRadioFreqs = new Map<string, number>();
  for (const r of radios) {
    if (r.mac_address && r.frequency) ownRadioFreqs.set(r.mac_address.toLowerCase(), Number(r.frequency));
  }

  const records = scans.map((s) => ({
    deviceName: s.device_name,
    siteId: s.site_id,
    scannedAt: String(s.scanned_at),
    networks: Array.isArray(s.data) ? (s.data as ScannedNetwork[]) : [],
  }));
  return { ...classifyScans(records, ownSsidsBySite, ownBssids, ownRadioFreqs), scans };
}
