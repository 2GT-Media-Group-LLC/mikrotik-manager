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
