// Rogue / neighbor AP classification over stored AP-scan results.
//
// A scanned BSSID falls into one of three buckets:
//  - ours:     the BSSID belongs to a managed radio → ignored
//  - ROGUE:    broadcasts one of OUR SSIDs from a BSSID we don't own — an evil
//              twin / SSID spoof, the classic WiFi attack Mist/UniFi alert on
//  - neighbor: any other foreign AP — inventory, ranked by signal

export interface ScannedEntry {
  bssid: string; vendor?: string; signal: number; freq?: number;
  band?: string; channel_width?: string;
}
export interface ScannedNetwork {
  ssid: string; security?: string; hidden?: boolean; entries: ScannedEntry[];
}
export interface ScanRecord {
  deviceName: string;
  /** Site of the scanning device, for per-site SSID matching (J7). */
  siteId?: number | null;
  scannedAt: string;
  networks: ScannedNetwork[];
}

export interface RogueAp {
  ssid: string; bssid: string; vendor: string; signal: number; band: string;
  seenBy: string; scannedAt: string;
  /**
   * 'ssid': a foreign BSSID broadcasting one of the site's SSIDs.
   * 'bssid': one of our own BSSIDs heard on a channel that radio isn't on, so
   * a spoofed copy of our hardware address (J7).
   */
  reason?: 'ssid' | 'bssid';
}
export interface NeighborAp {
  ssid: string; bssid: string; vendor: string; signal: number; band: string;
  security: string; seenBy: string; scannedAt: string;
}

export function classifyScans(
  scans: ScanRecord[],
  // SSIDs our managed radios broadcast: one set for everything, or one per
  // site (J7), so a neighbour at one customer isn't a rogue because another
  // customer happens to use the same name.
  ownSsids: Set<string> | Map<number | null, Set<string>>,
  ownBssids: Set<string>,  // every MAC we own (radio + interface MACs, lowercase)
  // Where each of our radios operates (MHz), by BSSID. Our own BSSID heard
  // elsewhere is a spoofed copy, not our radio (J7).
  ownRadioFreqs: Map<string, number> = new Map(),
): { rogues: RogueAp[]; neighbors: NeighborAp[] } {
  const rogueByBssid = new Map<string, RogueAp>();
  const neighborByBssid = new Map<string, NeighborAp>();

  for (const scan of scans) {
    const siteSsids = ownSsids instanceof Map ? (ownSsids.get(scan.siteId ?? null) ?? new Set<string>()) : ownSsids;
    for (const net of scan.networks) {
      for (const e of net.entries) {
        const bssid = (e.bssid || '').toLowerCase();
        if (!bssid) continue;
        if (ownBssids.has(bssid)) {
          const ours = ownRadioFreqs.get(bssid);
          // More than 20 MHz from where our radio is: a different channel.
          if (ours && e.freq && Math.abs(e.freq - ours) > 20) {
            const prev = rogueByBssid.get(bssid);
            if (!prev || e.signal > prev.signal) {
              rogueByBssid.set(bssid, {
                ssid: net.ssid || '(hidden)', bssid, vendor: e.vendor || '', signal: e.signal,
                band: e.band || '', seenBy: scan.deviceName, scannedAt: scan.scannedAt, reason: 'bssid',
              });
            }
          }
          continue; // our own radio, where it should be
        }

        if (net.ssid && siteSsids.has(net.ssid)) {
          const prev = rogueByBssid.get(bssid);
          if (!prev || e.signal > prev.signal) {
            rogueByBssid.set(bssid, {
              ssid: net.ssid, bssid, vendor: e.vendor || '', signal: e.signal,
              band: e.band || '', seenBy: scan.deviceName, scannedAt: scan.scannedAt, reason: 'ssid',
            });
          }
        } else {
          const prev = neighborByBssid.get(bssid);
          if (!prev || e.signal > prev.signal) {
            neighborByBssid.set(bssid, {
              ssid: net.ssid || '(hidden)', bssid, vendor: e.vendor || '', signal: e.signal,
              band: e.band || '', security: net.security || '',
              seenBy: scan.deviceName, scannedAt: scan.scannedAt,
            });
          }
        }
      }
    }
  }

  return {
    rogues: [...rogueByBssid.values()].sort((a, b) => b.signal - a.signal),
    neighbors: [...neighborByBssid.values()].sort((a, b) => b.signal - a.signal),
  };
}
