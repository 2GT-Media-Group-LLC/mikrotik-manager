import { vlanInterfacesView } from '../vlanInterfaces';

const bridges = [
  { name: 'bridge', 'vlan-filtering': 'true' },
  { name: 'bridge-test', 'vlan-filtering': 'false' },
];
const interfaces = [
  { name: 'ether2', type: 'ether' },
  { name: 'sfp-sfpplus1', type: 'ether' },
  { name: 'bond1', type: 'bond' },
  { name: 'vlan100', type: 'vlan' },
  { name: 'bridge', type: 'bridge' },
  { name: 'bridge-test', type: 'bridge' },
];

describe('vlanInterfacesView', () => {
  it('classifies the parent and collects addresses', () => {
    const rows = vlanInterfacesView(
      [
        { '.id': '*3', name: 'vlan2-trusted', 'vlan-id': '2', interface: 'ether2', mtu: '1500', running: 'true', disabled: 'false' },
        { '.id': '*4', name: 'vlan90-mgmt', 'vlan-id': '90', interface: 'bridge', mtu: '1500', running: 'true', disabled: 'false', comment: 'mgmt' },
        { '.id': '*5', name: 'vlan100', 'vlan-id': '100', interface: 'bridge-test', mtu: '1500', running: 'false', disabled: 'false' },
        { '.id': '*6', name: 'vlan7-bond', 'vlan-id': '7', interface: 'bond1', mtu: '1500', running: 'true', disabled: 'true' },
        { '.id': '*7', name: 'qinq-200', 'vlan-id': '200', interface: 'vlan100', mtu: '1496', running: 'false', disabled: 'false' },
        { '.id': '*8', name: 'vlan9-gone', 'vlan-id': '9', interface: 'ether99', mtu: '1500', running: 'false', disabled: 'false' },
      ],
      bridges,
      interfaces,
      [
        { address: '10.2.0.1/24', interface: 'vlan2-trusted', disabled: 'false' },
        { address: '10.2.1.1/24', interface: 'vlan2-trusted', disabled: 'true' },
        { address: '10.90.0.2/24', interface: 'vlan90-mgmt', disabled: 'false' },
      ],
      [
        { address: 'fe80::1/64', interface: 'vlan2-trusted', disabled: 'false' },
        { address: '2001:db8:2::1/64', interface: 'vlan2-trusted', disabled: 'false' },
        { address: 'fd00:2::1/64', interface: 'vlan2-trusted', disabled: 'false', invalid: 'true' },
      ],
    );
    expect(rows.map((r) => r.vlanId)).toEqual([2, 7, 9, 90, 100, 200]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['vlan2-trusted']).toMatchObject({ parent: 'ether2', parentKind: 'port', running: true, addresses: ['10.2.0.1/24', '2001:db8:2::1/64'] });
    expect(byName['vlan90-mgmt']).toMatchObject({ parentKind: 'bridge-filtering', comment: 'mgmt', addresses: ['10.90.0.2/24'] });
    expect(byName['vlan100']).toMatchObject({ parentKind: 'bridge', running: false, addresses: [] });
    expect(byName['vlan7-bond']).toMatchObject({ parentKind: 'bond', disabled: true });
    expect(byName['qinq-200'].parentKind).toBe('vlan');
    expect(byName['vlan9-gone'].parentKind).toBe('unknown');
  });

  it('is empty for a device without VLAN interfaces', () => {
    expect(vlanInterfacesView([], bridges, interfaces, [], [])).toEqual([]);
  });

  it('keeps a row with an unreadable vlan-id', () => {
    const [row] = vlanInterfacesView([{ name: 'odd', interface: 'ether2' }], [], interfaces, [], []);
    expect(row).toMatchObject({ name: 'odd', vlanId: null, parentKind: 'port', running: false, disabled: false });
  });
});
