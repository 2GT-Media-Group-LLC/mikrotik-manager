import { normalizeDeviceAddress, isBlockedAddress, classifyAddress } from '../deviceAddress';

describe('normalizeDeviceAddress', () => {
  it('accepts a plain LAN IPv4 address unchanged', () => {
    expect(normalizeDeviceAddress('192.168.88.1')).toEqual({ ok: true, address: '192.168.88.1' });
  });

  it('accepts a public IPv4 address', () => {
    expect(normalizeDeviceAddress('203.0.113.5')).toEqual({ ok: true, address: '203.0.113.5' });
  });

  it('accepts a hostname and lowercases it', () => {
    expect(normalizeDeviceAddress('Router1.Example.COM'))
      .toEqual({ ok: true, address: 'router1.example.com' });
  });

  it('accepts a DDNS-style hostname', () => {
    expect(normalizeDeviceAddress('abc123.sn.mynetname.net'))
      .toEqual({ ok: true, address: 'abc123.sn.mynetname.net' });
  });

  it('accepts a 253-char FQDN (the migration widened the column for exactly this)', () => {
    const label = 'a'.repeat(60);
    const fqdn = `${label}.${label}.${label}.example`;
    expect(fqdn.length).toBeLessThanOrEqual(253);
    const result = normalizeDeviceAddress(fqdn);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.address).toBe(fqdn);
  });

  it('rejects a hostname over 253 chars', () => {
    const tooLong = `${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}.${'d'.repeat(64)}.example`;
    const result = normalizeDeviceAddress(tooLong);
    expect(result.ok).toBe(false);
  });

  it('accepts a bare IPv6 address', () => {
    expect(normalizeDeviceAddress('2001:db8::1')).toEqual({ ok: true, address: '2001:db8::1' });
  });

  it('accepts IPv6 loopback', () => {
    expect(normalizeDeviceAddress('::1')).toEqual({ ok: true, address: '::1' });
  });

  it('accepts a bracketed IPv6 address with a port', () => {
    expect(normalizeDeviceAddress('[2001:db8::1]:8729')).toEqual({ address: '2001:db8::1', ok: true, port: 8729 });
  });

  it('strips a pasted https URL, pulling out host and port', () => {
    expect(normalizeDeviceAddress('https://1.2.3.4:8729/'))
      .toEqual({ ok: true, address: '1.2.3.4', port: 8729 });
  });

  it('strips a pasted URL with no port', () => {
    expect(normalizeDeviceAddress('http://router.example.com/webfig'))
      .toEqual({ ok: true, address: 'router.example.com' });
  });

  it('splits a bare host:port', () => {
    expect(normalizeDeviceAddress('192.168.1.1:8728'))
      .toEqual({ ok: true, address: '192.168.1.1', port: 8728 });
  });

  it('rejects an empty address', () => {
    const result = normalizeDeviceAddress('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/required/i);
  });

  it('rejects garbage input', () => {
    expect(normalizeDeviceAddress('not a host!!').ok).toBe(false);
    expect(normalizeDeviceAddress('999.999.999.999').ok).toBe(false);
  });

  it('rejects an invalid IPv6-looking address', () => {
    expect(normalizeDeviceAddress('[not:valid:ipv6]').ok).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it('blocks RFC1918 ranges', () => {
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
  });

  it('blocks loopback and link-local', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.1.1')).toBe(true);
  });

  it('allows a public IPv4 address', () => {
    expect(isBlockedAddress('203.0.113.5')).toBe(false);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedAddress('2001:db8::1')).toBe(false);
  });

  it('blocks IPv6 loopback and unique-local', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
  });
});

describe('classifyAddress', () => {
  it('classifies a LAN IP as private', () => {
    expect(classifyAddress('192.168.88.1')).toBe('private');
  });

  it('classifies a public IP as public', () => {
    expect(classifyAddress('203.0.113.5')).toBe('public');
  });

  it('classifies a hostname as hostname', () => {
    expect(classifyAddress('router.example.com')).toBe('hostname');
  });
});

import { reconcileAddressPort } from '../deviceAddress';

describe('reconcileAddressPort', () => {
  it('uses a port written into the address when none is given separately', () => {
    expect(reconcileAddressPort(8729, undefined)).toEqual({ ok: true, port: 8729 });
    expect(reconcileAddressPort(8729, '')).toEqual({ ok: true, port: 8729 });
  });
  it('accepts both when they agree, and changes nothing without an address port', () => {
    expect(reconcileAddressPort(8729, 8729)).toEqual({ ok: true });
    expect(reconcileAddressPort(undefined, 8728)).toEqual({ ok: true });
  });
  it('refuses a conflict instead of guessing', () => {
    expect(reconcileAddressPort(8729, 8728).ok).toBe(false);
  });
});
