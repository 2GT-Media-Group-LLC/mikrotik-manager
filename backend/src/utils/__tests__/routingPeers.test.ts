import { routingPeersFrom } from '../routingPeers';

// Captured from a lab iBGP + OSPF pair on RouterOS 7.24.5 (CRS309 and CCR2216).
const conn = { '.id': '*1', name: 'mtm-lab', instance: 'mtm-lab', 'remote.address': '192.168.0.39', 'remote.as': '65000', 'local.default-address': '192.168.0.51', 'local.role': 'ibgp', 'routing-table': 'main', as: '65000', inactive: 'false' };
const session = { '.id': '*2800001', name: 'mtm-lab-1', instance: 'mtm-lab', 'remote.address': '192.168.0.39', 'remote.as': '65000', 'remote.id': '192.168.0.39', 'local.role': 'ibgp', uptime: '52s290ms', 'prefix-count': '0', established: 'true' };
const neighbor = { '.id': '*F3FDDC00', instance: 'mtm-lab', area: 'mtm-lab-bb', interface: 'bridge', address: '192.168.0.39', 'router-id': '192.168.0.39', state: 'Full', adjacency: '23s', dynamic: 'true' };

describe('routingPeersFrom', () => {
  it('reads an established BGP session and a Full OSPF neighbour', () => {
    const peers = routingPeersFrom({ bgpConnections: [conn], bgpSessions: [session], ospfNeighbors: [neighbor] });
    expect(peers).toEqual([
      { protocol: 'bgp', key: 'mtm-lab', name: 'mtm-lab', remoteAddress: '192.168.0.39', remoteAs: '65000', remoteId: '192.168.0.39',
        instance: 'mtm-lab', detail: 'ibgp', state: 'established', up: true, disabled: false, uptime: '52s290ms', prefixCount: 0 },
      { protocol: 'ospf', key: 'mtm-lab|192.168.0.39', name: '192.168.0.39', remoteAddress: '192.168.0.39', remoteAs: null,
        remoteId: '192.168.0.39', instance: 'mtm-lab', detail: 'mtm-lab-bb · bridge', state: 'Full', up: true, disabled: false,
        uptime: '23s', prefixCount: null },
    ]);
  });

  it('a configured connection with no session is down', () => {
    const [p] = routingPeersFrom({ bgpConnections: [conn], bgpSessions: [], ospfNeighbors: [] });
    expect(p).toMatchObject({ state: 'idle', up: false, uptime: null, prefixCount: null });
  });

  it('a session that is not established is connecting, not up', () => {
    const [p] = routingPeersFrom({ bgpConnections: [conn], bgpSessions: [{ ...session, established: 'false' }], ospfNeighbors: [] });
    expect(p).toMatchObject({ state: 'connecting', up: false });
  });

  it('a disabled connection is disabled, not down', () => {
    const [p] = routingPeersFrom({ bgpConnections: [{ ...conn, disabled: 'true' }], bgpSessions: [], ospfNeighbors: [] });
    expect(p).toMatchObject({ state: 'disabled', up: false, disabled: true });
  });

  it('does not match a session for a connection whose name is a prefix of another', () => {
    const other = { ...conn, name: 'mtm', 'remote.address': '10.9.9.9' };
    const [p] = routingPeersFrom({ bgpConnections: [other], bgpSessions: [session], ospfNeighbors: [] });
    expect(p.up).toBe(false);
  });

  it('reads RouterOS 6 BGP peers, which carry their own state', () => {
    const [p] = routingPeersFrom({
      bgpConnections: [{ name: 'isp', 'remote-address': '203.0.113.1', 'remote-as': '64512', state: 'established', uptime: '3d2h', 'prefix-count': '850000' }],
      bgpSessions: [], ospfNeighbors: [],
    });
    expect(p).toMatchObject({ key: 'isp', state: 'established', up: true, remoteAs: '64512', prefixCount: 850000 });
  });

  it('treats 2-Way as up (normal between non-DR routers) and Init as down', () => {
    const peers = routingPeersFrom({ bgpConnections: [], bgpSessions: [], ospfNeighbors: [{ ...neighbor, state: '2-Way' }, { ...neighbor, 'router-id': '10.0.0.9', state: 'Init' }] });
    expect(peers.map((p) => p.up)).toEqual([true, false]);
  });
});
