import { expandIpv6, embeddedIpv4 } from '../ipv6';
import { isInternalOnlyAddress } from '../alertTarget';
import { isBlockedAddress } from '../deviceAddress';

describe('expandIpv6', () => {
  it('expands compressed, full, dotted and zoned forms', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('0:0:0:0:0:0:0:1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6('::ffff:7f00:1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6('[fe80::1%eth0]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('not-an-ip')).toBeNull();
  });

  it('finds an embedded IPv4 address in each form that reaches it', () => {
    const v4 = (ip: string) => embeddedIpv4(expandIpv6(ip)!);
    expect(v4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(v4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(v4('::ffff:0:a00:1')).toBe('10.0.0.1');        // IPv4-translated
    expect(v4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254'); // NAT64
    expect(v4('::7f00:1')).toBe('127.0.0.1');             // IPv4-compatible
    expect(v4('::1')).toBeNull();
    expect(v4('2001:db8::1')).toBeNull();
  });
});

// GHSA-28hr-v457-cc6g: the hex form of an IPv4-mapped address passed both guards.
describe('address guards with embedded IPv4', () => {
  const internal = ['::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '0:0:0:0:0:0:0:1', '0::0'];
  it.each(internal)('alert targets refuse %s', (ip) => expect(isInternalOnlyAddress(ip)).toBe(true));
  it.each([...internal, '::ffff:a00:1', '::ffff:c0a8:101', 'fd00::1', 'ff02::1'])('webhooks refuse %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it('still allows public and (for alert channels) private destinations', () => {
    expect(isInternalOnlyAddress('2001:db8::1')).toBe(false);
    expect(isInternalOnlyAddress('::ffff:c0a8:101')).toBe(false); // 192.168.1.1: LAN ntfy/Gotify stay allowed
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:808:808')).toBe(false);       // 8.8.8.8
  });
});
