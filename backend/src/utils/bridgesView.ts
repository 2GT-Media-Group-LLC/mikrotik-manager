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
  /** VLAN ids configured on this bridge, each once, in order (ranges kept). */
  vlans: string[];
  /** VLAN ids that only have dynamic entries (added by a port's PVID or by wifi). */
  dynamicVlans: string[];
  /** Addresses on the bridge itself. */
  addresses: string[];
}

/** "10,20" and "100-110" entries split into ids, each once, sorted by number. */
function vlanIds(rows: Row[]): string[] {
  const ids = new Set(rows.flatMap((v) => (v['vlan-ids'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)));
  return [...ids].sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
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
      // RouterOS adds a dynamic entry per PVID and per wifi interface, so the
      // same id can appear several times (#284); count the configured ones.
      ...(() => {
        const mine = input.vlans.filter((v) => v['bridge'] === name && !isTrue(v['disabled']));
        const vlans = vlanIds(mine.filter((v) => !isTrue(v['dynamic'])));
        const dynamicVlans = vlanIds(mine.filter((v) => isTrue(v['dynamic']))).filter((id) => !vlans.includes(id));
        return { vlans, dynamicVlans };
      })(),
      addresses: input.addresses
        .filter((a) => (a['actual-interface'] || a['interface']) === name && !isTrue(a['disabled']))
        .map((a) => a['address'] ?? '')
        .filter(Boolean),
    };
  }).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
}
