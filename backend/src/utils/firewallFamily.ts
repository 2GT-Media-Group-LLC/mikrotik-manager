/**
 * IPv4 or IPv6 firewall (#312). RouterOS keeps them in parallel menus,
 * /ip/firewall and /ipv6/firewall, with the same filter, NAT and address-list
 * tables, so every firewall read and write takes the family to work on.
 */
import { isIP } from 'net';

export type FirewallFamily = 'ip' | 'ipv6';

/** From a request's ?family=: absent or "ipv4" is IPv4, "ipv6" IPv6, anything else null. */
export function firewallFamily(raw: unknown): FirewallFamily | null {
  if (raw === undefined || raw === '' || raw === 'ipv4') return 'ip';
  if (raw === 'ipv6') return 'ipv6';
  return null;
}

/** The RouterOS menu for a firewall table. */
export function firewallMenu(family: FirewallFamily, table: 'filter' | 'nat' | 'address-list'): string {
  return `/${family}/firewall/${table}`;
}

/**
 * Whether the manager reaches a device over IPv4, by the address it connects
 * to. Change Guard's model only covers IPv4, so an IPv6 firewall change can be
 * shown not to touch management only then; a hostname could resolve to either.
 */
export function managedOverIpv4(address: string): boolean {
  return isIP(address) === 4;
}
