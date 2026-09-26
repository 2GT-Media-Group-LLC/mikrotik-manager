// Device address parsing (#IP-or-hostname upgrade).
//
// The "Add Device" flow originally only worked with LAN IPv4 addresses in
// practice: nothing rejected a hostname or public IP, but nothing helped
// with one either — no validation, no normalisation of a pasted URL, and
// devices.ip_address was VARCHAR(45) which silently truncated a long FQDN.
// This module is the single place that decides what counts as a usable
// device address, shared by device creation/update and the frontend forms.

import { isIPv4, isIPv6 } from 'net';

// RFC 1123 hostname/FQDN: labels of 1-63 chars, alphanumeric with internal
// hyphens, dot-separated, 253 chars overall. Matches the pattern already
// used for CSV import on the frontend.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

// A dotted-quad shape (four all-digit labels) is never a real hostname label,
// so "999.999.999.999" must be judged as an IPv4 address (and rejected) —
// not fall through to the hostname pattern, which would otherwise accept it.
const DOTTED_QUAD_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface NormalizedAddress {
  ok: true;
  /** The address to store/connect with — an IP literal or a lowercased hostname. */
  address: string;
  /** Present when a "host:port" or URL form supplied a port, so the caller can offer it. */
  port?: number;
}

export interface InvalidAddress {
  ok: false;
  reason: string;
}

/**
 * Trim, unwrap an accidentally-pasted URL, and validate that what remains is
 * an IPv4 address, IPv6 address, or hostname. Does not resolve DNS — that
 * happens (and is meant to happen, since DDNS/public endpoints move) at
 * connect time.
 */
export function normalizeDeviceAddress(raw: string): NormalizedAddress | InvalidAddress {
  let s = (raw || '').trim();
  if (!s) return { ok: false, reason: 'Address is required' };

  let port: number | undefined;

  // A pasted URL like "https://1.2.3.4:8729/" or "api-ssl://router.example.com" —
  // strip the scheme and anything after the host[:port].
  const schemeMatch = s.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (schemeMatch) s = s.slice(schemeMatch[0].length);
  s = s.split(/[/?#]/)[0];

  // Bracketed IPv6, optionally with a port: "[::1]:8728"
  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const [, host, portStr] = bracketed;
    if (!isIPv6(host)) return { ok: false, reason: `"${raw}" is not a valid IPv6 address` };
    if (portStr) port = Number(portStr);
    return { ok: true, address: host, ...(port ? { port } : {}) };
  }

  // Bare IPv6 has multiple colons and no brackets — never has a trailing port
  // in that form, since "::" would be ambiguous with it.
  if (s.includes(':') && s.split(':').length > 2) {
    if (!isIPv6(s)) return { ok: false, reason: `"${raw}" is not a valid IPv6 address` };
    return { ok: true, address: s };
  }

  // IPv4 or hostname, optionally with a single ":port" suffix.
  const hostPort = s.match(/^([^:]+)(?::(\d+))?$/);
  if (hostPort) {
    const [, host, portStr] = hostPort;
    if (portStr) port = Number(portStr);
    if (isIPv4(host)) return { ok: true, address: host, ...(port ? { port } : {}) };
    if (DOTTED_QUAD_SHAPE.test(host)) return { ok: false, reason: `"${raw}" is not a valid IPv4 address` };
    if (HOSTNAME_RE.test(host)) return { ok: true, address: host.toLowerCase(), ...(port ? { port } : {}) };
  }

  return { ok: false, reason: `"${raw}" is not a valid IP address or hostname` };
}

/**
 * True if an IP literal is in a range that never leaves a private network —
 * loopback, RFC1918/link-local, CGNAT, or unspecified/multicast/reserved.
 * Used both to keep webhooks off internal addresses (SSRF) and, here, to
 * decide whether a device address is reachable only on a local network.
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true;               // this-net, private, loopback
    if (a === 169 && b === 254) return true;                          // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                 // private
    if (a === 192 && b === 168) return true;                         // private
    if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
    if (a >= 224) return true;                                        // multicast/reserved/broadcast
    return false;
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // IPv4-mapped (::ffff:1.2.3.4) — validate the embedded IPv4
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    const head = lower.split(':')[0];
    if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true; // fe80::/10
    if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }
  return true; // not a valid IP literal → treat as non-public (caller decides what that means)
}

export type AddressKind = 'private' | 'public' | 'hostname';

/**
 * Rough classification used only for UX hints (e.g. warning about plaintext
 * credentials over the internet) — never a security boundary. A hostname is
 * classified separately from an IP because we do not resolve it here.
 */
export function classifyAddress(address: string): AddressKind {
  if (isIPv4(address) || isIPv6(address)) {
    return isBlockedAddress(address) ? 'private' : 'public';
  }
  return 'hostname';
}
