/**
 * The Bridges tab's view of a device (#284): each bridge with its settings,
 * member ports (hardware-offloaded or switched by the CPU), VLAN entries and
 * addresses. Pure, so it's tested on output read from a CRS309.
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface BridgePortView {
  name: string; hw: boolean; pvid: string | null; disabled: boolean; inactive: boolean; dynamic: boolean; role: string | null;
}
export interface BridgeView {
  id: string; name: string; protocolMode: string; priority: string | null; vlanFiltering: boolean;
  running: boolean; disabled: boolean; dynamic: boolean; comment: string | null; mtu: string | null; macAddress: string | null;
  ports: BridgePortView[];
  /** VLAN ids with an entry on this bridge, as RouterOS lists them (ranges kept). */
  vlans: string[];
  /** Addresses on the bridge itself. */
  addresses: string[];
}

export function bridgesView(input: { bridges: Row[]; ports: Row[]; vlans: Row[]; addresses: Row[] }): BridgeView[] {
  return input.bridges.map((b) => {
    const name = b['name'] ?? '';
    return {
      id: b['.id'] ?? '',
      name,
      protocolMode: b['protocol-mode'] || 'none',
      priority: b['priority'] || null,
      vlanFiltering: isTrue(b['vlan-filtering']),
      running: isTrue(b['running']),
      disabled: isTrue(b['disabled']),
      dynamic: isTrue(b['dynamic']),
      comment: b['comment'] || null,
      mtu: b['actual-mtu'] || b['mtu'] || null,
      macAddress: b['mac-address'] || null,
      ports: input.ports
        .filter((p) => p['bridge'] === name)
        .map((p) => ({
          name: p['interface'] ?? '', hw: isTrue(p['hw']), pvid: p['pvid'] || null,
          disabled: isTrue(p['disabled']), inactive: isTrue(p['inactive']), dynamic: isTrue(p['dynamic']), role: p['role'] || null,
        }))
        .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })),
      vlans: input.vlans
        .filter((v) => v['bridge'] === name && !isTrue(v['disabled']))
        .map((v) => v['vlan-ids'] ?? '')
        .filter(Boolean),
      addresses: input.addresses
        .filter((a) => (a['actual-interface'] || a['interface']) === name && !isTrue(a['disabled']))
        .map((a) => a['address'] ?? '')
        .filter(Boolean),
    };
  }).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
}
