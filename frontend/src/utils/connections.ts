/**
 * Rows of a device's connection tracking table, for the Connections tab.
 *
 * RouterOS 7.24 gives the ports their own fields (src-port, dst-port) and
 * leaves the address bare; older versions write "address:port". Asking only
 * for named fields (#300) left the 7.24 ports out altogether, so the tab lost
 * them (discussion #85).
 */
export type Conn = Record<string, string>;

/** An endpoint's address and port, from the port field or the address suffix. */
export function endpoint(c: Conn, side: 'src' | 'dst'): { ip: string; port: string } {
  const addr = c[`${side}-address`] || '';
  const own = c[`${side}-port`];
  if (own) return { ip: addr, port: own };
  // "[2001:db8::1]:443" or "192.0.2.1:443"; a bare IPv6 address has no port.
  const bracket = /^\[(.+)\]:(\d+)$/.exec(addr);
  if (bracket) return { ip: bracket[1], port: bracket[2] };
  const i = addr.lastIndexOf(':');
  if (i > 0 && addr.indexOf(':') === i) return { ip: addr.slice(0, i), port: addr.slice(i + 1) };
  return { ip: addr, port: '' };
}

/** A RouterOS rate ("12.5kbps", "3Mbps", "800bps" or a plain number) in bits per second. */
export function rateBps(v: string | undefined): number {
  const m = /^([\d.]+)\s*([kKMG]?)/.exec(v ?? '');
  if (!m) return 0;
  const mult = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2] as '' | 'k' | 'K' | 'M' | 'G'] ?? 1;
  return parseFloat(m[1]) * mult;
}

export type ConnSortKey = 'proto' | 'src' | 'sport' | 'dst' | 'dport' | 'state' | 'rate' | 'bytes';

/** IPv4 addresses in numeric order; anything else after, as text. */
function ipKey(ip: string): string {
  const p = ip.split('.');
  if (p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x))) return p.map((x) => x.padStart(3, '0')).join('.');
  return `~${ip.toLowerCase()}`;
}

function value(c: Conn, key: ConnSortKey): string | number {
  switch (key) {
    case 'proto': return (c.protocol || '').toLowerCase();
    case 'src': return ipKey(endpoint(c, 'src').ip);
    case 'dst': return ipKey(endpoint(c, 'dst').ip);
    case 'sport': return Number(endpoint(c, 'src').port) || 0;
    case 'dport': return Number(endpoint(c, 'dst').port) || 0;
    case 'state': return (c['tcp-state'] || c.state || '').toLowerCase();
    case 'rate': return rateBps(c['orig-rate']) + rateBps(c['repl-rate']);
    case 'bytes': return (Number(c['orig-bytes']) || 0) + (Number(c['repl-bytes']) || 0);
  }
}

export function sortConnections(rows: Conn[], key: ConnSortKey, dir: 'asc' | 'desc'): Conn[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a, key);
    const y = value(b, key);
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}
