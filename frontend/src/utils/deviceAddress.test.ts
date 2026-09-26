import { describe, it, expect } from 'vitest';
import {
  isValidDeviceAddress, isValidIPv4, isValidIPv6, isValidHostname,
  isPrivateIp, classifyAddress, splitAddressAndPort,
} from './deviceAddress';

describe('isValidDeviceAddress', () => {
  it('accepts a LAN IPv4 address', () => {
    expect(isValidDeviceAddress('192.168.88.1')).toBe(true);
  });

  it('accepts a public IPv4 address', () => {
    expect(isValidDeviceAddress('203.0.113.5')).toBe(true);
  });

  it('accepts a hostname', () => {
    expect(isValidDeviceAddress('router.example.com')).toBe(true);
  });

  it('accepts a DDNS-style hostname', () => {
    expect(isValidDeviceAddress('abc123.sn.mynetname.net')).toBe(true);
  });

  it('accepts a bare IPv6 address', () => {
    expect(isValidDeviceAddress('2001:db8::1')).toBe(true);
    expect(isValidDeviceAddress('::1')).toBe(true);
  });

  it('rejects an out-of-range dotted quad rather than treating it as a hostname', () => {
    expect(isValidDeviceAddress('999.999.999.999')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isValidDeviceAddress('not a host!!')).toBe(false);
    expect(isValidDeviceAddress('')).toBe(false);
  });
});

describe('isValidIPv4 / isValidIPv6 / isValidHostname', () => {
  it('classify each shape correctly', () => {
    expect(isValidIPv4('10.0.0.1')).toBe(true);
    expect(isValidIPv4('10.0.0.1.1')).toBe(false);
    expect(isValidIPv6('fe80::1')).toBe(true);
    expect(isValidIPv6('10.0.0.1')).toBe(false);
    expect(isValidHostname('switch-1.lan')).toBe(true);
    expect(isValidHostname('10.0.0.1')).toBe(false);
  });
});

describe('isPrivateIp / classifyAddress', () => {
  it('flags RFC1918 and loopback ranges as private', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
  });

  it('does not flag a public IP as private', () => {
    expect(isPrivateIp('203.0.113.5')).toBe(false);
  });

  it('classifies address kinds for the plaintext-credentials hint', () => {
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('203.0.113.5')).toBe('public');
    expect(classifyAddress('router.example.com')).toBe('hostname');
  });
});

describe('splitAddressAndPort', () => {
  it('pulls host and port out of a pasted URL', () => {
    expect(splitAddressAndPort('https://1.2.3.4:8729/')).toEqual({ address: '1.2.3.4', port: 8729 });
  });

  it('pulls host and port out of a bracketed IPv6 URL', () => {
    expect(splitAddressAndPort('[2001:db8::1]:8729')).toEqual({ address: '2001:db8::1', port: 8729 });
  });

  it('splits a bare host:port', () => {
    expect(splitAddressAndPort('192.168.1.1:8728')).toEqual({ address: '192.168.1.1', port: 8728 });
  });

  it('leaves a plain address untouched', () => {
    expect(splitAddressAndPort('router.example.com')).toEqual({ address: 'router.example.com' });
  });

  it('leaves a bare IPv6 address untouched (no ambiguous trailing port)', () => {
    expect(splitAddressAndPort('2001:db8::1')).toEqual({ address: '2001:db8::1' });
  });
});
