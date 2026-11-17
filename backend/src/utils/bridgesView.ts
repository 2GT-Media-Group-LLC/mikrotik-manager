/**
 * The Bridges tab's view of a device (#284): each bridge with its settings,
 * member ports (hardware-offloaded or switched by the CPU), VLAN entries and
 * addresses. Pure, so it's tested on output read from a CRS309.
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface BridgePortView {
  name: string; hw: boolean; pvid: string | null; disabled: boolean; inactive: boolean; dynamic: boolean; role: string | null;
  /** The port's L2 MTU: the most a bridge MTU can be. Null when the device didn't say. */
  l2mtu: number | null;
  /** The most the port's hardware takes (max-l2mtu). Null when the device didn't say. */
  maxL2mtu: number | null;
  /** Pushes its PVID over any tag a frame already has (#449). */
  tagStacking: boolean;
  /** MVRP (#449): null where RouterOS doesn't have it. */
  mvrpApplicant: string | null;
  mvrpRegistrar: string | null;
  /** VLANs MVRP registered on and declared from this port, when the bridge runs MVRP. */
  registeredVlans: string | null;
  declaredVlans: string | null;
}
export interface BridgeView {
  id: string; name: string; protocolMode: string; priority: string | null; vlanFiltering: boolean;
  running: boolean; disabled: boolean; dynamic: boolean; comment: string | null; mtu: string | null; macAddress: string | null;
  /** The MTU as set: "auto" (the lowest of its ports') or a number. */
  mtuSetting: string;
  /**
   * The tag read as a VLAN (#449): 0x8100, or 0x88a8 for 802.1ad Q-in-Q.
   * Null with VLAN filtering off: RouterOS takes it then but doesn't print it
   * (checked on a CRS3xx running 7.25).
   */
  etherType: string | null;
  /** MVRP on the bridge (#449); null where RouterOS doesn't have it, or doesn't say (filtering off). */
  mvrp: boolean | null;
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

const num = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);

export function bridgesView(input: { bridges: Row[]; ports: Row[]; vlans: Row[]; addresses: Row[]; interfaces?: Row[]; mvrp?: Row[] }): BridgeView[] {
  const mvrpOf = new Map((input.mvrp ?? []).map((m) => [m['interface'] ?? '', m]));
  const l2mtu = new Map((input.interfaces ?? []).map((i) => [i['name'] ?? '', num(i['l2mtu'])]));
  const maxL2mtu = new Map((input.interfaces ?? []).map((i) => [i['name'] ?? '', num(i['max-l2mtu'])]));
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
      mtuSetting: b['mtu'] || 'auto',
      etherType: b['ether-type'] ? b['ether-type'].toLowerCase() : isTrue(b['vlan-filtering']) ? '0x8100' : null,
      mvrp: b['mvrp'] === undefined ? null : isTrue(b['mvrp']),
      macAddress: b['mac-address'] || null,
      ports: input.ports
        .filter((p) => p['bridge'] === name)
        .map((p) => ({
          name: p['interface'] ?? '', hw: isTrue(p['hw']), pvid: p['pvid'] || null,
          disabled: isTrue(p['disabled']), inactive: isTrue(p['inactive']), dynamic: isTrue(p['dynamic']), role: p['role'] || null,
          l2mtu: l2mtu.get(p['interface'] ?? '') ?? null,
          maxL2mtu: maxL2mtu.get(p['interface'] ?? '') ?? null,
          tagStacking: isTrue(p['tag-stacking']),
          mvrpApplicant: p['mvrp-applicant-state'] || null,
          mvrpRegistrar: p['mvrp-registrar-state'] || null,
          // Spanning tree on the port: what's set, and how it's running.
          stpPriority: p['priority'] || null,
          pathCost: p['path-cost'] || null,
          edge: p['edge'] || null,
          pointToPoint: p['point-to-point'] || null,
          bpduGuard: p['bpdu-guard'] === undefined ? null : isTrue(p['bpdu-guard']),
          restrictedRole: p['restricted-role'] === undefined ? null : isTrue(p['restricted-role']),
          restrictedTcn: p['restricted-tcn'] === undefined ? null : isTrue(p['restricted-tcn']),
          edgePort: p['edge-port'] === undefined ? null : isTrue(p['edge-port']),
          status: p['status'] || null,
          registeredVlans: mvrpOf.get(p['interface'] ?? '')?.['registered-vlan-ids'] || null,
          declaredVlans: mvrpOf.get(p['interface'] ?? '')?.['declared-vlan-ids'] || null,
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
