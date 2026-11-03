import { describe, it, expect } from 'vitest';
import { capsLabel, neighbourType, deviceRole } from './nodes';

describe('capsLabel (#260)', () => {
  it('calls a computer with a software bridge a computer, not a switch', () => {
    expect(capsLabel('bridge,station')).toBe('Computer');
  });
  it('calls an access point an AP although it bridges', () => {
    expect(capsLabel('bridge,wlan-ap')).toBe('AP');
  });
  it('keeps a layer-3 switch a switch', () => {
    expect(capsLabel('bridge,router')).toBe('Switch');
    expect(capsLabel('router')).toBe('Router');
    expect(capsLabel('')).toBe('');
  });
});

describe('neighbourType (#367)', () => {
  it('takes an access point that only says "bridge" for an AP by its platform', () => {
    expect(neighbourType('bridge', 'cisco C9120AXI-B')).toBe('AP');
    expect(neighbourType('bridge', 'Cisco AP Software, C9120-k9w8 Version: 17.9.4')).toBe('AP');
    expect(neighbourType('bridge', 'UAP-AC-Pro-Gen2')).toBe('AP');
    expect(neighbourType('bridge,router', 'Aruba AP-515')).toBe('AP');
  });

  it('or by its system description, when the platform is only "Cisco"', () => {
    // aziz's 9120: platform "Cisco", the model only in the description.
    expect(neighbourType('bridge', 'Cisco', 'Cisco AP Software, C9120AXI-B Software (AP1G6A), Version 17.9.4a')).toBe('AP');
    expect(neighbourType('bridge', 'Cisco', 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE)')).toBe('Switch');
    expect(neighbourType('bridge', 'Cisco', '')).toBe('Switch');
  });

  it('leaves switches, and what the capabilities settle, alone', () => {
    expect(neighbourType('bridge', 'Cisco IOS Software, C9300 Software')).toBe('Switch');
    expect(neighbourType('bridge', 'MikroTik RouterOS 7.20 (CRS328-24P-4S+)')).toBe('Switch');
    expect(neighbourType('bridge,station', 'Microsoft Windows')).toBe('Computer');
    expect(neighbourType('router', '')).toBe('Router');
    expect(neighbourType(undefined, undefined)).toBe('');
  });
});

describe('deviceRole (#367)', () => {
  it('names what a device does, in order', () => {
    expect(deviceRole({ gateway: true })).toBe('Gateway');
    expect(deviceRole({ isRootBridge: true, wifi_role: 'controller' })).toBe('CAPsMAN · STP root');
    expect(deviceRole({ wifi_role: 'cap' })).toBe('CAP');
    expect(deviceRole({ wifi_role: 'standalone' })).toBeNull();
  });
});

describe('neighbourType: wireless controllers (#367)', () => {
  it("doesn't take a wireless LAN controller for an AP", () => {
    expect(neighbourType('bridge,router', 'Cisco Wireless LAN Controller C9800-40-K9')).toBe('Switch');
  });
});
