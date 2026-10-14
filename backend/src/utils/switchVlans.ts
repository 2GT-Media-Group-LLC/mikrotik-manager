/**
 * VLANs kept in the switch chip's own table (#278). Older switch chips
 * (Atheros 8327, QCA8337 and similar: hAP ac², RB951, hEX lite) can't
 * hardware-switch a VLAN-filtering bridge; they do VLANs with
 * /interface/ethernet/switch/vlan plus per-port vlan-mode, vlan-header and
 * default-vlan-id. Read-only for now. Pure, so it can be tested without one
 * of those devices.
 */
type Row = Record<string, string>;
const isTrue = (v: string | undefined) => v === 'true' || v === 'yes';

export interface SwitchVlanEntry {
  id: string;
  switch: string;
  vlanId: number;
  ports: string[];
  independentLearning: boolean;
  disabled: boolean;
}

export interface SwitchVlanPort {
  name: string;
  switch: string;
  vlanMode: string;
  vlanHeader: string;
  defaultVlanId: string;
}

export interface SwitchVlanView {
  /** The device's switch chip keeps VLANs in its own table. */
  supported: boolean;
  switches: { name: string; type: string }[];
  vlans: SwitchVlanEntry[];
  ports: SwitchVlanPort[];
  /** Some port checks or tags VLANs: the table is in use. */
  inUse: boolean;
  /**
   * Bridges with VLAN filtering on. On these chips that moves the bridge's
   * switching to the CPU, which is usually why the switch table is used.
   */
  filteringBridges: string[];
}

/**
 * `vlanTable` is null when /interface/ethernet/switch/vlan doesn't exist on
 * the device (Marvell, CRS3xx, and chips that do VLAN filtering in hardware
 * on RouterOS 7), which is different from an empty table.
 */
export function switchVlanView(switches: Row[], vlanTable: Row[] | null, switchPorts: Row[], bridges: Row[]): SwitchVlanView {
  const ports: SwitchVlanPort[] = switchPorts
    .filter((p) => p['vlan-mode'] !== undefined)
    .map((p) => ({
      name: p.name ?? '',
      switch: p.switch ?? '',
      vlanMode: p['vlan-mode'] ?? '',
      vlanHeader: p['vlan-header'] ?? '',
      defaultVlanId: p['default-vlan-id'] ?? '',
    }));
  const vlans: SwitchVlanEntry[] = (vlanTable ?? [])
    .map((v) => ({
      id: v['.id'] ?? '',
      switch: v.switch ?? '',
      vlanId: Number(v['vlan-id']),
      ports: (v.ports ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      independentLearning: isTrue(v['independent-learning']),
      disabled: isTrue(v.disabled),
    }))
    .filter((v) => Number.isFinite(v.vlanId))
    .sort((a, b) => a.vlanId - b.vlanId);
  const supported = vlanTable !== null && (vlans.length > 0 || ports.length > 0);
  return {
    supported,
    switches: switches.map((s) => ({ name: s.name ?? '', type: s.type ?? '' })),
    vlans,
    ports,
    inUse: vlans.some((v) => !v.disabled) || ports.some((p) => p.vlanMode !== '' && p.vlanMode !== 'disabled'),
    filteringBridges: supported ? bridges.filter((b) => isTrue(b['vlan-filtering'])).map((b) => b.name ?? '') : [],
  };
}
