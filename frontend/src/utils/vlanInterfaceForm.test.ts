import { describe, it, expect } from 'vitest';
import { vlanParentChoices, vlanInterfaceChanges, vlanNameError, vlanMtuError, vlanAddressError, type VlanInterfaceForm } from './vlanInterfaceForm';
import type { Interface } from '../types';
import type { VlanInterface } from '../services/api';

const iface = (name: string, type: string): Interface => ({ id: 0, device_id: 1, name, type, running: true, disabled: false });

describe('vlanParentChoices', () => {
  const all = [iface('ether10', 'ether'), iface('ether2', 'ether'), iface('bridge', 'bridge'), iface('bond1', 'bond'),
    iface('vlan20', 'vlan'), iface('wg0', 'wg'), iface('pppoe-out1', 'pppoe-out'), iface('lo', 'loopback')];

  it('offers bridges, bonds, ports, then other VLANs, in natural order', () => {
    expect(vlanParentChoices(all, null, '').map((p) => p.name)).toEqual(['bridge', 'bond1', 'ether2', 'ether10', 'vlan20']);
  });
  it('leaves out the interface being edited', () => {
    expect(vlanParentChoices(all, 'vlan20', '').map((p) => p.name)).not.toContain('vlan20');
  });
  it('keeps a current parent the list does not have', () => {
    expect(vlanParentChoices(all, null, 'sfp-sfpplus1')[0]).toEqual({ name: 'sfp-sfpplus1', type: '' });
  });
});

describe('vlanInterfaceChanges', () => {
  const v: VlanInterface = { id: '*1', name: 'vlan20', vlanId: 20, parent: 'ether2', parentKind: 'port', mtu: '1500',
    running: true, disabled: false, addresses: [], comment: '' };
  const f: VlanInterfaceForm = { vlanId: '20', name: 'vlan20', parent: 'ether2', mtu: '1500', comment: '', enabled: true, address: '' };

  it('sends nothing when nothing changed', () => {
    expect(vlanInterfaceChanges(v, f)).toEqual({});
  });
  it('sends only the changed fields', () => {
    expect(vlanInterfaceChanges(v, { ...f, vlanId: '21', enabled: false, comment: 'Guests' }))
      .toEqual({ vlan_id: 21, disabled: true, comment: 'Guests' });
    expect(vlanInterfaceChanges(v, { ...f, parent: 'bridge', name: 'guest', mtu: '1400' }))
      .toEqual({ interface: 'bridge', name: 'guest', mtu: 1400 });
  });
  it('does not clear the name or MTU when left blank', () => {
    expect(vlanInterfaceChanges(v, { ...f, name: ' ', mtu: '' })).toEqual({});
  });
});

describe('vlanNameError', () => {
  it('accepts a blank name (the default) and ordinary names', () => {
    expect(vlanNameError('')).toBeNull();
    expect(vlanNameError('vlan20')).toBeNull();
    expect(vlanNameError('guest-wifi_2.4')).toBeNull();
  });
  it('says what is wrong, as the server would refuse it', () => {
    expect(vlanNameError('guest wifi')).toBe("It can't contain spaces");
    expect(vlanNameError('a,b')).toBe("It can't contain ,");
    expect(vlanNameError('a;b')).toBe("It can't contain ;");
    expect(vlanNameError('a"b')).toBe('It can\'t contain "');
    expect(vlanNameError('a\\b')).toBe("It can't contain \\");
    expect(vlanNameError('x'.repeat(65))).toBe('At most 64 characters');
  });
});

describe('vlanMtuError', () => {
  it('accepts blank and 64 to 65535', () => {
    expect(vlanMtuError('')).toBeNull();
    expect(vlanMtuError('1500')).toBeNull();
    expect(vlanMtuError('64')).toBeNull();
  });
  it('refuses the rest', () => {
    expect(vlanMtuError('63')).toBe('From 64 to 65535');
    expect(vlanMtuError('70000')).toBe('From 64 to 65535');
  });
});

describe('vlanAddressError', () => {
  it('accepts blank, IPv4 and IPv6 with a prefix', () => {
    expect(vlanAddressError('')).toBeNull();
    expect(vlanAddressError('10.0.20.1/24')).toBeNull();
    expect(vlanAddressError('2001:db8::1/64')).toBeNull();
  });
  it('says what is missing or wrong', () => {
    expect(vlanAddressError('10.0.20.1')).toBe('Include the prefix length, e.g. 10.0.20.1/24');
    expect(vlanAddressError('10.0.20.1/33')).toBe('An IPv4 prefix is at most /32');
    expect(vlanAddressError('10.0.20.300/24')).toBe('Not an IPv4 or IPv6 address');
    expect(vlanAddressError('2001:db8::1/129')).toBe('An IPv6 prefix is at most /128');
    expect(vlanAddressError('router/24')).toBe('Not an IPv4 or IPv6 address');
  });
});
