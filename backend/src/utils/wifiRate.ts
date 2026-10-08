/**
 * A Wi-Fi client's link rate, in bits per second (#252).
 *
 * The wifi package gives a bare number of bits per second ("576500000"); the
 * legacy driver and legacy CAPsMAN give text with the rate first
 * ("130Mbps-20MHz/2S", "1Mbps", "72.2Mbps-20MHz/1S/SGI"). Null when there is
 * no usable figure.
 */
export function parseRateBps(v: string | undefined | null): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  // "<number><k|M|G>bps…", read by position rather than a regular expression.
  const at = s.toLowerCase().indexOf('bps');
  if (at < 2) return null;
  const mult = ({ k: 1e3, m: 1e6, g: 1e9 } as Record<string, number>)[s[at - 1].toLowerCase()];
  const num = s.slice(0, at - 1).trim();
  if (!mult || num === '' || !/^[0-9.]+$/.test(num)) return null;
  const n = Math.round(Number(num) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}
