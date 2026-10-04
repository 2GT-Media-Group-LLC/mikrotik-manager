import { managementTunnel, prefixContains, allowedCovers, tunnelWriteRule, type TunnelState } from '../wireguardPath';

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

describe('tunnelWriteRule (#205)', () => {
  const t = managementTunnel(base({ addresses: [{ address: '10.99.0.7/24', interface: 'wg-mgmt', disabled: 'false' }] }));
  const refused = (v: ReturnType<typeof tunnelWriteRule>) => !!v && 'refuse' in v;

  it('refuses any write to the tunnel interface, by id or name', () => {
    expect(refused(tunnelWriteRule(t, { ifaceIdOrName: '*A' }))).toBe(true);
    expect(refused(tunnelWriteRule(t, { ifaceIdOrName: 'wg-mgmt' }))).toBe(true);
    expect(tunnelWriteRule(t, { ifaceIdOrName: 'wg-site' })).toBeNull();
  });
  it('refuses any write to a peer on the tunnel, enabled or not', () => {
    expect(refused(tunnelWriteRule(t, { peerId: '*1' }))).toBe(true);
    expect(refused(tunnelWriteRule(t, { peerId: '*2' }))).toBe(true);
    expect(refused(tunnelWriteRule(t, { peerId: '*4' }))).toBe(true); // disabled, still on the tunnel
    expect(tunnelWriteRule(t, { peerId: '*3' })).toBeNull();
  });
  it('refuses adding a peer to the tunnel or moving one onto it', () => {
    expect(refused(tunnelWriteRule(t, { targetIface: 'wg-mgmt' }))).toBe(true);
    expect(refused(tunnelWriteRule(t, { peerId: '*3', targetIface: 'wg-mgmt' }))).toBe(true);
    expect(tunnelWriteRule(t, { targetIface: 'wg-site' })).toBeNull();
  });
  it('allows everything when the manager isn\u2019t on a tunnel', () => {
    const none = managementTunnel(base({ wgInterfaces: [] }));
    expect(tunnelWriteRule(none, { ifaceIdOrName: '*A', peerId: '*1', targetIface: 'wg-mgmt' })).toBeNull();
  });
});
