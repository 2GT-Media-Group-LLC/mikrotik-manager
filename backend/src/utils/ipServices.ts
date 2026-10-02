/**
 * RouterOS /ip service rows (issue #192).
 *
 * - `/ip service print` also lists live connections as dynamic rows (an open
 *   api-ssl session shows up as a second "api-ssl"). They are not services:
 *   counting or toggling them acted on the wrong row.
 * - The list of addresses a service accepts connections from is
 *   `available-from` on current RouterOS 7 and `address` before that. Reading
 *   only `address` showed every service as open to any address.
 */
import net from 'net';

export type ServiceRow = Record<string, string>;

/** The configured services, without the live-connection rows. */
export function configuredServices(rows: ServiceRow[]): ServiceRow[] {
  return rows.filter((r) => r['dynamic'] !== 'true');
}

/** The property holding a service's allowed addresses on this RouterOS version. */
export function allowedFromKey(row: ServiceRow): 'available-from' | 'address' {
  return 'available-from' in row ? 'available-from' : 'address';
}

/** A service's allowed addresses; empty means any. */
export function allowedFrom(row: ServiceRow): string[] {
  return splitList(row['available-from'] ?? row['address'] ?? '');
}

function splitList(v: string): string[] {
  return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function isAddressOrPrefix(entry: string): boolean {
  const [ip, len, extra] = entry.split('/');
  if (extra !== undefined) return false;
  const family = net.isIP(ip);
  if (!family) return false;
  if (len === undefined) return true;
  if (!/^\d{1,3}$/.test(len)) return false;
  return Number(len) <= (family === 4 ? 32 : 128);
}

/** Validate an allowed-addresses list typed by an operator. Empty means any. */
export function parseAllowedList(input: unknown): { list: string[] } | { error: string } {
  if (typeof input !== 'string') return { error: 'allowed_from must be a string (empty means any address).' };
  const list = splitList(input);
  if (list.length > 64) return { error: 'At most 64 entries.' };
  const bad = list.filter((e) => !isAddressOrPrefix(e));
  if (bad.length) return { error: `Not an IP address or prefix: ${bad.join(', ')}` };
  return { list };
}

function toBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  const family = net.isIP(ip);
  if (family === 4) return { family, value: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n) };
  if (family !== 6) return null;
  const v4tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  let text = ip.toLowerCase();
  if (v4tail) {
    const o = v4tail[2].split('.').map(Number);
    text = `${v4tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail = ''] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = text.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = text.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return { family, value: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
}

/** Is `ip` allowed by `list`? An empty list allows everything. */
export function addressAllowed(ip: string, list: string[]): boolean {
  if (list.length === 0) return true;
  const plain = ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const addr = toBigInt(plain);
  if (!addr) return false;
  return list.some((entry) => {
    const [base, len] = entry.split('/');
    const b = toBigInt(base);
    if (!b || b.family !== addr.family) return false;
    const bits = addr.family === 4 ? 32 : 128;
    const prefix = len === undefined ? bits : Number(len);
    const shift = BigInt(bits - prefix);
    return (addr.value >> shift) === (b.value >> shift);
  });
}

/**
 * The address the device sees the manager connecting from, read from the live
 * connection rows of `service`. With several connections, the one from our own
 * local port is ours; failing that, only an unambiguous single address counts.
 */
export function managerPeer(rows: ServiceRow[], service: string, localPort?: number): string | null {
  const peers = rows
    .filter((r) => r['dynamic'] === 'true' && r['name'] === service && r['remote'])
    .map((r) => {
      const m = /^\[?(.+?)\]?:(\d+)$/.exec(r['remote']);
      return m ? { ip: m[1], port: Number(m[2]) } : null;
    })
    .filter((p): p is { ip: string; port: number } => !!p && !!net.isIP(p.ip));
  const mine = localPort ? peers.find((p) => p.port === localPort) : undefined;
  if (mine) return mine.ip;
  const ips = [...new Set(peers.map((p) => p.ip))];
  return ips.length === 1 ? ips[0] : null;
}
