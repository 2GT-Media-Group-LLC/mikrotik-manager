import { bridgesView } from '../bridgesView';

// Shaped like a CRS309 on RouterOS 7.24.5.
const bridge = { '.id': '*A', name: 'bridge', mtu: 'auto', 'actual-mtu': '1500', 'mac-address': 'C4:AD:34:D5:BC:B7', 'protocol-mode': 'rstp', priority: '0x8000', 'vlan-filtering': 'true', dynamic: 'false', running: 'true', disabled: 'false', comment: 'defconf' };
type Row = Record<string, string>;
const ports: Row[] = [
  { interface: 'sfp-sfpplus10', bridge: 'bridge', hw: 'true', pvid: '1', disabled: 'false', role: 'designated-port' },
  { interface: 'ether1', bridge: 'bridge', hw: 'true', pvid: '1', disabled: 'false', role: 'root-port' },
  { interface: 'sfp-sfpplus2', bridge: 'bridge', hw: 'true', pvid: '10', disabled: 'false', inactive: 'true', role: 'disabled-port' },
  { interface: 'ether9', bridge: 'guest', hw: 'false', pvid: '1', disabled: 'false' },
];
const vlans: Row[] = [
  { bridge: 'bridge', 'vlan-ids': '10', disabled: 'false' },
  { bridge: 'bridge', 'vlan-ids': '100-110', disabled: 'false' },
  { bridge: 'bridge', 'vlan-ids': '99', disabled: 'true' },
];
const addresses: Row[] = [
  { address: '192.168.0.51/24', interface: 'sfp-sfpplus1', 'actual-interface': 'bridge', disabled: 'false' },
  { address: '10.9.9.1/24', interface: 'guest', disabled: 'false' },
];

describe('bridgesView', () => {
  it('builds each bridge with its ports, VLANs and addresses', () => {
    const [main, guest] = bridgesView({ bridges: [bridge, { '.id': '*B', name: 'guest', 'protocol-mode': 'none', disabled: 'false', running: 'false' }], ports, vlans, addresses });
    expect(main).toMatchObject({
      id: '*A', name: 'bridge', protocolMode: 'rstp', priority: '0x8000', vlanFiltering: true, running: true,
      comment: 'defconf', mtu: '1500', vlans: ['10', '100-110'], addresses: ['192.168.0.51/24'],
    });
    // Natural order, so sfp-sfpplus10 comes after sfp-sfpplus2.
    expect(main.ports.map((p) => p.name)).toEqual(['ether1', 'sfp-sfpplus2', 'sfp-sfpplus10']);
    expect(main.ports[1]).toMatchObject({ inactive: true, pvid: '10' });
    expect(guest).toMatchObject({ name: 'guest', protocolMode: 'none', running: false, vlanFiltering: false, addresses: ['10.9.9.1/24'] });
    expect(guest.ports).toEqual([{ name: 'ether9', hw: false, pvid: '1', disabled: false, inactive: false, dynamic: false, role: null }]);
  });
});
