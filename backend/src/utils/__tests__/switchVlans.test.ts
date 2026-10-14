import { switchVlanView } from '../switchVlans';

// Shaped like a hAP ac² (Atheros8327) with a trunk on ether1 and access ports.
const switches = [{ '.id': '*0', name: 'switch1', type: 'Atheros8327' }];
const vlanTable = [
  { '.id': '*2', switch: 'switch1', 'vlan-id': '20', ports: 'ether1,ether3,switch1-cpu', 'independent-learning': 'true', disabled: 'false' },
  { '.id': '*1', switch: 'switch1', 'vlan-id': '10', ports: 'ether1,ether2,switch1-cpu', 'independent-learning': 'true', disabled: 'false' },
];
const ports = [
  { name: 'ether1', switch: 'switch1', 'vlan-mode': 'secure', 'vlan-header': 'add-if-missing', 'default-vlan-id': 'auto' },
  { name: 'ether2', switch: 'switch1', 'vlan-mode': 'secure', 'vlan-header': 'always-strip', 'default-vlan-id': '10' },
  { name: 'switch1-cpu', switch: 'switch1', 'vlan-mode': 'secure', 'vlan-header': 'leave-as-is', 'default-vlan-id': 'auto' },
];

describe('switchVlanView', () => {
  it('reads the switch VLAN table and port settings, sorted by VLAN', () => {
    const v = switchVlanView(switches, vlanTable, ports, [{ name: 'bridge', 'vlan-filtering': 'false' }]);
    expect(v.supported).toBe(true);
    expect(v.inUse).toBe(true);
    expect(v.vlans.map((x) => x.vlanId)).toEqual([10, 20]);
    expect(v.vlans[0].ports).toEqual(['ether1', 'ether2', 'switch1-cpu']);
    expect(v.ports.find((p) => p.name === 'ether2')).toMatchObject({ vlanMode: 'secure', vlanHeader: 'always-strip', defaultVlanId: '10' });
    expect(v.filteringBridges).toEqual([]);
  });

  it('is supported but not in use on a chip with the menu and nothing set up', () => {
    const idle = ports.map((p) => ({ ...p, 'vlan-mode': 'disabled', 'vlan-header': 'leave-as-is' }));
    const v = switchVlanView(switches, [], idle, []);
    expect(v.supported).toBe(true);
    expect(v.inUse).toBe(false);
  });

  it('names bridges with VLAN filtering on, which these chips switch on the CPU', () => {
    const v = switchVlanView(switches, vlanTable, ports, [{ name: 'bridge', 'vlan-filtering': 'true' }]);
    expect(v.filteringBridges).toEqual(['bridge']);
  });

  it('is not supported where the menu does not exist (Marvell, CRS3xx)', () => {
    // As read from a CRS309: switch ports exist but have no vlan-mode, and the vlan menu errors.
    const marvellPorts = [{ name: 'sfp-sfpplus1', switch: 'switch1', 'l3-hw-offloading': 'true' }];
    const v = switchVlanView([{ name: 'switch1', type: 'Marvell-98DX8208' }], null, marvellPorts, [{ name: 'bridge', 'vlan-filtering': 'true' }]);
    expect(v.supported).toBe(false);
    expect(v.filteringBridges).toEqual([]);
  });

  it('is not supported on a device with no switch chip (wAP ax: everything empty)', () => {
    expect(switchVlanView([], [], [], []).supported).toBe(false);
  });
});
