import { describe, it, expect } from 'vitest';
import { isIpOrPrefix, splitList, hostAddressProblem, routeInputProblem } from './ipPrefix';

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

describe('routeInputProblem (#505)', () => {
  it('accepts networks, hosts, the default route and interface gateways', () => {
    expect(routeInputProblem('10.100.32.0/24', '192.168.1.1')).toBeNull();
    expect(routeInputProblem('0.0.0.0/0', 'ether1')).toBeNull();
    expect(routeInputProblem('10.1.2.3', '10.0.0.1%ether2')).toBeNull();
    expect(routeInputProblem('10.1.2.3/24', '')).toBeNull();
  });

  it('refuses a bad destination or an address-like gateway that is not one', () => {
    expect(routeInputProblem('10.100.32.256/24', '192.168.1.1')).toMatch(/not a valid destination/);
    expect(routeInputProblem('10.100.32.0/33', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('10.100.32/24', '192.168.1.1')).not.toBeNull();
    expect(routeInputProblem('0.0.0.0/0', '192.168.1.256')).toMatch(/not a valid gateway/);
  });
});
