import { describe, it, expect } from 'vitest';
import { shortPort, shortPortLabel, bondOf, portLabel } from './portLabel';

describe('shortPort (#367)', () => {
  it('drops the bridge and bond a RouterOS port is in', () => {
    expect(shortPort('bridge/bonding/sfp-sfpplus1')).toBe('sfp1');
    expect(shortPort('bridge/ether17')).toBe('e17');
    expect(shortPort('bridge1/bond-uplink/qsfp28-1-1')).toBe('qsfp28-1-1');
  });

  it('shortens MikroTik port names', () => {
    expect(shortPort('ether1')).toBe('e1');
    expect(shortPort('sfp-sfpplus12')).toBe('sfp12');
    expect(shortPort('sfp28-1')).toBe('sfp28-1');
    expect(shortPort('combo1')).toBe('combo1');
    expect(shortPort('wifi1')).toBe('wifi1');
    expect(shortPort('vlan300')).toBe('vlan300');
  });

  it("keeps a slot and port number, in Cisco's short form", () => {
    expect(shortPort('GigabitEthernet1/0/17')).toBe('Gi1/0/17');
    expect(shortPort('TenGigabitEthernet1/1/1')).toBe('Te1/1/1');
    expect(shortPort('TwentyFiveGigE1/0/1')).toBe('Twe1/0/1');
    expect(shortPort('GigabitEthernet0')).toBe('Gi0');
    expect(shortPort('ge-0/0/1')).toBe('ge-0/0/1');
    expect(shortPort('1/1/17')).toBe('1/1/17');
  });

  it('leaves what it does not know alone', () => {
    expect(shortPort('eth0')).toBe('eth0');
    expect(shortPort('WG1')).toBe('WG1');
    expect(shortPort('ethernet-port')).toBe('ethernet-port');
  });

  it('shortens both ends of a link', () => {
    expect(shortPortLabel('sfp-sfpplus1 ↔ bridge/bonding/sfp-sfpplus1')).toBe('sfp1 ↔ sfp1');
    expect(shortPortLabel('ether1 ↔ bridge/ether17')).toBe('e1 ↔ e17');
    expect(shortPortLabel('ether3')).toBe('e3');
  });
});

describe('Port labels: keeping the bond (#367)', () => {
  it('finds the bond in a RouterOS path', () => {
    expect(bondOf('bridge/Po1/sfp-sfpplus1')).toBe('Po1');
    expect(bondOf('bridge/bonding/sfp-sfpplus1')).toBe('bonding');
    expect(bondOf('bond1/ether2')).toBe('bond1');
    // A bridge, not a bond, and paths that are slot numbers.
    expect(bondOf('bridge/ether17')).toBeNull();
    expect(bondOf('br-lan/ether17')).toBeNull();
    expect(bondOf('GigabitEthernet1/0/17')).toBeNull();
    expect(bondOf('ether1')).toBeNull();
  });

  it('shows aziz\'s LACP uplinks as LAGs again', () => {
    expect(shortPortLabel('sfp-sfpplus4 ↔ bridge/Po1/sfp-sfpplus1', true)).toBe('sfp4 ↔ Po1·sfp1');
    expect(shortPortLabel('ether21 ↔ bridge/Po21/ether21', true)).toBe('e21 ↔ Po21·e21');
    expect(shortPortLabel('ether1 ↔ bridge/ether17', true)).toBe('e1 ↔ e17');
  });

  it('labels a link as chosen', () => {
    const label = 'sfp-sfpplus4 ↔ bridge/Po1/sfp-sfpplus1';
    expect(portLabel(label, 'bond')).toBe('sfp4 ↔ Po1·sfp1');
    expect(portLabel(label, 'short')).toBe('sfp4 ↔ sfp1');
    expect(portLabel(label, 'full')).toBe(label);
    expect(portLabel(label, 'off')).toBeUndefined();
  });
});
