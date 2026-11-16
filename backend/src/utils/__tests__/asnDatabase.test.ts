import { parseAsnTsv, lookupIn, specialKind, ipv4ToInt, ipv6ToHalves, displayOrg } from '../asnDatabase';

const TSV = [
  '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
  '8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE - Google LLC',
  '9.9.9.0\t9.9.9.255\t0\tNone\tNot routed',
  '142.250.0.0\t142.251.255.255\t15169\tUS\tGOOGLE',
  '149.154.160.0\t149.154.175.255\t62041\tGB\tTELEGRAM',
  '2001:4860::\t2001:4860:ffff:ffff:ffff:ffff:ffff:ffff\t15169\tUS\tGOOGLE',
  '2606:4700::\t2606:4700:ffff:ffff:ffff:ffff:ffff:ffff\t13335\tUS\tCLOUDFLARENET',
  'garbage line',
  '',
].join('\n');

describe('ASN lookup (#366)', () => {
  const t = parseAsnTsv(TSV);

  it('names IPv4 addresses by their range', () => {
    expect(lookupIn(t, '142.250.74.110')).toEqual({ asn: 15169, org: 'Google LLC', country: 'US' });
    expect(lookupIn(t, '149.154.167.51')).toMatchObject({ asn: 62041, org: 'TELEGRAM', country: 'GB' });
    expect(lookupIn(t, '1.0.0.1')).toMatchObject({ asn: 13335 });
    expect(lookupIn(t, '8.8.8.255')).toMatchObject({ asn: 15169 });
  });

  it('returns nothing between ranges, for not-routed space, or for nonsense', () => {
    expect(lookupIn(t, '8.8.9.1')).toBeNull();
    expect(lookupIn(t, '9.9.9.9')).toBeNull();
    expect(lookupIn(t, '0.0.0.1')).toBeNull();
    expect(lookupIn(t, '255.255.255.255')).toBeNull();
    expect(lookupIn(t, 'not-an-ip')).toBeNull();
  });

  it('names IPv6 addresses, including compressed forms', () => {
    expect(lookupIn(t, '2001:4860:4860::8888')).toMatchObject({ asn: 15169 });
    expect(lookupIn(t, '2606:4700:4700::1111')).toMatchObject({ asn: 13335 });
    expect(lookupIn(t, '2001:db8::1')).toBeNull();
  });

  it('reads IPv6 into two 64-bit halves', () => {
    expect(ipv6ToHalves('::1')).toEqual([0n, 1n]);
    expect(ipv6ToHalves('2001:db8::')).toEqual([0x20010db800000000n, 0n]);
    expect(ipv6ToHalves('::ffff:192.0.2.1')).toEqual([0n, 0xffffc0000201n]);
    expect(ipv6ToHalves('1.2.3.4')).toBeNull();
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
  });

  it('names addresses that aren\'t on the internet', () => {
    expect(specialKind('10.1.2.3')).toBe('private');
    expect(specialKind('172.20.0.1')).toBe('private');
    expect(specialKind('172.32.0.1')).toBeNull();
    expect(specialKind('100.100.1.1')).toBe('cgnat');
    expect(specialKind('239.255.255.250')).toBe('multicast');
    expect(specialKind('fd12::1')).toBe('private');
    expect(specialKind('fe80::1')).toBe('link-local');
    expect(specialKind('ff02::fb')).toBe('multicast');
    expect(specialKind('::ffff:192.168.1.1')).toBe('private');
    expect(specialKind('8.8.8.8')).toBeNull();
  });

  it('shows the organisation rather than the network handle', () => {
    expect(displayOrg('AMAZON-02 - Amazon.com, Inc.')).toBe('Amazon.com, Inc.');
    expect(displayOrg('Telegram Telegram Messenger Inc')).toBe('Telegram Telegram Messenger Inc');
  });
});
