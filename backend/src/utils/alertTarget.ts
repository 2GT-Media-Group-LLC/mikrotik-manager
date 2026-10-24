import * as dns from 'dns';
import { isIP, isIPv4, isIPv6 } from 'net';
import { expandIpv6, embeddedIpv4, isUnspecifiedOrLoopback6 } from './ipv6';

/**
 * Where an alert channel (Slack, Discord, ntfy, Gotify) may send.
 *
 * Looser than the generic-webhook guard on purpose: ntfy and Gotify are often
 * self-hosted on the LAN, so private (RFC1918, unique-local) addresses must
 * keep working. What is refused are destinations that only make sense as an
 * attack from inside the manager: its own loopback, link-local addresses
 * (including the 169.254.169.254 cloud metadata service), unspecified and
 * multicast addresses, and the other containers of this stack by name.
 */

const STACK_SERVICE_NAMES = new Set(['localhost', 'postgres', 'redis', 'influxdb', 'backend', 'nginx']);

export function isInternalOnlyAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127) return true;          // this-net, loopback
    if (a === 169 && b === 254) return true;        // link-local, cloud metadata
    if (a >= 224) return true;                      // multicast, reserved, broadcast
    return false;
  }
  if (isIPv6(ip)) {
    // Parsed, not matched as text (GHSA-28hr-v457-cc6g): ::ffff:7f00:1 is
    // 127.0.0.1 just as ::ffff:127.0.0.1 is.
    const groups = expandIpv6(ip);
    if (!groups) return true;
    if (isUnspecifiedOrLoopback6(groups)) return true;
    const v4 = embeddedIpv4(groups);
    if (v4) return isInternalOnlyAddress(v4);
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((groups[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

/**
 * Resolve `hostname` once and return the address to connect to, or throw if
 * the destination is not allowed. Connecting to the returned address (rather
 * than the name) stops a second DNS answer from swapping in a refused one.
 */
export async function resolveAlertTarget(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (STACK_SERVICE_NAMES.has(host) || host.endsWith('.localhost')) {
    throw new Error('That address is inside the manager itself and cannot receive alerts');
  }
  if (isIP(host)) {
    if (isInternalOnlyAddress(host)) throw new Error('That address is inside the manager itself and cannot receive alerts');
    return host;
  }
  const results = await dns.promises.lookup(host, { all: true }).catch(() => {
    throw new Error(`Could not resolve ${host}`);
  });
  if (results.length === 0) throw new Error(`Could not resolve ${host}`);
  if (results.some((r) => isInternalOnlyAddress(r.address))) {
    throw new Error('That address is inside the manager itself and cannot receive alerts');
  }
  return results[0].address;
}
