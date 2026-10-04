import { managementTunnel, prefixContains, allowedCovers, peerRule, type TunnelState } from '../wireguardPath';

const wg = [{ '.id': '*A', name: 'wg-mgmt' }, { '.id': '*B', name: 'wg-site' }];
const peers = [
  { '.id': '*1', interface: 'wg-mgmt', 'allowed-address': '10.99.0.1/32', disabled: 'false' },
  { '.id': '*2', interface: 'wg-mgmt', 'allowed-address': '10.99.0.50/32,192.168.50.0/24', disabled: 'false' },
  { '.id': '*3', interface: 'wg-site', 'allowed-address': '172.16.0.0/16', disabled: 'false' },
  { '.id': '*4', interface: 'wg-mgmt', 'allowed-address': '0.0.0.0/0', disabled: 'true' },
];
const base = (over: Partial<TunnelState>): TunnelState => ({
  addresses: [], routes: [], wgInterfaces: wg, peers, deviceIp: '10.99.0.7', managerIp: '10.99.0.1', ...over,
});

describe('prefixContains / allowedCovers', () => {
  it('matches IPv4 and IPv6 prefixes and single addresses', () => {
    expect(prefixContains('10.99.0.0/24', '10.99.0.7')).toBe(true);
    expect(prefixContains('10.99.0.1', '10.99.0.1')).toBe(true);
    expect(prefixContains('10.99.0.1/32', '10.99.0.2')).toBe(false);
    expect(prefixContains('fd00::/64', 'fd00::5')).toBe(true);
    expect(prefixContains('fd00::/64', '10.0.0.1')).toBe(false);
    expect(prefixContains('junk', '10.0.0.1')).toBe(false);
  });
  it('checks every allowed address', () => {
    expect(allowedCovers('10.99.0.50/32, 192.168.50.0/24', '192.168.50.9')).toBe(true);
    expect(allowedCovers('', '1.2.3.4')).toBe(false);
  });
});

describe('managementTunnel (#205)', () => {
  it('finds the tunnel when the managed address sits on a WireGuard interface', () => {
    const t = managementTunnel(base({ addresses: [{ address: '10.99.0.7/24', interface: 'wg-mgmt', disabled: 'false' }] }));
    expect(t).toMatchObject({ interface: 'wg-mgmt', interfaceId: '*A', via: 'address', peerIds: ['*1'], peerCertain: true });
    expect(t.reason).toMatch(/10\.99\.0\.7.*wg-mgmt/);
  });

  it('finds it from the route back to the manager', () => {
    const t = managementTunnel(base({
      deviceIp: '192.168.88.1',
      managerIp: '192.168.50.20',
      addresses: [{ address: '192.168.88.1/24', interface: 'bridge', disabled: 'false' }],
      routes: [
        { 'dst-address': '0.0.0.0/0', gateway: '192.168.88.254', 'immediate-gw': '192.168.88.254%bridge', active: 'true' },
        { 'dst-address': '192.168.50.0/24', gateway: 'wg-mgmt', 'immediate-gw': 'wg-mgmt', active: 'true' },
      ],
    }));
    expect(t).toMatchObject({ interface: 'wg-mgmt', via: 'route', peerIds: ['*2'], peerCertain: true });
  });

  it('treats every enabled peer as possible when the manager address is unknown', () => {
    const t = managementTunnel(base({ managerIp: null, addresses: [{ address: '10.99.0.7/24', interface: 'wg-mgmt', disabled: 'false' }] }));
    expect(t.peerCertain).toBe(false);
    expect(t.peerIds).toEqual(['*1', '*2']);
  });

  it('reports no tunnel when management arrives some other way', () => {
    const t = managementTunnel(base({
      deviceIp: '192.168.88.1', managerIp: '192.168.88.10',
      addresses: [{ address: '192.168.88.1/24', interface: 'bridge', disabled: 'false' }],
      routes: [{ 'dst-address': '192.168.88.0/24', gateway: 'bridge', 'immediate-gw': 'bridge', active: 'true' }],
    }));
    expect(t.interface).toBeNull();
    expect(t.peerIds).toEqual([]);
  });

  it('reports no tunnel on a device without WireGuard', () => {
    expect(managementTunnel(base({ wgInterfaces: [] })).interface).toBeNull();
  });
});

describe('peerRule (#205)', () => {
  const t = managementTunnel(base({ addresses: [{ address: '10.99.0.7/24', interface: 'wg-mgmt', disabled: 'false' }] }));
  const refused = (v: ReturnType<typeof peerRule>) => !!v && 'refuse' in v;
  const guarded = (v: ReturnType<typeof peerRule>) => !!v && 'protect' in v;

  it('refuses deleting or disabling the peer that carries the manager', () => {
    expect(refused(peerRule(t, '*1', undefined, 'remove'))).toBe(true);
    expect(refused(peerRule(t, '*1', { disabled: 'yes' }, 'set'))).toBe(true);
  });
  it('refuses dropping the manager from its allowed addresses, or moving it', () => {
    expect(refused(peerRule(t, '*1', { 'allowed-address': '10.99.0.2/32' }, 'set'))).toBe(true);
    expect(refused(peerRule(t, '*1', { interface: 'wg-site' }, 'set'))).toBe(true);
  });
  it('guards other edits to it', () => {
    expect(guarded(peerRule(t, '*1', { 'endpoint-port': '13232' }, 'set'))).toBe(true);
    expect(guarded(peerRule(t, '*1', { 'allowed-address': '10.99.0.0/24' }, 'set'))).toBe(true);
  });
  it('refuses another peer claiming the manager address, new or edited', () => {
    expect(refused(peerRule(t, null, { interface: 'wg-mgmt', 'allowed-address': '0.0.0.0/0' }, 'add'))).toBe(true);
    expect(refused(peerRule(t, '*2', { 'allowed-address': '10.99.0.0/24' }, 'set'))).toBe(true);
  });
  it('guards harmless changes on the tunnel and ignores other interfaces', () => {
    expect(guarded(peerRule(t, null, { interface: 'wg-mgmt', 'allowed-address': '10.99.0.60/32' }, 'add'))).toBe(true);
    expect(guarded(peerRule(t, '*2', { comment: 'x' }, 'set'))).toBe(true);
    expect(peerRule(t, '*2', undefined, 'remove')).toBeNull();
    expect(peerRule(t, '*3', { 'allowed-address': '10.99.0.1/32' }, 'set')).toBeNull();
    expect(peerRule(t, null, { interface: 'wg-site', 'allowed-address': '0.0.0.0/0' }, 'add')).toBeNull();
  });
  it('only guards the carrying peer when the manager address is unknown', () => {
    const u = managementTunnel(base({ managerIp: null, addresses: [{ address: '10.99.0.7/24', interface: 'wg-mgmt', disabled: 'false' }] }));
    expect(guarded(peerRule(u, '*1', undefined, 'remove'))).toBe(true);
    expect(guarded(peerRule(u, '*1', { disabled: 'yes' }, 'set'))).toBe(true);
  });
});

