import { describe, it, expect } from 'vitest';
import { portKind, linkKind } from './topologyPorts';

describe('portKind (#367)', () => {
  it('goes by the RouterOS type when there is one', () => {
    expect(portKind('sfp-sfpplus1', 'ether')).toBe('physical');
    expect(portKind('vlan300', 'vlan')).toBe('logical');
    expect(portKind('VLAN-MGMT', 'vlan')).toBe('logical');
    expect(portKind('vrrp10', 'vrrp')).toBe('logical');
    expect(portKind('bond1', 'bond')).toBe('logical');
    expect(portKind('bridge', 'bridge')).toBe('logical');
    expect(portKind('WG1', 'wg')).toBe('tunnel');
    expect(portKind('to-branch', 'eoip')).toBe('tunnel');
    expect(portKind('gre-dc', 'gre-tunnel')).toBe('tunnel');
    expect(portKind('wifi1', 'wifi')).toBe('physical');
    // The type wins over a misleading name.
    expect(portKind('vlan-uplink', 'ether')).toBe('physical');
  });

  it('falls back to the name, any vendor', () => {
    expect(portKind('vlan10')).toBe('logical');
    expect(portKind('Vlan98')).toBe('logical');
    expect(portKind('Po15')).toBe('logical');
    expect(portKind('Port-channel21')).toBe('logical');
    expect(portKind('WG1')).toBe('tunnel');
    expect(portKind('Tunnel0')).toBe('tunnel');
    expect(portKind('GigabitEthernet0')).toBe('physical');
    expect(portKind('ether17')).toBe('physical');
    expect(portKind('bridge/ether17')).toBe('physical');
    expect(portKind('port1')).toBe('physical');
    expect(portKind('green-lan')).toBe('physical');
    expect(portKind('Port 13')).toBe('physical');
    expect(portKind(undefined)).toBe('physical');
    expect(portKind('')).toBe('physical');
  });

  it('linkKind takes the least cable-like end', () => {
    expect(linkKind('physical', 'physical')).toBe('physical');
    expect(linkKind('physical', 'logical')).toBe('logical');
    expect(linkKind('logical', 'tunnel')).toBe('tunnel');
    expect(linkKind()).toBe('physical');
  });
});
