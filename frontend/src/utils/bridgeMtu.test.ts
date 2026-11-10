import { describe, it, expect } from 'vitest';
import { bridgeMtuCeiling, bridgeMtuError } from './bridgeMtu';

const port = (name: string, l2mtu: number | null) => ({ name, hw: true, pvid: '1', disabled: false, inactive: false, dynamic: false, role: null, l2mtu });
// TEST (CRS3xx, 7.25): RouterOS took 1508 and refused 1600.
const b = { ports: [port('sfp-sfpplus1', 1508), port('sfp-sfpplus3', 1584), port('wlan1', null)] };

describe('bridge MTU (form)', () => {
  it('finds the most the bridge can take', () => {
    expect(bridgeMtuCeiling(b)).toBe(1508);
    expect(bridgeMtuCeiling({ ports: [] })).toBeNull();
  });
  it('checks as the server does', () => {
    expect(bridgeMtuError('auto', b)).toBeNull();
    expect(bridgeMtuError('1508', b)).toBeNull();
    expect(bridgeMtuError('1550', b)).toMatch(/sfp-sfpplus1 \(1508\)\. Raise its MTU.*1508 or less/);
    expect(bridgeMtuError('9000', b)).toMatch(/sfp-sfpplus1 \(1508\), sfp-sfpplus3 \(1584\)\. Raise their/);
    expect(bridgeMtuError('100', b)).toMatch(/576 to 65535/);
  });
});
