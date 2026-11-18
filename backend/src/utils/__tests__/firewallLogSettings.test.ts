import { colorsError, servicesError, SERVICES_MAX } from '../firewallLogSettings';

describe('servicesError', () => {
  it('takes well-formed entries', () => {
    expect(servicesError([])).toBeNull();
    expect(servicesError([
      { port: 443, protocol: 'tcp', name: 'Web (TLS)' },
      { port: 443, protocol: 'udp', name: 'QUIC' },
      { port: 9999, protocol: 'both', name: 'cam-01' },
    ])).toBeNull();
  });
  it('refuses bad ports, protocols and names', () => {
    expect(servicesError({})).toMatch(/list/);
    expect(servicesError([{ port: 0, protocol: 'tcp', name: 'x' }])).toMatch(/port/);
    expect(servicesError([{ port: 1.5, protocol: 'tcp', name: 'x' }])).toMatch(/port/);
    expect(servicesError([{ port: 80, protocol: 'icmp', name: 'x' }])).toMatch(/protocol/);
    expect(servicesError([{ port: 80, protocol: 'tcp', name: '<b>x</b>' }])).toMatch(/name/);
    expect(servicesError([{ port: 80, protocol: 'tcp', name: 'a'.repeat(33) }])).toMatch(/name/);
    expect(servicesError([{ port: 80, protocol: 'tcp', name: 'x', extra: 1 }])).toMatch(/fields/);
    expect(servicesError([null])).toMatch(/object/);
  });
  it('refuses a port listed twice', () => {
    expect(servicesError([
      { port: 53, protocol: 'both', name: 'DNS' },
      { port: 53, protocol: 'udp', name: 'Resolver' },
    ])).toMatch(/UDP port 53 is listed twice/);
  });
  it('takes port ranges, with single ports inside them (#415)', () => {
    expect(servicesError([
      { port: 5000, to: 5100, protocol: 'udp', name: 'Game' },
      { port: 5050, protocol: 'udp', name: 'Voice' },
      { port: 5000, to: 5100, protocol: 'tcp', name: 'Game TCP' },
    ])).toBeNull();
  });
  it('refuses a bad end of range, and ranges that overlap', () => {
    expect(servicesError([{ port: 5000, to: 5000, protocol: 'tcp', name: 'x' }])).toMatch(/end of the range/);
    expect(servicesError([{ port: 5000, to: 4000, protocol: 'tcp', name: 'x' }])).toMatch(/end of the range/);
    expect(servicesError([{ port: 5000, to: 70000, protocol: 'tcp', name: 'x' }])).toMatch(/end of the range/);
    expect(servicesError([{ port: 5000, to: '5100', protocol: 'tcp', name: 'x' }])).toMatch(/end of the range/);
    expect(servicesError([
      { port: 5000, to: 5100, protocol: 'both', name: 'A' },
      { port: 5100, to: 5200, protocol: 'udp', name: 'B' },
    ])).toMatch(/UDP ports 5000-5100 and 5100-5200 overlap/);
    expect(servicesError([
      { port: 5000, to: 5100, protocol: 'tcp', name: 'A' },
      { port: 5050, to: 5060, protocol: 'udp', name: 'B' },
    ])).toBeNull();
  });
  it('caps the list', () => {
    const many = Array.from({ length: SERVICES_MAX + 1 }, (_, i) => ({ port: i + 1, protocol: 'tcp', name: 'x' }));
    expect(servicesError(many)).toMatch(/at most/);
  });
});

describe('colorsError', () => {
  it('takes known colours', () => {
    expect(colorsError({ dhcp: 'none', multicast: 'violet' })).toBeNull();
    expect(colorsError({})).toBeNull();
  });
  it('refuses the rest', () => {
    expect(colorsError([])).toMatch(/object/);
    expect(colorsError({ dhcp: 'red; }' })).toMatch(/one of/);
    expect(colorsError({ arp: 'blue' })).toMatch(/only/);
  });
});
