/**
 * VLAN interfaces (#309): `/interface/vlan` entries, the router-on-a-stick
 * layout on a CCR, CHR or RB, as opposed to the bridge VLAN table a switch
 * uses. Read-only. Pure, so it can be tested without a device.
 *
 * What an operator needs to tell apart is the parent: a bridge with VLAN
 * filtering (the VLAN interface is how the router itself sits on that VLAN),
 * a bridge without filtering (the tag is only seen on the CPU path), or a
 * plain port, bond or another VLAN (Q-in-Q).
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export type VlanParentKind = 'bridge-filtering' | 'bridge' | 'bond' | 'vlan' | 'port' | 'unknown';

export interface VlanInterface {
  id: string;
  name: string;
  vlanId: number | null;
  parent: string;
  parentKind: VlanParentKind;
  mtu: string;
  running: boolean;
  disabled: boolean;
  /** Interface addresses, IPv4 then global/ULA IPv6; link-local is left out. */
  addresses: string[];
  comment: string;
}

/** fe80::/10, which every IPv6 interface has, says nothing about the VLAN. */
function linkLocal(address: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(address);
}

function parentKind(parent: string, bridges: Row[], interfaces: Row[]): VlanParentKind {
  const bridge = bridges.find((b) => b['name'] === parent);
  if (bridge) return isTrue(bridge['vlan-filtering']) ? 'bridge-filtering' : 'bridge';
  const type = interfaces.find((i) => i['name'] === parent)?.['type'] ?? '';
  if (type === 'bond') return 'bond';
  if (type === 'vlan') return 'vlan';
  if (type === 'bridge') return 'bridge';
  if (type) return 'port';
  return 'unknown';
}

export function vlanInterfacesView(
  vlans: Row[],
  bridges: Row[],
  interfaces: Row[],
  ipv4: Row[],
  ipv6: Row[],
): VlanInterface[] {
  const addressesOn = (name: string) => [
    ...ipv4.filter((a) => a['interface'] === name && !isTrue(a['disabled']) && !isTrue(a['invalid'])).map((a) => a['address']),
    ...ipv6.filter((a) => a['interface'] === name && !isTrue(a['disabled']) && !isTrue(a['invalid']) && !linkLocal(a['address'] || '')).map((a) => a['address']),
  ].filter((a): a is string => !!a);

  return vlans
    .map((v) => {
      const id = parseInt(v['vlan-id'] || '', 10);
      const parent = v['interface'] || '';
      return {
        id: v['.id'] || '',
        name: v['name'] || '',
        vlanId: Number.isFinite(id) ? id : null,
        parent,
        parentKind: parentKind(parent, bridges, interfaces),
        mtu: v['mtu'] || '',
        running: isTrue(v['running']),
        disabled: isTrue(v['disabled']),
        addresses: addressesOn(v['name'] || ''),
        comment: v['comment'] || '',
      };
    })
    .sort((a, b) => (a.vlanId ?? 0) - (b.vlanId ?? 0) || a.name.localeCompare(b.name));
}
