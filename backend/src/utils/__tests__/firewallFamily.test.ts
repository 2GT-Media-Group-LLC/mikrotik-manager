import { firewallFamily, firewallMenu, managedOverIpv4 } from '../firewallFamily';

describe('firewallFamily', () => {
  it('reads ?family=, IPv4 by default', () => {
    expect(firewallFamily(undefined)).toBe('ip');
    expect(firewallFamily('')).toBe('ip');
    expect(firewallFamily('ipv4')).toBe('ip');
    expect(firewallFamily('ipv6')).toBe('ipv6');
  });
  it('refuses anything else, so a typo never writes the wrong table', () => {
    expect(firewallFamily('IPv6')).toBeNull();
    expect(firewallFamily('v6')).toBeNull();
    expect(firewallFamily(['ipv6'])).toBeNull();
  });
});

describe('firewallMenu', () => {
  it('names the RouterOS menu for each table', () => {
    expect(firewallMenu('ip', 'filter')).toBe('/ip/firewall/filter');
    expect(firewallMenu('ipv6', 'nat')).toBe('/ipv6/firewall/nat');
    expect(firewallMenu('ipv6', 'address-list')).toBe('/ipv6/firewall/address-list');
  });
});

describe('managedOverIpv4', () => {
  it('is true only for an IPv4 address', () => {
    expect(managedOverIpv4('192.168.0.51')).toBe(true);
    expect(managedOverIpv4('2001:db8::1')).toBe(false);
    expect(managedOverIpv4('router.example.com')).toBe(false);
  });
});
