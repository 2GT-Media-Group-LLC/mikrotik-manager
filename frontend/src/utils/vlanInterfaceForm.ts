import type { Interface } from '../types';
import type { VlanInterface, VlanInterfaceInput } from '../services/api';

/** The VLAN interface form (#309), as typed. */
export interface VlanInterfaceForm {
  vlanId: string;
  name: string;
  parent: string;
  mtu: string;
  comment: string;
  enabled: boolean;
  /** Only when adding. */
  address: string;
}

/**
 * Why a typed name won't be accepted, or null. The same rule as the server
 * (backend utils/vlanInterfaceEdit): blank means the default, vlan<ID>.
 */
export function vlanNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n.length > 64) return 'At most 64 characters';
  const bad = n.match(/[\s"\\;,]/);
  if (bad) return bad[0].trim() ? `It can't contain ${bad[0]}` : "It can't contain spaces";
  return null;
}

/** Why a typed MTU won't be accepted, or null; blank keeps the default. */
export function vlanMtuError(mtu: string): string | null {
  if (!mtu) return null;
  const n = Number(mtu);
  return Number.isInteger(n) && n >= 64 && n <= 65535 ? null : 'From 64 to 65535';
}

const isIpv4 = (a: string): boolean => {
  const parts = a.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
};

/** Why a typed address won't be accepted, or null; blank adds none. */
export function vlanAddressError(address: string): string | null {
  const a = address.trim();
  if (!a) return null;
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(a);
  if (!m) return 'Include the prefix length, e.g. 10.0.20.1/24';
  const prefix = Number(m[2]);
  if (isIpv4(m[1])) return prefix <= 32 ? null : 'An IPv4 prefix is at most /32';
  if (m[1].includes(':') && /^[0-9a-fA-F:.]+$/.test(m[1])) return prefix <= 128 ? null : 'An IPv6 prefix is at most /128';
  return 'Not an IPv4 or IPv6 address';
}

/** Interface types a VLAN can be tagged on: Ethernet-like, not routed tunnels. */
const PARENT_TYPES = ['bridge', 'bond', 'ether', 'vlan', 'wlan', 'wifi', 'eoip', 'eoipv6', 'vpls', 'veth'];
const ORDER = (t: string): number => {
  const i = ['bridge', 'bond', 'ether'].indexOf(t);
  return i < 0 ? 3 : i;
};

/**
 * Parents to offer: bridges, then bonds, then ports, then the rest, without
 * the interface being edited. The current parent stays listed even if the
 * interface list doesn't have it (not polled yet, or an unusual type).
 */
export function vlanParentChoices(interfaces: Interface[], self: string | null, current: string): { name: string; type: string }[] {
  const list = interfaces
    .filter((i) => i.name !== self && PARENT_TYPES.includes(i.type ?? 'ether'))
    .map((i) => ({ name: i.name, type: i.type ?? '' }))
    .sort((a, b) => ORDER(a.type) - ORDER(b.type) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (current && !list.some((p) => p.name === current)) list.unshift({ name: current, type: '' });
  return list;
}

/** What an edit changes, so only those fields are sent. */
export function vlanInterfaceChanges(v: VlanInterface, f: VlanInterfaceForm): Partial<VlanInterfaceInput> {
  const out: Partial<VlanInterfaceInput> = {};
  if (f.vlanId !== String(v.vlanId ?? '')) out.vlan_id = Number(f.vlanId);
  if (f.parent !== v.parent) out.interface = f.parent;
  if (f.name.trim() && f.name.trim() !== v.name) out.name = f.name.trim();
  if (f.mtu && f.mtu !== v.mtu) out.mtu = Number(f.mtu);
  if (f.comment.trim() !== v.comment) out.comment = f.comment.trim();
  if (f.enabled === v.disabled) out.disabled = !f.enabled;
  return out;
}
