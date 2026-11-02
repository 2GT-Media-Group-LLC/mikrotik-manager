import { vlanInterfaceEntry, interfaceAddress } from '../vlanInterfaceEdit';

describe('vlanInterfaceEntry', () => {
  it('builds a new VLAN interface, named after its VLAN when no name is given', () => {
    expect(vlanInterfaceEntry({ vlan_id: 20, interface: 'ether2' }, true))
      .toEqual({ fields: { 'vlan-id': '20', interface: 'ether2', name: 'vlan20' }, address: null });
    expect(vlanInterfaceEntry({ vlan_id: '30', interface: 'bridge', name: 'guest', mtu: 1500, comment: 'Guests', disabled: false, address: '10.0.30.1/24' }, true))
      .toEqual({
        fields: { 'vlan-id': '30', interface: 'bridge', name: 'guest', mtu: '1500', comment: 'Guests', disabled: 'no' },
        address: '10.0.30.1/24',
      });
  });

  it('needs a VLAN ID from 1 to 4094 and a parent to add', () => {
    expect(vlanInterfaceEntry({ interface: 'ether2' }, true)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ vlan_id: 0, interface: 'ether2' }, true)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ vlan_id: 4095, interface: 'ether2' }, true)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ vlan_id: 2.5, interface: 'ether2' }, true)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ vlan_id: 20 }, true)).toHaveProperty('error');
  });

  it('changes only what was sent', () => {
    expect(vlanInterfaceEntry({ disabled: true }, false)).toEqual({ fields: { disabled: 'yes' }, address: null });
    expect(vlanInterfaceEntry({ vlan_id: 21, name: 'vlan21' }, false))
      .toEqual({ fields: { 'vlan-id': '21', name: 'vlan21' }, address: null });
    expect(vlanInterfaceEntry({ comment: '' }, false)).toEqual({ fields: { comment: '' }, address: null });
    expect(vlanInterfaceEntry({}, false)).toEqual({ error: 'Nothing to change' });
  });

  it('refuses names, parents and values RouterOS would misread', () => {
    expect(vlanInterfaceEntry({ name: 'vlan 20' }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ name: 'vlan20;/system reset' }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ interface: 'ether2,ether3' }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ name: '' }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ mtu: 20 }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ comment: 'two\nlines' }, false)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ disabled: 'yes' }, false)).toHaveProperty('error');
  });

  it('takes an address only when adding', () => {
    expect(vlanInterfaceEntry({ vlan_id: 20, interface: 'ether2', address: '10.0.20.1' }, true)).toHaveProperty('error');
    expect(vlanInterfaceEntry({ address: '10.0.20.1/24' }, false)).toHaveProperty('error');
  });
});

describe('interfaceAddress', () => {
  it('accepts IPv4 and IPv6 addresses with a prefix', () => {
    expect(interfaceAddress('10.0.20.1/24')).toBe(true);
    expect(interfaceAddress('2001:db8::1/64')).toBe(true);
  });
  it('refuses a bare address, a bad prefix or anything else', () => {
    expect(interfaceAddress('10.0.20.1')).toBe(false);
    expect(interfaceAddress('10.0.20.1/33')).toBe(false);
    expect(interfaceAddress('2001:db8::1/129')).toBe(false);
    expect(interfaceAddress('10.0.20.300/24')).toBe(false);
    expect(interfaceAddress('a/24')).toBe(false);
  });
});
