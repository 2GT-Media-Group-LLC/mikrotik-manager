import { torchParams, frameOf, toFlow } from '../torch';

describe('torchParams', () => {
  it('matches every flow when no filter is given', () => {
    const r = torchParams({ deviceId: 1, interface: 'bridge' });
    expect(r).toEqual({ params: {
      interface: 'bridge', 'src-address': '0.0.0.0/0', 'src-address6': '::/0',
      'dst-address': '0.0.0.0/0', 'dst-address6': '::/0', port: 'any', 'ip-protocol': 'any',
    } });
  });

  it('takes IPv4 and IPv6 filters on their own keys', () => {
    const r = torchParams({ deviceId: 1, interface: 'ether1', srcAddress: '10.0.0.0/24', dstAddress: '2001:db8::/32', port: '443', protocol: 'TCP' });
    expect('params' in r && r.params).toMatchObject({ 'src-address': '10.0.0.0/24', 'dst-address6': '2001:db8::/32', port: '443', 'ip-protocol': 'tcp' });
    expect('params' in r && r.params['dst-address']).toBeUndefined();
  });

  it('refuses bad input', () => {
    expect(torchParams({ deviceId: 1, interface: '' })).toHaveProperty('error');
    expect(torchParams({ deviceId: 1, interface: 'a=b' })).toHaveProperty('error');
    expect(torchParams({ deviceId: 1, interface: 'e1', srcAddress: 'nope' })).toHaveProperty('error');
    expect(torchParams({ deviceId: 1, interface: 'e1', port: '70000' })).toHaveProperty('error');
    expect(torchParams({ deviceId: 1, interface: 'e1', protocol: 'smtp' })).toHaveProperty('error');
  });
});

describe('frames', () => {
  it('turns rows into flows, busiest first', () => {
    const rows: Record<string, string>[] = [
      { 'mac-protocol': 'ip', 'ip-protocol': 'tcp', 'src-address': '10.0.0.2', 'src-port': '5000', 'dst-address': '1.1.1.1', 'dst-port': '443', tx: '800', rx: '100', 'tx-packets': '1', 'rx-packets': '1' },
      { 'mac-protocol': 'ip', 'ip-protocol': 'udp', 'src-address6': 'fe80::1', 'dst-address6': 'ff02::1', tx: '90000', rx: '0' },
    ];
    const f = frameOf(rows);
    expect(f.total).toBe(2);
    expect(f.flows[0]).toMatchObject({ proto: 'udp', src: 'fe80::1', dst: 'ff02::1', tx: 90000 });
    expect(f.flows[1]).toMatchObject({ srcPort: '5000', dstPort: '443', tx: 800, rx: 100 });
    expect(toFlow({}).tx).toBe(0);
  });
});
