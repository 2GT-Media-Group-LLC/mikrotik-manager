/**
 * What kind of port a topology link was heard on (#367). A cable is between
 * physical ports; a sighting on a VLAN, VRRP, bridge or bond interface is the
 * same pair heard again over something logical, and a tunnel (WireGuard,
 * EoIP, GRE...) is a link that isn't a cable at all.
 */
export type PortKind = 'physical' | 'logical' | 'tunnel';

/** RouterOS interface types. */
const LOGICAL_TYPES = new Set(['vlan', 'vrrp', 'bridge', 'bond', 'loopback', 'veth', 'macvlan', 'mac-vlan']);
const TUNNEL_TYPE = /tunnel|^(wg|eoip|eoipv6|l2tp|pptp|sstp|ovpn|pppoe|vxlan|vpls|zerotier|6to4)/i;

/**
 * Names, for a port whose type isn't known: the far end's, or another
 * vendor's (Cisco's Vlan10, Po15, Tunnel0). A letter may not follow the
 * prefix, so "port1" isn't a port-channel and "green" isn't GRE.
 */
const LOGICAL_NAME = /^(vlan|vrrp|bridge|br|bond|port-?channel|po|lo|loopback|svi|vif)(?![a-z])/i;
const TUNNEL_NAME = /^(wg|wireguard|eoip|eoipv6|gre|gre6|ipip|ipipv6|l2tp|pptp|sstp|ovpn|pppoe|zt|zerotier|vxlan|vpls|tunnel|tun)(?![a-z])/i;

/** The port in "bridge/sfp28-2", as LLDP gives a bridge port. */
const portOf = (v: string) => v.slice(v.lastIndexOf('/') + 1);

export function portKind(name?: string | null, type?: string | null): PortKind {
  const t = type?.trim().toLowerCase();
  if (t) {
    if (LOGICAL_TYPES.has(t)) return 'logical';
    if (TUNNEL_TYPE.test(t)) return 'tunnel';
    return 'physical';
  }
  const n = portOf(name?.trim() ?? '');
  if (!n) return 'physical';
  if (TUNNEL_NAME.test(n)) return 'tunnel';
  if (LOGICAL_NAME.test(n)) return 'logical';
  return 'physical';
}

/** A link's kind from its two ends: a tunnel at either end makes a tunnel, then logical, then a cable. */
export function linkKind(...ends: PortKind[]): PortKind {
  if (ends.includes('tunnel')) return 'tunnel';
  if (ends.includes('logical')) return 'logical';
  return 'physical';
}
