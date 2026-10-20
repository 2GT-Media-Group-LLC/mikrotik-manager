import { analyzeChange } from '../analyzeChange';
import { resolveManagementPath, routeFor, type DeviceSnapshot } from '../pathModel';
import type { GuardDevice } from '../ChangeGuard';
import { readCoveringRoutes } from '../targetedReads';

const device: GuardDevice = {
  id: 1, name: 'crs510', ip_address: '10.9.0.2', api_port: 8728,
  api_username: 'admin', api_password_encrypted: 'x',
};

/** Management address on vlan-mgmt, which sits in VRF "mgmt"; the manager is off-subnet. */
function vrfSnapshot(over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    addresses: [{ '.id': '*1', address: '10.9.0.2/24', interface: 'vlan-mgmt', disabled: 'false' }],
    interfaces: [
      { name: 'bridge', type: 'bridge' },
      { name: 'vlan-mgmt', type: 'vlan' },
      { name: 'sfp28-1', type: 'ether' },
    ],
    vlanInterfaces: [{ name: 'vlan-mgmt', 'vlan-id': '90', interface: 'bridge' }],
    bridges: [{ name: 'bridge', 'vlan-filtering': 'true', pvid: '1' }],
    bridgePorts: [{ interface: 'sfp28-1', bridge: 'bridge', pvid: '1' }],
    bridgeVlans: [
      { bridge: 'bridge', 'vlan-ids': '90', tagged: 'bridge,sfp28-1', untagged: '',
        'current-tagged': 'bridge,sfp28-1', 'current-untagged': '' },
    ],
    bonds: [],
    routes: [
      { '.id': '*M', 'dst-address': '0.0.0.0/0', gateway: '172.16.0.1', 'routing-table': 'main', active: 'true' },
      { '.id': '*V', 'dst-address': '0.0.0.0/0', gateway: '10.9.0.1', 'routing-table': 'mgmt', active: 'true' },
      { '.id': '*C', 'dst-address': '10.9.0.0/24', gateway: 'vlan-mgmt', 'routing-table': 'mgmt', active: 'true' },
    ],
    arp: [{ address: '10.9.0.1', 'mac-address': 'AA:BB:CC:00:00:01', interface: 'vlan-mgmt' }],
    bridgeHosts: [{ 'mac-address': 'AA:BB:CC:00:00:01', 'on-interface': 'sfp28-1', vid: '90', local: 'false' }],
    services: [{ '.id': '*1', name: 'api', port: '8728', vrf: 'mgmt', disabled: 'false' }],
    vrfs: [{ name: 'mgmt', interfaces: 'vlan-mgmt' }],
    vrfsRead: true,
    firewallFilter: [],
    mgmtConnections: [],
    ...over,
  };
}

describe('management routing table', () => {
  it('resolves the table from the API service vrf', () => {
    const p = resolveManagementPath(vrfSnapshot(), device);
    expect(p.mgmtTable).toBe('mgmt');
    expect(p.mgmtTableCertain).toBe(true);
    expect(p.managerGateway).toBe('10.9.0.1');
  });

  it('falls back to the interface VRF when the service vrf is the default', () => {
    const snap = vrfSnapshot({ services: [{ '.id': '*1', name: 'api', port: '8728', disabled: 'false' }] });
    expect(resolveManagementPath(snap, device).mgmtTable).toBe('mgmt');
  });

  it('is unconfirmed when /ip/vrf could not be read', () => {
    const p = resolveManagementPath(vrfSnapshot({ vrfs: [], vrfsRead: false }), device);
    expect(p.mgmtTable).toBe('mgmt');
    expect(p.mgmtTableCertain).toBe(false);
  });

  it('routeFor only considers the requested table', () => {
    const snap = vrfSnapshot();
    expect(routeFor(snap, '8.8.8.8', 'mgmt')?.['.id']).toBe('*V');
    expect(routeFor(snap, '8.8.8.8')?.['.id']).toBe('*M');
  });
});

describe('Change Guard with a management VRF', () => {
  it('removing the main-table default route does not affect management', () => {
    const v = analyzeChange(vrfSnapshot(), device, { kind: 'route.remove', routeId: '*M' });
    expect(v.severity).toBe('safe');
  });

  it('removing the VRF default route is critical', () => {
    const v = analyzeChange(vrfSnapshot(), device, { kind: 'route.remove', routeId: '*V' });
    expect(v.severity).toBe('critical');
  });

  it('a route added in another table does not count as re-pointing management', () => {
    const v = analyzeChange(vrfSnapshot(), device, {
      kind: 'route.add', dstAddress: '0.0.0.0/0', gateway: '172.16.0.99', distance: 1, table: 'main',
    });
    expect(v.severity).toBe('safe');
  });

  it('a lower-distance default route added to the management table is flagged', () => {
    const v = analyzeChange(vrfSnapshot(), device, {
      kind: 'route.add', dstAddress: '0.0.0.0/0', gateway: '10.9.0.77', distance: 1, table: 'mgmt',
    });
    expect(v.severity).not.toBe('safe');
  });
});

describe('main-table device is unchanged', () => {
  const mainSnap = (): DeviceSnapshot => vrfSnapshot({
    routes: [
      { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: '10.9.0.1', active: 'true' },
      { '.id': '*C', 'dst-address': '10.9.0.0/24', gateway: 'vlan-mgmt', active: 'true' },
    ],
    services: [{ '.id': '*1', name: 'api', port: '8728', disabled: 'false' }],
    vrfs: [],
  });

  it('uses main and flags default route removal', () => {
    expect(resolveManagementPath(mainSnap(), device).mgmtTable).toBe('main');
    expect(analyzeChange(mainSnap(), device, { kind: 'route.remove', routeId: '*A' }).severity).toBe('critical');
  });
});

// Rows as the live CRS510 (RouterOS 7.24.5) returned them: a "mgmt" table and VRF
// interface exist, but the routes sit in `main` with vrf-interface set, and the
// API services are bound to vrf=main.
describe('live CRS510 shape', () => {
  const live = (): DeviceSnapshot => ({
    addresses: [{ '.id': '*1', address: '10.2.0.9/24', interface: 'ether1', disabled: 'false' }],
    interfaces: [{ name: 'ether1', type: 'ether' }, { name: 'mgmt', type: 'vrf' }],
    vlanInterfaces: [], bridges: [{ name: 'bridge' }], bridgePorts: [], bridgeVlans: [], bonds: [],
    routes: [
      { '.id': '*D', 'dst-address': '0.0.0.0/0', gateway: '10.2.0.1', 'routing-table': 'main', 'vrf-interface': 'ether1', distance: '1', active: 'true', dynamic: 'true' },
      { '.id': '*C', 'dst-address': '10.2.0.0/24', gateway: 'ether1', 'routing-table': 'main', distance: '0', active: 'true', dynamic: 'true' },
    ],
    arp: [{ address: '10.2.0.1', 'mac-address': 'AA:BB:CC:00:00:02', interface: 'ether1' }],
    bridgeHosts: [],
    services: [{ '.id': '*8', name: 'api-ssl', port: '8729', vrf: 'main', disabled: 'false' }],
    vrfs: [], vrfsRead: false,
    firewallFilter: [], mgmtConnections: [],
  });
  const dev: GuardDevice = { ...device, ip_address: '10.2.0.9', api_port: 8729 };

  it('resolves to main and keeps default-route removal critical', () => {
    const p = resolveManagementPath(live(), dev);
    expect(p.mgmtTable).toBe('main');
    expect(p.mgmtTableCertain).toBe(true);
    expect(p.managerGateway).toBe('10.2.0.1');
    expect(analyzeChange(live(), dev, { kind: 'route.remove', routeId: '*D' }).severity).toBe('critical');
  });
});

// The targeted read (#313) asks for routes covering the manager's address in
// every table; the table is chosen afterwards from what comes back.
describe('targeted route read across tables', () => {
  const table = vrfSnapshot().routes;
  const router = {
    executeMany: async (reads: { queries?: string[] }[]) => reads.map((r) => {
      const dst = (r.queries?.[0] || '').replace('?dst-address=', '');
      return { rows: table.filter((x) => x['dst-address'] === dst) };
    }),
  };

  it('returns covering routes from every table and the VRF one wins for a mgmt-table lookup', async () => {
    const routes = await readCoveringRoutes(router, '8.8.8.8');
    expect(routes.map((r) => r['.id']).sort()).toEqual(['*M', '*V']);
    const snap = vrfSnapshot({ routes });
    expect(routeFor(snap, '8.8.8.8', 'mgmt')?.['.id']).toBe('*V');
    expect(routeFor(snap, '8.8.8.8')?.['.id']).toBe('*M');
  });

  it('with an unknown manager address only the default routes are read, still from all tables', async () => {
    const routes = await readCoveringRoutes(router, null);
    const snap = vrfSnapshot({ routes });
    expect(resolveManagementPath(snap, device).managerGateway).toBe('10.9.0.1');
  });
});
