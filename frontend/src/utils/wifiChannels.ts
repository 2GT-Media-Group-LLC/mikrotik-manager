// WiFi channel helpers for the RF Health panels.
//
// Maps RouterOS radio frequencies (MHz) to a band + channel number, supplies the
// canonical channel lists each band's channel map renders, and provides the
// bucketing used by the TX-retries histogram and the RSSI density scale.

export type RfBand = '2.4' | '5' | '6';

// Canonical channel scales shown on the channel map (mirrors what UniFi displays).
export const CHANNELS_24: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const CHANNELS_5: number[] = [
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128,
  132, 136, 140, 144, 149, 153, 157, 161, 165,
];
// 6 GHz: channels 1..233 in steps of 4
export const CHANNELS_6: number[] = Array.from({ length: 59 }, (_, i) => 1 + i * 4);

export const BAND_CHANNELS: Record<RfBand, number[]> = {
  '2.4': CHANNELS_24,
  '5': CHANNELS_5,
  '6': CHANNELS_6,
};

export const BAND_LABEL: Record<RfBand, string> = {
  '2.4': '2.4 GHz',
  '5': '5 GHz',
  '6': '6 GHz',
};

/** Classify a frequency (MHz) into a coarse RF band, or null if unrecognized. */
export function bandForFreq(freq: number): RfBand | null {
  if (freq >= 2400 && freq < 2500) return '2.4';
  if (freq >= 4900 && freq < 5925) return '5';
  if (freq >= 5925 && freq <= 7125) return '6';
  return null;
}

/** Convert a frequency (MHz) to its channel number for the appropriate band. */
export function channelForFreq(freq: number): number | null {
  const band = bandForFreq(freq);
  if (band === '2.4') return freq === 2484 ? 14 : Math.round((freq - 2407) / 5);
  if (band === '5') return Math.round((freq - 5000) / 5);
  if (band === '6') return Math.round((freq - 5950) / 5);
  return null;
}

/** Parse a RouterOS channel-width string to its width in MHz (best effort). */
export function widthMhz(width: string | undefined): number {
  if (!width) return 20;
  const m = width.match(/(\d+)/);
  const n = m ? parseInt(m[1], 10) : 20;
  // RouterOS strings like "20/40/80mhz" report the smallest first; take the max present.
  const all = (width.match(/\d+/g) || []).map(Number).filter(v => v >= 20 && v <= 160);
  return all.length ? Math.max(...all) : (n >= 20 ? n : 20);
}

// ─── RSSI density helpers ──────────────────────────────────────────────────

export interface RssiBand { label: string; min: number; max: number; color: string }

/**
 * Signal-quality zones across the −90…−30 dBm scale (weak → excellent).
 *
 * Boundaries at −70 / −55 / −45, reported from the field: an average
 * smartphone drops off a network at around −75 dBm, and −85 is effectively the
 * noise floor in ordinary conditions. The previous set called −65 "Good" and
 * −75 merely "Fair", which flattered a signal most clients could not hold
 * (#154).
 *
 * This is not only a recalibration. The app already disagreed with itself:
 * RadiosTab coloured signals at −55/−70/−85 while this said −60/−70/−80, so
 * the same client read differently on two pages. Both now come from here.
 *
 * Poor extends to −100 rather than stopping at −85 so that nothing falls
 * outside a zone; the chart clamps to RSSI_MIN for drawing regardless.
 * Dedicated point-to-point radios — SXTsq, GrooveA and the like — run happily
 * near −80 and will read Poor here, which is a limitation of one scale for two
 * very different jobs.
 */
export const RSSI_ZONES: RssiBand[] = [
  { label: 'Poor',      min: -100, max: -70, color: '#ef4444' },
  { label: 'Fair',      min: -70,  max: -55, color: '#f59e0b' },
  { label: 'Good',      min: -55,  max: -45, color: '#84cc16' },
  { label: 'Excellent', min: -45,  max: -20, color: '#22c55e' },
];

export function rssiColor(dbm: number): string {
  for (const z of RSSI_ZONES) if (dbm >= z.min && dbm < z.max) return z.color;
  return dbm >= -20 ? '#22c55e' : '#ef4444';
}

// ─── TX-retry histogram buckets (mirrors UniFi's 0%..35%+ scale) ─────────────

export interface RetryBucket { label: string; min: number; max: number }
export const RETRY_BUCKETS: RetryBucket[] = [
  { label: '0%',   min: 0,  max: 2.5 },
  { label: '5%',   min: 2.5, max: 7.5 },
  { label: '10%',  min: 7.5, max: 12.5 },
  { label: '15%',  min: 12.5, max: 17.5 },
  { label: '20%',  min: 17.5, max: 22.5 },
  { label: '25%',  min: 22.5, max: 30 },
  { label: '35%+', min: 30,  max: 101 },
];

export function retryBucketIndex(pct: number): number {
  for (let i = 0; i < RETRY_BUCKETS.length; i++) {
    if (pct >= RETRY_BUCKETS[i].min && pct < RETRY_BUCKETS[i].max) return i;
  }
  return RETRY_BUCKETS.length - 1;
}

/** Color for a retry %: green (low) → red (high). */
export function retryColor(pct: number): string {
  if (pct < 5) return '#22c55e';
  if (pct < 10) return '#84cc16';
  if (pct < 20) return '#f59e0b';
  return '#ef4444';
}
