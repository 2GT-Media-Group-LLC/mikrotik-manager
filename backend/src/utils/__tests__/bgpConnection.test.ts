import { parseBgpConnection } from '../bgpConnection';

describe('parseBgpConnection', () => {
  it('accepts the form as the Routing tab sends it', () => {
    expect(parseBgpConnection({ name: 'isp1', 'remote.address': '203.0.113.1', 'remote.as': '64512', 'local.role': 'ebgp', local_as: '65000' }))
      .toEqual({ name: 'isp1', remoteAddress: '203.0.113.1', remoteAs: '64512', role: 'ebgp', localAs: '65000', instance: null });
  });
  it('local AS and instance are optional', () => {
    expect(parseBgpConnection({ name: 'p', remote_address: '2001:db8::1', remote_as: 4200000000 }))
      .toMatchObject({ remoteAddress: '2001:db8::1', remoteAs: '4200000000', role: 'ebgp', localAs: null, instance: null });
  });
  it('refuses bad input instead of passing it to RouterOS', () => {
    expect(parseBgpConnection({ name: 'a b', 'remote.address': '1.2.3.4', 'remote.as': '1' })).toHaveProperty('error');
    expect(parseBgpConnection({ name: 'p', 'remote.address': 'example.com', 'remote.as': '1' })).toHaveProperty('error');
    expect(parseBgpConnection({ name: 'p', 'remote.address': '1.2.3.4', 'remote.as': '0' })).toHaveProperty('error');
    expect(parseBgpConnection({ name: 'p', 'remote.address': '1.2.3.4', 'remote.as': '4294967296' })).toHaveProperty('error');
    expect(parseBgpConnection({ name: 'p', 'remote.address': '1.2.3.4', 'remote.as': '1', 'local.role': 'evil' })).toHaveProperty('error');
    expect(parseBgpConnection({ name: 'p', 'remote.address': '1.2.3.4', 'remote.as': '1', local_as: 'abc' })).toHaveProperty('error');
  });
});
