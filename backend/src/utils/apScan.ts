/**
 * Combine nearby-AP scan rows (from every radio on a device) into one list of
 * networks, each with the BSSIDs and bands it was seen on.
 *
 * The two wireless packages name things differently (#295):
 *   wifi (RouterOS 7):  signal, security ("wpa2-psk,wpa3-psk"), ssid, address, channel
 *   wireless (legacy):  sig, privacy (true/false flag), ssid, address, channel ("2412/20-Ce/gn")
 * Reading only the first set left every legacy network at -100 dBm and "open".
 */

export interface APBandEntry {
  bssid: string; vendor: string; signal: number;
  freq: number; band: string; channel_width: string;
}
export interface APNetworkEntry {
  ssid: string; security: string; hidden: boolean; entries: APBandEntry[];
}

const NO_SIGNAL = -100;

function normBand(band: string, freq: number): string {
  if (band.includes('6ghz') || freq >= 5925) return '6 GHz';
  if (band.includes('5ghz') || (freq >= 4900 && freq < 5925)) return '5 GHz';
  return '2.4 GHz';
}

const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

/** Signal in dBm, from whichever field the package reports. */
export function scanSignal(row: Record<string, string>): number {
  const raw = row['signal'] ?? row['signal-strength'] ?? row['sig'];
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : NO_SIGNAL;
}

/**
 * What the AP asks of clients: its auth types, "secured" when only the legacy
 * privacy flag says so, "open", or "unknown" when the scan didn't say (#295).
 */
export function scanSecurity(row: Record<string, string>): string {
  if (row['security']) return row['security'];
  if (row['authentication-types']) return 'WPA';
  // The legacy package only says whether the network is encrypted, not how.
  if ('privacy' in row) return isTrue(row['privacy']) ? 'secured' : 'open';
  // A legacy scan (it reports `sig`) that doesn't include the privacy flag
  // says nothing about security; calling that "open" was wrong (#295). The
  // wifi package leaves security out for an open network.
  if ('sig' in row && !('signal' in row)) return 'unknown';
  return 'open';
}

export function aggregateAPScanRows(
  allRows: { iface: string; rows: Record<string, string>[] }[],
  lookupVendor: (mac: string) => string,
): APNetworkEntry[] {
  const byKey = new Map<string, APNetworkEntry>();

  for (const { rows } of allRows) {
    for (const row of rows) {
      const ssid = row['network-name'] || row['ssid'] || '';
      const bssid = (row['address'] || row['bssid'] || '').toLowerCase();
      if (!bssid) continue;
      const signal = scanSignal(row);
      const freq = parseFloat(row['frequency'] || row['channel'] || '0');
      const band = normBand(row['band'] || row['radio-band'] || '', freq);
      const security = scanSecurity(row);
      const channelWidth = row['channel-width'] || '';
      const key = ssid || `hidden:${bssid}`;

      if (!byKey.has(key)) byKey.set(key, { ssid, security, hidden: !ssid, entries: [] });
      const net = byKey.get(key)!;
      // A streaming scan repeats rows; an early one may lack fields a later one has.
      if ((net.security === 'open' || net.security === 'unknown') && security !== 'open' && security !== 'unknown') net.security = security;
      const existing = net.entries.find((e) => e.bssid === bssid && e.freq === freq);
      if (existing) {
        if (signal > existing.signal) existing.signal = signal;
      } else {
        net.entries.push({ bssid, vendor: lookupVendor(bssid), signal, freq, band, channel_width: channelWidth });
      }
    }
  }

  return Array.from(byKey.values()).sort((a, b) =>
    Math.max(...b.entries.map((e) => e.signal)) - Math.max(...a.entries.map((e) => e.signal)));
}
