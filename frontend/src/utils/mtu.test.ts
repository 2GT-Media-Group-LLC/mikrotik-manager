import { describe, it, expect } from 'vitest';
import { bridgeMtuCeiling, bridgeMtuError, portMtuError, portMtuMax } from './mtu';

const port = (name: string, l2mtu: number | null, maxL2mtu: number | null = 10218) =>
  ({ name, hw: true, pvid: '1', disabled: false, inactive: false, dynamic: false, role: null, l2mtu, maxL2mtu });
// TEST (CRS3xx, 7.25): RouterOS took 1508 and refused 1600.
const b = { ports: [port('sfp-sfpplus1', 1508), port('sfp-sfpplus3', 1584), port('wlan1', null, null)] };

describe('bridge MTU (form)', () => {
  it('finds the most the bridge can take now', () => {
    expect(bridgeMtuCeiling(b)).toBe(1508);
    expect(bridgeMtuCeiling({ ports: [] })).toBeNull();
  });
  it('checks as the server does', () => {
    expect(bridgeMtuError('auto', b)).toBeNull();
    expect(bridgeMtuError('1508', b)).toBeNull();
    expect(bridgeMtuError('1550', b)).toBe('Raise the MTU of sfp-sfpplus1 (1508) on the Ports tab first. Or keep it at 1508 or less.');
    expect(bridgeMtuError('9000', b)).toMatch(/sfp-sfpplus1 \(1508\), sfp-sfpplus3 \(1584\) on the Ports tab/);
    expect(bridgeMtuError('100', b)).toMatch(/576 to 65535/);
  });
  it('says a port whose hardware stops short has to leave the bridge (CRS510 ether1)', () => {
    const crs510 = { ports: [port('ether1', 2028, 2028), port('qsfp28-1-1', 1584)] };
    expect(bridgeMtuError('9000', crs510)).toBe(
      'Raise the MTU of qsfp28-1-1 (1584) on the Ports tab first. ether1 (2028) can\'t go that high; take it out of the bridge, or keep it at 2028 or less.');
  });
});

describe('port MTU (form)', () => {
  it('stops at what the hardware takes', () => {
    expect(portMtuMax({ 'max-l2mtu': '2028' })).toBe(2028);
    expect(portMtuMax({})).toBeNull();
    expect(portMtuError('2028', 2028)).toBeNull();
    expect(portMtuError('9000', 2028)).toBe("2028 is the most this port's hardware takes.");
    expect(portMtuError('10218', 10218)).toBeNull();
    expect(portMtuError('500', 10218)).toBe('576 to 10218');
    expect(portMtuError('', null)).toBe('576 to 65535');
  });
});
