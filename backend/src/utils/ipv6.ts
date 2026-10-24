import { isIPv6 } from 'net';

/**
 * IPv6 literals parsed into their eight 16-bit groups, for address guards
 * (GHSA-28hr-v457-cc6g). The guards used to match text: `::ffff:127.0.0.1`
 * was caught, but the same address written `::ffff:7f00:1`, or loopback as
 * `0:0:0:0:0:0:0:1`, passed as an ordinary public address.
 */
export function expandIpv6(ip: string): number[] | null {
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!isIPv6(addr)) return null;
  let text = addr;
  // A trailing dotted quad is two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const o = quad.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    text = text.slice(0, quad.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * The IPv4 address an IPv6 literal carries, when it carries one in a form
 * that reaches that IPv4 host: IPv4-mapped (::ffff:0:0/96), IPv4-translated
 * (::ffff:0:0:0/96), IPv4-compatible (::/96, apart from :: and ::1) and the
 * NAT64 well-known prefix (64:ff9b::/96). Null otherwise.
 */
export function embeddedIpv4(groups: number[]): string | null {
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return dotted(groups[6], groups[7]);
  if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return dotted(groups[6], groups[7]);
  if (zeros(0, 6) && !(groups[6] === 0 && groups[7] <= 1)) return dotted(groups[6], groups[7]);
  return null;
}

export function isUnspecifiedOrLoopback6(groups: number[]): boolean {
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1;
}
