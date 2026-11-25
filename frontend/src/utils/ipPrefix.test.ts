import { describe, it, expect } from 'vitest';
import { isIpOrPrefix, splitList, hostAddressProblem } from './ipPrefix';

describe('isIpOrPrefix / splitList (#207)', () => {
  it('accepts addresses and prefixes', () => {
    for (const ok of ['10.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '2001:db8::1', '2001:db8::/32', '::/0']) expect(isIpOrPrefix(ok)).toBe(true);
  });
  it('rejects the rest', () => {
    for (const bad of ['10.0.0.0/33', '2001:db8::/129', 'host.example', '10.0.0.0/8/1', '', '10.0.0']) expect(isIpOrPrefix(bad)).toBe(false);
  });
  it('splits on commas, spaces and new lines', () => {
    expect(splitList(' 10.0.0.0/8, 192.168.1.0/24\n2001:db8::/32;10.1.1.1 ')).toEqual(['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32', '10.1.1.1']);
  });
});

describe('hostAddressProblem (#505)', () => {
  it('names the network and broadcast addresses and suggests a host', () => {
    expect(hostAddressProblem('192.168.33.0/24')).toMatch(/network address .* such as 192\.168\.33\.1\/24/);
    expect(hostAddressProblem(' 192.168.33.255/24 ')).toMatch(/broadcast .* such as 192\.168\.33\.254\/24/);
  });
  it('accepts hosts, /31, /32 and anything it cannot read', () => {
    expect(hostAddressProblem('192.168.33.1/24')).toBeNull();
    expect(hostAddressProblem('10.0.0.0/31')).toBeNull();
    expect(hostAddressProblem('10.0.0.0/32')).toBeNull();
    expect(hostAddressProblem('10.0.0.0')).toBeNull();
    expect(hostAddressProblem('192.168.1.')).toBeNull();
  });
});
