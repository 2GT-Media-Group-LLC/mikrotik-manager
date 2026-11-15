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
