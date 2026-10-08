/**
 * DHCP pool usage (#156): how full each address pool is, the one quiet DHCP
 * failure (an exhausted pool) worth watching. Pure, so it can be tested
 * without a device.
 *
 * Pool ranges as RouterOS writes them: "192.168.88.10-192.168.88.254",
 * "10.0.0.0/24", a single address, or several separated by commas. IPv4 only;
 * an IPv6 pool hands out prefixes and doesn't run out the same way.
 */
import { isIPv4 } from 'net';

const toInt = (ip: string): number | null => {
  if (!isIPv4(ip)) return null;
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
};

/** Number of addresses in a pool's ranges; null when they can't be read. */
export function poolSize(ranges: string | undefined): number | null {
  let total = 0;
  const parts = (ranges || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p.includes('/')) {
      const [base, lenRaw] = p.split('/');
      const len = Number(lenRaw);
      if (toInt(base) === null || !Number.isInteger(len) || len < 0 || len > 32) return null;
      total += 2 ** (32 - len);
    } else if (p.includes('-')) {
      const [a, b] = p.split('-').map((s) => toInt(s.trim()));
      if (a === null || b === null || b < a) return null;
      total += b - a + 1;
    } else {
      if (toInt(p) === null) return null;
      total += 1;
    }
  }
  return total;
}

/** Used addresses per pool, from /ip/pool/used. */
export function usedPerPool(rows: Record<string, string>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) if (r['pool']) out.set(r['pool'], (out.get(r['pool']) ?? 0) + 1);
  return out;
}

export const POOL_WARN_PCT = 80;
export const POOL_FULL_PCT = 95;

export function poolState(used: number, size: number | null): 'full' | 'warn' | null {
  if (!size) return null;
  const pct = (used / size) * 100;
  return pct >= POOL_FULL_PCT ? 'full' : pct >= POOL_WARN_PCT ? 'warn' : null;
}
