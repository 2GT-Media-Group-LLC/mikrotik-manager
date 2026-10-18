/**
 * Reading only what the management-path checks need (#313).
 *
 * The WireGuard tunnel check and Change Guard's path model used to read the
 * whole routing table and the whole connection-tracking table. A BGP router
 * carries hundreds of thousands of routes and a busy edge router as many
 * connections, streamed over the API row by row, so the WireGuard page sat on
 * "Loading…" until it timed out.
 *
 * Both checks only ever need:
 *   - the manager's own connection to the API port, to see the manager's
 *     address as the device does;
 *   - the routes that could carry traffic to that address: the ones whose
 *     prefix covers it (the device picks the longest), which always include
 *     the default route.
 * A route that doesn't cover the address can't change either answer, so
 * asking the router for exactly those, one exact-match query per prefix
 * length sent together, gives the same result as the whole table.
 */
import net from 'net';
import type { ReadSpec } from '../mikrotik/RouterOSClient';

type Row = Record<string, string>;
interface Reader {
  executeMany(reads: ReadSpec[], opts?: { timeoutMs?: number }): Promise<Array<{ rows?: Row[]; error?: Error }>>;
}

const ROUTE_FIELDS = '.id,dst-address,gateway,immediate-gw,distance,active,inactive,disabled,type,blackhole,routing-table';

/** "10.1.2.0/24" etc.: the network of `ip` at every prefix length, longest first. */
export function coveringPrefixes(ip: string): string[] {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ip.split('.').reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
    return Array.from({ length: 33 }, (_, i) => 32 - i).map((len) => {
      const masked = len === 0 ? 0n : (n >> BigInt(32 - len)) << BigInt(32 - len);
      const parts = [24n, 16n, 8n, 0n].map((s) => String((masked >> s) & 255n));
      return `${parts.join('.')}/${len}`;
    });
  }
  if (family === 6) {
    const n = ipv6ToBig(ip);
    if (n === null) return [];
    return Array.from({ length: 129 }, (_, i) => 128 - i).map((len) => {
      const masked = len === 0 ? 0n : (n >> BigInt(128 - len)) << BigInt(128 - len);
      return `${bigToIpv6(masked)}/${len}`;
    });
  }
  return [];
}

function ipv6ToBig(ip: string): bigint | null {
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** RFC 5952 form, as RouterOS writes it: lower case, longest zero run as "::". */
function bigToIpv6(n: bigint): string {
  const g = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(112 - i * 16)) & 0xffffn));
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/**
 * The routes whose prefix covers `ip`, or only the default route when the
 * address isn't known. One exact-match query per prefix length, sent
 * together. A failing query throws when `strict` (Change Guard: an unread
 * table must fail the analysis, not read as empty, P2-7); otherwise it
 * counts as no routes there (IPv6 switched off, say).
 */
export async function readCoveringRoutes(reader: Reader, ip: string | null, family: 4 | 6 = 4, strict = true): Promise<Row[]> {
  const menu = family === 6 ? '/ipv6/route/print' : '/ip/route/print';
  const prefixes = ip ? coveringPrefixes(ip) : [family === 6 ? '::/0' : '0.0.0.0/0'];
  if (prefixes.length === 0) return [];
  // A host route may be written with or without its /32 (/128).
  const host = ip ? [ip] : [];
  const results = await reader.executeMany(
    [...prefixes, ...host].map((p) => ({ command: menu, params: { '.proplist': ROUTE_FIELDS }, queries: [`?dst-address=${p}`] })),
  );
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of results) {
    if (r.error && strict) throw r.error;
    for (const row of r.rows ?? []) {
      const key = row['.id'] ?? JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

/**
 * Connection-tracking entries for connections to the device's API: the
 * manager's among them. Asked of the router by address and port, both as
 * RouterOS 7.24 writes them (separate dst-port) and as older versions do
 * ("address:port"). Empty where connection tracking is off.
 */
export async function readApiConnections(reader: Reader, deviceIp: string, apiPort: number): Promise<Row[]> {
  const fields = { '.proplist': '.id,protocol,src-address,src-port,dst-address,dst-port' };
  const v6 = net.isIP(deviceIp) === 6;
  const menu = v6 ? '/ipv6/firewall/connection/print' : '/ip/firewall/connection/print';
  const old = v6 ? `[${deviceIp}]:${apiPort}` : `${deviceIp}:${apiPort}`;
  const results = await reader.executeMany([
    { command: menu, params: fields, queries: [`?dst-address=${deviceIp}`, `?dst-port=${apiPort}`] },
    { command: menu, params: fields, queries: [`?dst-address=${old}`] },
  ]);
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of results) {
    for (const row of r.rows ?? []) {
      const key = row['.id'] ?? JSON.stringify(row);
      if (!seen.has(key)) { seen.add(key); out.push(row); }
    }
  }
  return out;
}
