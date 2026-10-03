/**
 * Device address parsing shared by the Add/Edit Device forms and CSV import.
 *
 * Mirrors backend/src/utils/deviceAddress.ts (kept in sync by hand — the two
 * run in different runtimes and neither project shares code across the
 * frontend/backend boundary). The backend is the source of truth for what is
 * actually accepted; this copy exists so the form can validate and hint
 * before a round trip.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// A bare IPv6 literal always has at least two colons; used to tell
// "2001:db8::1" apart from "host:port" and from a hostname.
const IPV6_SHAPE = /^[0-9a-f:]+$/i;

export function isValidIPv4(v: string): boolean {
  const m = IPV4.exec(v);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

export function isValidIPv6(v: string): boolean {
  return v.includes(':') && v.split(':').length > 2 && IPV6_SHAPE.test(v);
}

export function isValidHostname(v: string): boolean {
  return HOSTNAME.test(v) && !IPV4.test(v);
}

/** IP (v4 or v6) or hostname — what the Add/Edit Device address field accepts. */
export function isValidDeviceAddress(v: string): boolean {
  if (isValidIPv4(v)) return true;
  if (isValidIPv6(v)) return true;
  return isValidHostname(v);
}

/**
 * True if an IP literal is in a range that never leaves a private network —
 * loopback, RFC1918/link-local, CGNAT, or unspecified. Used only for the
 * plaintext-credentials UX hint, never as a security boundary.
 */
export function isPrivateIp(ip: string): boolean {
  if (isValidIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (isValidIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const head = lower.split(':')[0];
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
    if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }
  return false; // hostnames are classified separately (see AddressKind below)
}

export type AddressKind = 'private' | 'public' | 'hostname';

/** Rough classification for the "credentials travel unencrypted" hint. */
export function classifyAddress(address: string): AddressKind {
  if (isValidIPv4(address) || isValidIPv6(address)) {
    return isPrivateIp(address) ? 'private' : 'public';
  }
  return 'hostname';
}

/**
 * Split an accidentally-pasted "host:port" or URL into its address and port,
 * so pasting `https://1.2.3.4:8729/` into the address field fills the port
 * field too instead of failing validation.
 */
export function splitAddressAndPort(raw: string): { address: string; port?: number } {
  let s = raw.trim();
  const schemeMatch = s.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (schemeMatch) s = s.slice(schemeMatch[0].length);
  s = s.split(/[/?#]/)[0];

  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const [, host, portStr] = bracketed;
    return { address: host, ...(portStr ? { port: Number(portStr) } : {}) };
  }

  // Bare IPv6 (multiple colons, no brackets) never carries a trailing port.
  if (s.includes(':') && s.split(':').length > 2) return { address: s };

  const hostPort = s.match(/^([^:]+)(?::(\d+))?$/);
  if (hostPort) {
    const [, host, portStr] = hostPort;
    return { address: host, ...(portStr ? { port: Number(portStr) } : {}) };
  }
  return { address: s };
}

/** "[2001:db8::1]" -> "2001:db8::1". Anything else is returned unchanged. */
export function stripIPv6Brackets(v: string): string {
  const m = /^\[([^\]]+)\]$/.exec(v.trim());
  return m ? m[1] : v;
}

/**
 * What the address field should hold after the user types or pastes `raw`,
 * and a port to move into the API Port field if one came with it.
 *
 * A bracketed IPv6 address is unwrapped whether or not a port follows it.
 * Only unwrapping it when a port followed (#178) left a plain "[2001:db8::1]"
 * in the field, where validation rejected it. Other input is only rewritten
 * when a port was split off, so a half-typed "http://" isn't mangled.
 */
export function addressFieldValue(raw: string): { address: string; port?: number } {
  const split = splitAddressAndPort(raw);
  const t = raw.trim();
  if (t.startsWith('[') && t.includes(']') && isValidIPv6(split.address)) return split;
  if (split.port && split.address !== raw) return split;
  return { address: raw };
}

/**
 * IPv6 written out in full, lowercase ("2001:db8::1" ->
 * "2001:0db8:0000:0000:0000:0000:0000:0001"), so differently written forms of
 * one address compare equal. Null when it isn't IPv6.
 */
function expandIPv6(v: string): string | null {
  const bare = stripIPv6Brackets(v).trim().toLowerCase().split('%')[0];
  if (!isValidIPv6(bare)) return null;
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Do two device addresses name the same host? IPv6 is compared in full, so
 * "[2001:DB8::1]" matches "2001:db8:0:0::1" (#178: an IPv6 management
 * address was flagged as not on the router).
 */
export function sameAddress(a: string, b: string): boolean {
  const x = expandIPv6(a);
  const y = expandIPv6(b);
  if (x || y) return x === y;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * "address:port" with an IPv6 address in brackets, so the port can't be read
 * as part of it ("[2001:db8::1]:8728", not "2001:db8::1:8728"; #198).
 */
export function hostPort(address: string, port: number | string): string {
  const bare = stripIPv6Brackets(address);
  return `${isValidIPv6(bare) ? `[${bare}]` : bare}:${port}`;
}

/**
 * The address as Winbox's Connect To takes it: IPv6 in brackets, without the
 * API port (Winbox uses its own; #198).
 */
export function winboxAddress(address: string): string {
  const bare = stripIPv6Brackets(address);
  return isValidIPv6(bare) ? `[${bare}]` : bare;
}
