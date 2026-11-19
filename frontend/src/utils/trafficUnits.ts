/**
 * Traffic charts as volume per chart point (the bytes and packets each point
 * adds up) or as rates, the way links are rated and monitored: bits and
 * packets per second. Settings → General → Appearance → Traffic graphs.
 */
import { formatBytes } from './formatBytes';

export type TrafficUnits = 'volume' | 'rate';

/** Decimal, as link speeds are: 1 Kbps is 1,000 bits per second. */
function scaled(n: number, unit: string): string {
  if (!Number.isFinite(n) || n <= 0) return `0 ${unit}`;
  for (const [div, prefix] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= div) return `${(n / div).toFixed(n / div >= 100 ? 0 : 1)} ${prefix}${unit}`;
  }
  return `${Math.round(n)} ${unit}`;
}

/** 950 bps, 12.4 Kbps, 150 Mbps, 1.2 Gbps. */
export const formatBitRate = (bitsPerSecond: number): string => scaled(bitsPerSecond, 'bps');

/** 40 pps, 1.5 Kpps, 150 Kpps, 2.1 Mpps. */
export const formatPacketRate = (packetsPerSecond: number): string => scaled(packetsPerSecond, 'pps');

/** A count over the seconds a point covers, per second; the count itself without them. */
export function perSecond(count: number, seconds: number | undefined): number {
  return seconds && seconds > 0 ? count / seconds : count;
}

/** How a chart's bytes and packets are shown in the chosen units. */
export function trafficFormat(units: TrafficUnits, formatCount: (n: number) => string) {
  const rate = units === 'rate';
  return {
    rate,
    /** A point's bytes, as plotted: bits per second, or bytes. */
    bytes: (bytes: number, seconds?: number) => (rate ? perSecond(bytes * 8, seconds) : bytes),
    /** A point's packets, as plotted: packets per second, or packets. */
    packets: (packets: number, seconds?: number) => (rate ? perSecond(packets, seconds) : packets),
    bytesLabel: rate ? formatBitRate : formatBytes,
    packetsLabel: rate ? formatPacketRate : (n: number) => `${formatCount(n)} pkts`,
    packetsAxis: rate ? formatPacketRate : formatCount,
  };
}
