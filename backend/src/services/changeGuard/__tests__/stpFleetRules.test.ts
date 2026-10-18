import { stpFleetRules, type StpFleetInput } from '../configHealth';
import type { DeviceSnapshot } from '../pathModel';

/** A two-port bridge; spanning tree mode as given. */
function snap(mode: string): DeviceSnapshot {
  return {
    addresses: [], interfaces: [], vlanInterfaces: [],
    bridges: [{ name: 'bridge', 'protocol-mode': mode }],
    bridgePorts: [
      { interface: 'sfp28-1', bridge: 'bridge', disabled: 'false' },
      { interface: 'sfp28-2', bridge: 'bridge', disabled: 'false' },
      { interface: 'ether1', bridge: 'bridge', disabled: 'false' },
    ],
    bridgeVlans: [], bonds: [], routes: [], arp: [], bridgeHosts: [], services: [], firewallFilter: [], mgmtConnections: [],
  } as DeviceSnapshot;
}

const B = (device_id: number, bridge_id: string, root_bridge_id: string) => ({
  device_id, bridge_name: 'bridge', bridge_id, root_bridge: bridge_id === root_bridge_id, root_bridge_id, root_port: null, root_path_cost: null,
});

const devices = [
  { id: 1, name: '2GT-NW-100G', device_type: 'switch' },
  { id: 2, name: ' 2GT-NW-AP4', device_type: 'wireless_ap' },
  { id: 7, name: '2GT-NW-BigSwitch', device_type: 'switch' },
  { id: 8, name: 'TEST', device_type: 'switch' },
];

function input(over: Partial<StpFleetInput>): StpFleetInput {
  return { deviceId: 1, deviceName: '2GT-NW-100G', fleetBridges: [], devices, neighbours: [], sightings: [], ...over };
}

describe('spanning-tree checks across the fleet (#260)', () => {
  it('spanning tree off with switches on two ports is critical, and replaces the plain warning', () => {
    const r = stpFleetRules(snap('none'), input({
      neighbours: [
        { from_interface: 'sfp28-1', to_device_id: 7, neighbor_caps: null },
        { from_interface: 'sfp28-2', to_device_id: null, neighbor_caps: 'bridge,router' },
      ],
    }));
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([['stp-disabled-redundant', 'critical']]);
    expect(r.replaces).toEqual(['stp-disabled:bridge']);
  });

  it('spanning tree off with a switch on one port only stays the ordinary warning', () => {
    const r = stpFleetRules(snap('none'), input({
      neighbours: [
        { from_interface: 'sfp28-1', to_device_id: 7, neighbor_caps: null },
        { from_interface: 'ether1', to_device_id: null, neighbor_caps: 'station-only' },
      ],
    }));
    expect(r.findings).toEqual([]);
    expect(r.replaces).toEqual([]);
  });

  it('reports a root that won on lowest MAC, on the root (the live 100G/BigSwitch tree)', () => {
    const fleetBridges = [B(1, '0x8000.F4:1E:57:51:74:1E', '0x8000.F4:1E:57:51:74:1E'), B(7, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.F4:1E:57:51:74:1E')];
    const onRoot = stpFleetRules(snap('rstp'), input({ fleetBridges }));
    expect(onRoot.findings.map((f) => f.rule)).toEqual(['stp-root-by-mac']);
    expect(onRoot.findings[0].detail).toContain('2GT-NW-BigSwitch');
    // Not repeated on the member when the root is managed.
    expect(stpFleetRules(snap('rstp'), input({ deviceId: 7, deviceName: '2GT-NW-BigSwitch', fleetBridges })).findings).toEqual([]);
  });

  it('a root priority someone chose is not reported, managed or not', () => {
    const fleetBridges = [B(8, '0x8000.C4:AD:34:D5:BC:B7', '0x2000.70:A7:41:EF:8F:FB'), B(7, '0x8000.F4:1E:57:BD:F0:2A', '0x2000.70:A7:41:EF:8F:FB')];
    expect(stpFleetRules(snap('rstp'), input({ deviceId: 8, deviceName: 'TEST', fleetBridges })).findings).toEqual([]);
  });

  it('names an unmanaged default-priority root on its members', () => {
    const fleetBridges = [B(8, '0x8000.C4:AD:34:D5:BC:B7', '0x8000.70:A7:41:EF:8F:FB'), B(7, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.70:A7:41:EF:8F:FB')];
    const r = stpFleetRules(snap('rstp'), input({
      deviceId: 8, deviceName: 'TEST', fleetBridges,
      sightings: [{ from_device_id: null, to_device_id: null, neighbor_mac: '70:A7:41:EF:8F:FC', neighbor_identity: '2GT-NW-CORE' }],
    }));
    expect(r.findings[0].title).toContain('2GT-NW-CORE');
  });

  it('warns when an access point is root over other switches', () => {
    const fleetBridges = [B(2, '0x8000.D0:EA:11:0A:DE:77', '0x8000.D0:EA:11:0A:DE:77'), B(7, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.D0:EA:11:0A:DE:77')];
    const r = stpFleetRules(snap('rstp'), input({ deviceId: 2, deviceName: ' 2GT-NW-AP4', fleetBridges }));
    expect(r.findings.map((f) => [f.rule, f.severity]).sort()).toEqual([['stp-root-by-mac', 'info'], ['stp-root-is-ap', 'warning']]);
    // A tree of one (the AP alone, as on the live fleet) says nothing.
    expect(stpFleetRules(snap('rstp'), input({ deviceId: 2, deviceName: 'AP', fleetBridges: [fleetBridges[0]] })).findings).toEqual([]);
  });
});
