import { buildTopology, findAmbiguousIdentifiers, type LinkRow, type TopoDevice } from '../buildTopology';

let nextId = 1;
function link(over: Partial<LinkRow>): LinkRow {
  return {
    id: nextId++,
    from_device_id: null, from_interface: null, to_interface: null, to_device_id: null,
    neighbor_address: null, neighbor_identity: null, neighbor_platform: null, neighbor_mac: null,
    stp_role: null, stp_state: null, bridge_name: null, neighbor_caps: null,
    link_type: 'mndp', discovered_by: null, from_device_name: null, to_device_name: null,
    ...over,
  };
}
const dev = (id: number, name: string, ip: string, extra: string[] = []): TopoDevice => ({
  id, name, ip_address: ip,
  ip_addresses_jsonb: extra.map((a) => ({ address: a })),
});

beforeEach(() => { nextId = 1; });

/**
 * The network from issue #90: three physically disconnected segments, each with a
 * VLAN named `management_vlan`, each reusing 10.2.0.0/24. gamma (segment 2) and
 * delta (segment 3) both answer on 10.2.0.1. Nothing in segment 1 can reach
 * segment 3, so no link between alpha and delta may ever appear.
 */
function segmentedFleet() {
  const devices = [
    dev(1, 'alpha',  '192.168.1.10', ['10.2.0.1']),
    dev(2, 'beta',   '192.168.1.11', ['10.2.0.2']),
    dev(3, 'gamma',  '192.168.1.12', ['10.2.0.1']),
    dev(4, 'delta',  '192.168.1.13', ['10.2.0.1']),
    dev(5, 'lambda', '192.168.1.14', ['10.2.0.2']),
  ];
  return devices;
}

describe('findAmbiguousIdentifiers', () => {
  it('flags an address claimed by more than one managed device', () => {
    const amb = findAmbiguousIdentifiers(segmentedFleet(), []);
    expect(amb.addresses.has('10.2.0.1')).toBe(true);  // alpha, gamma, delta
    expect(amb.addresses.has('10.2.0.2')).toBe(true);  // beta, lambda
    expect(amb.addresses.has('192.168.1.10')).toBe(false);
  });

  it('flags an address whose sightings disagree about who answers to it', () => {
    const amb = findAmbiguousIdentifiers([], [
      link({ from_device_id: 1, neighbor_address: '10.9.9.1', neighbor_identity: 'gamma' }),
      link({ from_device_id: 4, neighbor_address: '10.9.9.1', neighbor_identity: 'delta' }),
    ]);
    expect(amb.addresses.has('10.9.9.1')).toBe(true);
  });

  /**
   * Real data from a CRS510: a switch assigns a MAC per port, so the same device is
   * reported as ...74:0E by two neighbours and ...74:0F by a third. All three agree
   * on the identity, so this is one device with several uplinks — not a conflict.
   * An earlier version treated MAC divergence as ambiguity and refused to resolve
   * ordinary multi-port hardware.
   */
  it('does not flag a multi-port device reported under several port MACs', () => {
    const amb = findAmbiguousIdentifiers([dev(1, '2GT-NW-100G', '192.168.0.40')], [
      link({ from_device_id: 8, neighbor_address: '192.168.0.40', neighbor_mac: 'F4:1E:57:51:74:0E', neighbor_identity: '2GT-NW-100G', link_type: 'cdp' }),
      link({ from_device_id: 7, neighbor_address: '192.168.0.40', neighbor_mac: 'F4:1E:57:51:74:0F', neighbor_identity: '2GT-NW-100G', link_type: 'lldp' }),
      link({ from_device_id: 2, neighbor_address: '192.168.0.40', neighbor_mac: 'F4:1E:57:51:74:0E', neighbor_identity: '2GT-NW-100G', link_type: 'cdp' }),
    ]);
    expect(amb.addresses.has('192.168.0.40')).toBe(false);
  });

  it('flags an identity claimed by two managed devices', () => {
    const amb = findAmbiguousIdentifiers(
      [dev(1, 'MikroTik', '10.0.0.1'), dev(2, 'MikroTik', '10.0.0.2')],
      []
    );
    expect(amb.identities.has('mikrotik')).toBe(true);
  });
});

describe('buildTopology — disconnected segments reusing addresses (#90)', () => {
  it('does not resolve a neighbour to a device in another segment', () => {
    // alpha sees its own segment's 10.2.0.1 over MNDP with no MAC available.
    const graph = buildTopology(segmentedFleet(), [
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_address: '10.2.0.1' }),
    ], []);

    const resolved = graph.links.filter((l) => l.to_device_id != null);
    expect(resolved).toHaveLength(0);   // never silently becomes gamma or delta
  });

  it('does not join two segments into one shared segment', () => {
    const links = [
      // alpha's trunk port sees two unresolved neighbours in segment 1
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_address: '10.2.0.1' }),
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_address: '10.2.0.2' }),
      // delta's trunk port sees two unresolved neighbours in segment 3,
      // which happen to carry the very same addresses
      link({ from_device_id: 4, from_interface: 'ether1', neighbor_address: '10.2.0.1' }),
      link({ from_device_id: 4, from_interface: 'ether1', neighbor_address: '10.2.0.2' }),
    ];
    const graph = buildTopology(segmentedFleet(), links, []);

    const segments = graph.externalNodes.filter((n) => n.caps === 'segment');
    expect(segments).toHaveLength(2);   // one per port group, NOT merged into one

    // No segment may be attached to both alpha and delta.
    for (const seg of segments) {
      const attached = graph.segConns.filter((c) => c.dst === seg.id).map((c) => c.src);
      expect(attached).not.toEqual(expect.arrayContaining(['1', '4']));
    }
  });

  it('keeps same-addressed neighbours in different segments as separate nodes', () => {
    const graph = buildTopology(segmentedFleet(), [
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_address: '10.2.0.9', neighbor_identity: 'switch' }),
      link({ from_device_id: 4, from_interface: 'ether1', neighbor_address: '10.2.0.9', neighbor_identity: 'switch' }),
    ], []);
    // Both report the same address with no MAC; the fleet proves 10.2.0.x is reused,
    // so they must not collapse into a single external node bridging the segments.
    const ext = graph.externalNodes.filter((n) => n.caps !== 'segment');
    expect(ext).toHaveLength(2);
  });

  it('still merges genuinely identical neighbours when a MAC proves identity', () => {
    const links = [
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_mac: 'AA:BB:CC:00:00:01', neighbor_address: '10.2.0.1' }),
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_mac: 'AA:BB:CC:00:00:02', neighbor_address: '10.2.0.2' }),
      link({ from_device_id: 2, from_interface: 'ether5', neighbor_mac: 'AA:BB:CC:00:00:01', neighbor_address: '10.2.0.1' }),
      link({ from_device_id: 2, from_interface: 'ether5', neighbor_mac: 'AA:BB:CC:00:00:02', neighbor_address: '10.2.0.2' }),
    ];
    const graph = buildTopology(segmentedFleet(), links, []);
    const segments = graph.externalNodes.filter((n) => n.caps === 'segment');
    // Same MACs on both ports: this really is one shared segment.
    expect(segments).toHaveLength(1);
    const attached = graph.segConns.filter((c) => c.dst === segments[0].id).map((c) => c.src).sort();
    expect(attached).toEqual(expect.arrayContaining(['1', '2']));
  });

  it('reports which identifiers it distrusted', () => {
    const graph = buildTopology(segmentedFleet(), [], []);
    expect(graph.ambiguous.addresses.sort()).toEqual(['10.2.0.1', '10.2.0.2']);
  });
});

describe('buildTopology — behaviour preserved for unambiguous fleets', () => {
  const flat = [dev(1, 'sw1', '192.168.0.1'), dev(2, 'sw2', '192.168.0.2')];

  it('resolves a neighbour IP to a managed device', () => {
    const graph = buildTopology(flat, [
      link({ from_device_id: 1, from_interface: 'ether1', neighbor_address: '192.168.0.2' }),
    ], []);
    expect(graph.links[0].to_device_id).toBe(2);
    expect(graph.links[0].to_device_name).toBe('sw2');
  });

  it('prefers LLDP over MNDP for the same neighbour', () => {
    const graph = buildTopology(flat, [
      link({ from_device_id: 1, from_interface: 'e1', to_device_id: 2, link_type: 'mndp' }),
      link({ from_device_id: 1, from_interface: 'e1', to_device_id: 2, link_type: 'lldp' }),
    ], []);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].link_type).toBe('lldp');
  });

  it('suppresses a CDP link to a neighbour LLDP already describes', () => {
    // Coverage is per-neighbour: sw2 is described precisely by LLDP from sw1, so
    // sw3's noisier CDP sighting of sw2 adds nothing and is dropped.
    const three = [...flat, dev(3, 'sw3', '192.168.0.3')];
    const graph = buildTopology(three, [
      link({ from_device_id: 1, from_interface: 'e1', to_device_id: 2, link_type: 'lldp' }),
      link({ from_device_id: 3, from_interface: 'e2', to_device_id: 2, link_type: 'cdp' }),
    ], []);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].link_type).toBe('lldp');
  });

  it('keeps a CDP link when LLDP does not describe that neighbour at all', () => {
    // Asymmetric discovery — the case the reporting installation is in. sw2 has no
    // LLDP view of sw1, so dropping its CDP link would erase a real adjacency.
    const graph = buildTopology(flat, [
      link({ from_device_id: 1, from_interface: 'e1', to_device_id: 2, link_type: 'lldp' }),
      link({ from_device_id: 2, from_interface: 'e9', to_device_id: 1, link_type: 'cdp' }),
    ], []);
    expect(graph.links).toHaveLength(2);
  });

  it('merges a bidirectional LLDP pair into one canonical link', () => {
    const graph = buildTopology(flat, [
      link({ from_device_id: 2, from_interface: 'e9', to_device_id: 1, link_type: 'lldp' }),
      link({ from_device_id: 1, from_interface: 'e1', to_device_id: 2, link_type: 'lldp' }),
    ], []);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].from_device_id).toBe(1);
    expect(graph.links[0].to_interface).toBe('e9');
  });

  it('passes manual links through as synthetic rows', () => {
    const graph = buildTopology(flat, [], [
      { id: 7, from_device_id: 1, to_device_id: 2, label: 'fibre', from_name: 'sw1', to_name: 'sw2' },
    ]);
    const manual = graph.links.find((l) => l.link_type === 'manual');
    expect(manual?.id).toBe(-7);
    expect(manual?.from_interface).toBe('fibre');
  });

  it('does not link a device to itself through its own address', () => {
    const graph = buildTopology(flat, [
      link({ from_device_id: 1, from_interface: 'e1', neighbor_address: '192.168.0.1' }),
    ], []);
    expect(graph.links[0].to_device_id).toBeNull();
  });
});

/**
 * Issue #95. Two managed devices connected by a trunk port. LLDP across a trunk
 * carries no IP, so address matching has nothing to work with — but it does carry
 * the peer's port MAC. Without MAC resolution both devices were drawn twice: once
 * as themselves and once as an external node.
 */
describe('buildTopology — neighbours identified only by MAC (#95)', () => {
  const devices = [
    dev(12, 'legacy-core-rt-001', '10.99.0.1'),
    dev(13, 'legacy-core-sw-001', '10.99.0.2'),
  ];
  // Trunk-port MACs, which differ from the management-VLAN MACs the devices answer on.
  const macs = [
    { device_id: 12, mac_address: '04:F4:1C:9F:3D:A9' },
    { device_id: 13, mac_address: '04:F4:1C:36:B5:E9' },
  ];
  const trunkLinks = () => [
    link({
      from_device_id: 12, from_interface: 'trunk1', link_type: 'lldp',
      neighbor_mac: '04:F4:1C:36:B5:E9', neighbor_identity: 'legacy-core-sw-001',
      neighbor_address: null, from_device_name: 'legacy-core-rt-001',
    }),
    link({
      from_device_id: 13, from_interface: 'sfp-sfpplus2', link_type: 'lldp',
      neighbor_mac: '04:F4:1C:9F:3D:A9', neighbor_identity: 'legacy-core-rt-001',
      neighbor_address: null, from_device_name: 'legacy-core-sw-001',
    }),
  ];

  it('resolves both directions to the managed devices', () => {
    const graph = buildTopology(devices, trunkLinks(), [], macs);
    for (const l of graph.links) expect(l.to_device_id).not.toBeNull();
  });

  it('draws no external node duplicating a managed device', () => {
    const graph = buildTopology(devices, trunkLinks(), [], macs);
    expect(graph.externalNodes.filter((n) => n.caps !== 'segment')).toHaveLength(0);
  });

  it('collapses the bidirectional pair into one link', () => {
    const graph = buildTopology(devices, trunkLinks(), [], macs);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].from_device_id).toBe(12);
    expect(graph.links[0].to_device_id).toBe(13);
  });

  it('still produces external nodes for genuinely unmanaged neighbours', () => {
    const graph = buildTopology(devices, [
      link({ from_device_id: 12, from_interface: 'ether5', link_type: 'lldp',
             neighbor_mac: 'FF:FF:FF:00:00:01', neighbor_identity: 'some-switch' }),
    ], [], macs);
    expect(graph.externalNodes.filter((n) => n.caps !== 'segment')).toHaveLength(1);
  });

  it('never resolves a device to itself through its own MAC', () => {
    const graph = buildTopology(devices, [
      link({ from_device_id: 12, from_interface: 'ether1', link_type: 'lldp',
             neighbor_mac: '04:F4:1C:9F:3D:A9' }),
    ], [], macs);
    expect(graph.links[0].to_device_id).toBeNull();
  });

  it('works without a MAC index, as before', () => {
    const graph = buildTopology(devices, trunkLinks(), []);
    expect(graph.links.every((l) => l.to_device_id === null)).toBe(true);
  });
});
