import {
  resolveStpUpstreams, upstreamByDevice, type StpBridge, type StpLink,
} from '../stpUpstream';

/**
 * The live four-device fleet, as actually reported. Two properties make it a
 * good fixture and neither is contrived:
 *
 *  - a single root port resolves to three managed neighbours (LLDP ambiguity)
 *  - one device sits under a root nobody manages (priority 0x2000)
 */
const HUNDRED_G = 1, WAP = 2, BIGSWITCH = 7, TEST = 8;

const bridges: StpBridge[] = [
  { device_id: WAP, bridge_name: 'bridge', bridge_id: '0x8000.D0:EA:11:0A:DE:77',
    root_bridge: true, root_bridge_id: '0x8000.D0:EA:11:0A:DE:77', root_port: 'none', root_path_cost: 0 },
  { device_id: HUNDRED_G, bridge_name: 'bridge', bridge_id: '0x8000.F4:1E:57:51:74:1E',
    root_bridge: true, root_bridge_id: '0x8000.F4:1E:57:51:74:1E', root_port: 'none', root_path_cost: 0 },
  { device_id: BIGSWITCH, bridge_name: 'bridge', bridge_id: '0x8000.F4:1E:57:BD:F0:2A',
    root_bridge: false, root_bridge_id: '0x8000.F4:1E:57:51:74:1E', root_port: 'sfp28-2', root_path_cost: 800 },
  { device_id: TEST, bridge_name: 'bridge', bridge_id: '0x8000.C4:AD:34:D5:BC:B7',
    root_bridge: false, root_bridge_id: '0x2000.70:A7:41:EF:8F:FB', root_port: 'ether1', root_path_cost: 41010 },
];

// Every root port resolves to three neighbours. This is the problem, not a quirk.
const links: StpLink[] = [
  { from_device_id: BIGSWITCH, from_interface: 'sfp28-2', to_device_id: WAP },
  { from_device_id: BIGSWITCH, from_interface: 'sfp28-2', to_device_id: HUNDRED_G },
  { from_device_id: BIGSWITCH, from_interface: 'sfp28-2', to_device_id: TEST },
  { from_device_id: TEST, from_interface: 'ether1', to_device_id: WAP },
  { from_device_id: TEST, from_interface: 'ether1', to_device_id: HUNDRED_G },
  { from_device_id: TEST, from_interface: 'ether1', to_device_id: BIGSWITCH },
  { from_device_id: TEST, from_interface: 'ether1', to_device_id: null },
];

const verdictFor = (vs: ReturnType<typeof resolveStpUpstreams>, id: number) =>
  vs.find((v) => v.deviceId === id)!;

describe('resolveStpUpstreams — against the real fleet', () => {
  const verdicts = resolveStpUpstreams(bridges, links);

  // The whole point: three candidates in, one answer out.
  it('picks the single in-domain, closer-to-root neighbour', () => {
    const v = verdictFor(verdicts, BIGSWITCH);
    expect(v.confidence).toBe('resolved');
    expect(v.upstreamDeviceId).toBe(HUNDRED_G);
  });

  /**
   * This device's root is 0x2000.70:… which no managed device owns. Its real
   * upstream is equipment nobody added, so the honest answer is "not ours" —
   * not the nearest plausible switch.
   */
  it('reports an unmanaged root rather than guessing a local device', () => {
    const v = verdictFor(verdicts, TEST);
    expect(v.confidence).toBe('external-root');
    expect(v.upstreamDeviceId).toBeNull();
    expect(v.rootBridgeId).toBe('0x2000.70:A7:41:EF:8F:FB');
  });

  it('gives a root bridge no upstream', () => {
    for (const id of [WAP, HUNDRED_G]) {
      const v = verdictFor(verdicts, id);
      expect(v.confidence).toBe('is-root');
      expect(v.upstreamDeviceId).toBeNull();
    }
  });
});

describe('resolveStpUpstreams — declining to guess', () => {
  const base: StpBridge = {
    device_id: 1, bridge_name: 'bridge', bridge_id: '0x8000.AA',
    root_bridge: true, root_bridge_id: '0x8000.AA', root_port: 'none', root_path_cost: 0,
  };

  // Two neighbours both in-domain and both nearer the root: genuinely undecidable
  // from this data, so it must not pick one.
  it('declines when several candidates qualify', () => {
    const bs: StpBridge[] = [
      base,
      { ...base, device_id: 2, bridge_id: '0x8000.BB', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 10 },
      { ...base, device_id: 3, bridge_id: '0x8000.CC', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 10 },
      { ...base, device_id: 4, bridge_id: '0x8000.DD', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e9', root_path_cost: 50 },
    ];
    const ls: StpLink[] = [
      { from_device_id: 4, from_interface: 'e9', to_device_id: 2 },
      { from_device_id: 4, from_interface: 'e9', to_device_id: 3 },
    ];
    expect(verdictFor(resolveStpUpstreams(bs, ls), 4).confidence).toBe('ambiguous');
  });

  // A neighbour further from the root is downstream of us, not upstream.
  it('ignores neighbours that are further from the root', () => {
    const bs: StpBridge[] = [
      base,
      { ...base, device_id: 2, bridge_id: '0x8000.BB', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 100 },
      { ...base, device_id: 3, bridge_id: '0x8000.CC', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 200 },
    ];
    const ls: StpLink[] = [
      { from_device_id: 2, from_interface: 'e1', to_device_id: 1 },
      { from_device_id: 2, from_interface: 'e1', to_device_id: 3 },
    ];
    const v = verdictFor(resolveStpUpstreams(bs, ls), 2);
    expect(v.confidence).toBe('resolved');
    expect(v.upstreamDeviceId).toBe(1);
  });

  // A neighbour on a different tree shares the wire but is not our upstream.
  it('ignores neighbours in another STP domain', () => {
    const bs: StpBridge[] = [
      base,
      { ...base, device_id: 2, bridge_id: '0x8000.BB', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 100 },
      { ...base, device_id: 3, bridge_id: '0x8000.CC', root_bridge: true,
        root_bridge_id: '0x8000.CC', root_port: 'none', root_path_cost: 0 },
    ];
    const ls: StpLink[] = [
      { from_device_id: 2, from_interface: 'e1', to_device_id: 1 },
      { from_device_id: 2, from_interface: 'e1', to_device_id: 3 },
    ];
    expect(verdictFor(resolveStpUpstreams(bs, ls), 2).upstreamDeviceId).toBe(1);
  });

  it('is unknown without a root port or a cost', () => {
    const bs: StpBridge[] = [
      { ...base, device_id: 5, root_bridge: false, root_port: null, root_path_cost: 10 },
      { ...base, device_id: 6, root_bridge: false, root_port: 'e1', root_path_cost: null },
      { ...base, device_id: 7, root_bridge: false, root_port: 'none', root_path_cost: 10 },
    ];
    for (const id of [5, 6, 7]) {
      expect(verdictFor(resolveStpUpstreams(bs, []), id).confidence).toBe('unknown');
    }
  });

  it('compares bridge ids case-insensitively', () => {
    const bs: StpBridge[] = [
      { ...base, bridge_id: '0x8000.aa', root_bridge_id: '0x8000.aa' },
      { ...base, device_id: 2, bridge_id: '0x8000.BB', root_bridge: false,
        root_bridge_id: '0X8000.AA', root_port: 'e1', root_path_cost: 100 },
    ];
    const ls: StpLink[] = [{ from_device_id: 2, from_interface: 'e1', to_device_id: 1 }];
    expect(verdictFor(resolveStpUpstreams(bs, ls), 2).upstreamDeviceId).toBe(1);
  });
});

describe('upstreamByDevice', () => {
  it('keeps only confident answers', () => {
    const map = upstreamByDevice(resolveStpUpstreams(bridges, links), bridges);
    expect(map.get(BIGSWITCH)).toBe(HUNDRED_G);
    expect(map.has(TEST)).toBe(false);      // external root
    expect(map.has(HUNDRED_G)).toBe(false); // is root
  });

  // A device bridging two segments sits at a different depth in each; the
  // lowest-cost bridge is the one describing how the device itself is reached.
  it('prefers the lowest-cost bridge when a device has several', () => {
    const bs: StpBridge[] = [
      { device_id: 1, bridge_name: 'a', bridge_id: '0x8000.AA', root_bridge: true,
        root_bridge_id: '0x8000.AA', root_port: 'none', root_path_cost: 0 },
      { device_id: 3, bridge_name: 'a', bridge_id: '0x8000.CC', root_bridge: true,
        root_bridge_id: '0x8000.CC', root_port: 'none', root_path_cost: 0 },
      { device_id: 2, bridge_name: 'far', bridge_id: '0x8000.B1', root_bridge: false,
        root_bridge_id: '0x8000.CC', root_port: 'e2', root_path_cost: 900 },
      { device_id: 2, bridge_name: 'near', bridge_id: '0x8000.B2', root_bridge: false,
        root_bridge_id: '0x8000.AA', root_port: 'e1', root_path_cost: 10 },
    ];
    const ls: StpLink[] = [
      { from_device_id: 2, from_interface: 'e1', to_device_id: 1 },
      { from_device_id: 2, from_interface: 'e2', to_device_id: 3 },
    ];
    expect(upstreamByDevice(resolveStpUpstreams(bs, ls), bs).get(2)).toBe(1);
  });
});

// Outside review J6.
describe('STP upstream: bonds and unmanaged roots', () => {
  const ROOT_EXT = '0x2000.70:A7:41:EF:8F:FB'; // a root bridge nobody here manages

  it('finds a managed upstream on the way to an unmanaged root', () => {
    const bs: StpBridge[] = [
      { device_id: 10, bridge_name: 'bridge', bridge_id: '0x8000.AA:00:00:00:00:10', root_bridge: false, root_bridge_id: ROOT_EXT, root_port: 'ether1', root_path_cost: 200 },
      { device_id: 11, bridge_name: 'bridge', bridge_id: '0x8000.AA:00:00:00:00:11', root_bridge: false, root_bridge_id: ROOT_EXT, root_port: 'sfp1', root_path_cost: 100 },
    ];
    const ls: StpLink[] = [{ from_device_id: 10, from_interface: 'ether1', to_device_id: 11 }];
    const v = verdictFor(resolveStpUpstreams(bs, ls), 10);
    expect(v.confidence).toBe('resolved');
    expect(v.upstreamDeviceId).toBe(11);
    // The one at the edge of what we manage is still reported as external.
    expect(verdictFor(resolveStpUpstreams(bs, ls), 11).confidence).toBe('external-root');
  });

  it('looks through a bonded root port to its member ports', () => {
    const ROOT = '0x8000.BB:00:00:00:00:20';
    const bs: StpBridge[] = [
      { device_id: 20, bridge_name: 'bridge', bridge_id: ROOT, root_bridge: true, root_bridge_id: ROOT, root_port: 'none', root_path_cost: 0 },
      { device_id: 21, bridge_name: 'bridge', bridge_id: '0x8000.BB:00:00:00:00:21', root_bridge: false, root_bridge_id: ROOT, root_port: 'bond1', root_path_cost: 10 },
    ];
    const ls: StpLink[] = [{ from_device_id: 21, from_interface: 'sfp2', to_device_id: 20 }];
    expect(verdictFor(resolveStpUpstreams(bs, ls), 21).confidence).toBe('ambiguous'); // the bond alone matches nothing
    const v = verdictFor(resolveStpUpstreams(bs, ls, new Map([['21 bond1', ['sfp1', 'sfp2']]])), 21);
    expect(v.upstreamDeviceId).toBe(20);
  });
});

// ─── #260: the live fleet of 2026-10-18, with spanning tree's designated bridges ───
import { macNear } from '../stpUpstream';

describe('designated bridge: the exact upstream, managed or not (#260)', () => {
  const B = (device_id: number, bridge_id: string, root_bridge_id: string, root_port: string, cost: number, designated?: string) => ({
    device_id, bridge_name: 'bridge', bridge_id, root_bridge: bridge_id === root_bridge_id, root_bridge_id,
    root_port, root_path_cost: cost, designated_bridge_id: designated ?? null,
  });
  const CORE_ROOT = '0x2000.70:A7:41:EF:8F:FB';
  const STUDIO = '0x7000.E0:63:DA:C7:B3:23';
  const bridges = [
    B(1, '0x8000.F4:1E:57:51:74:1E', '0x8000.F4:1E:57:51:74:1E', 'none', 0),
    B(2, '0x8000.D0:EA:11:0A:DE:77', '0x8000.D0:EA:11:0A:DE:77', 'none', 0),
    B(7, '0x8000.F4:1E:57:BD:F0:2A', '0x8000.F4:1E:57:51:74:1E', 'sfp28-2', 800, '0x8000.F4:1E:57:51:74:1E'),
    B(8, '0x8000.C4:AD:34:D5:BC:B7', CORE_ROOT, 'ether1', 41010, STUDIO),
    B(26, '0x8000.38:32:7A:34:E5:1B', CORE_ROOT, 'ether1', 61000, STUDIO),
  ];
  let id = 0;
  const L = (from: number, port: string, to: number | null, type: string, ident: string, mac: string) =>
    ({ id: ++id, from_device_id: from, from_interface: port, to_device_id: to, link_type: type, neighbor_identity: ident, neighbor_mac: mac });
  // What discovery reported. CDP floods through the unmanaged switches, so every
  // root port "sees" most of the fleet; the TEST switch's sightings are resolved
  // to it here, which is when the old cost rule went wrong.
  const links = [
    L(1, 'sfp28-1', 26, 'cdp', '2GT-NW-MiniRack', '38:32:7A:34:E5:1B'),
    L(1, 'sfp28-1', 2, 'cdp', '2GT-NW-AP4', 'D0:EA:11:0A:DE:77'),
    L(1, 'sfp28-1', 8, 'cdp', '2GT-NW-MIKROTIK10G-TEST', 'C4:AD:34:D5:BC:B7'),
    L(1, 'sfp28-1', null, 'lldp', '2GT-NW-CORE', '70:A7:41:EF:8F:FC'),
    L(1, 'sfp28-2', 7, 'lldp', '2GT-NW-BigSwitch', 'F4:1E:57:BD:F0:33'),
    L(2, 'ether2', 1, 'cdp', '2GT-NW-100G', 'F4:1E:57:51:74:0E'),
    L(2, 'ether2', null, 'lldp', '2GT-NW-TOR', 'D8:B3:70:54:98:21'),
    L(7, 'sfp28-2', 8, 'cdp', '2GT-NW-MIKROTIK10G-TEST', 'C4:AD:34:D5:BC:B7'),
    L(7, 'sfp28-2', 1, 'lldp', '2GT-NW-100G', 'F4:1E:57:51:74:0F'),
    L(7, 'sfp28-2', 26, 'cdp', '2GT-NW-MiniRack', '38:32:7A:34:E5:1B'),
    L(8, 'ether1', 7, 'cdp', '2GT-NW-BigSwitch', 'F4:1E:57:BD:F0:33'),
    L(8, 'ether1', 26, 'cdp', '2GT-NW-MiniRack', '38:32:7A:34:E5:1B'),
    L(8, 'ether1', null, 'lldp', '2GT-NW-STUDIO', 'E0:63:DA:C7:B3:24'),
    L(26, 'ether1', 1, 'cdp', '2GT-NW-100G', 'F4:1E:57:51:74:0E'),
    L(26, 'ether1', 8, 'cdp', '2GT-NW-MIKROTIK10G-TEST', 'C4:AD:34:D5:BC:B7'),
    L(26, 'ether1', null, 'lldp', '2GT-NW-STUDIO', 'E0:63:DA:C7:B3:24'),
  ];
  const verdicts = resolveStpUpstreams(bridges, links);
  const of = (d: number) => verdicts.find((v) => v.deviceId === d)!;

  it('names a managed upstream from the designated bridge', () => {
    expect(of(7)).toMatchObject({ confidence: 'resolved', upstreamDeviceId: 1, method: 'designated' });
  });

  it('two switches on the same unmanaged switch are siblings, not one upstream of the other', () => {
    // The cost rule picked the TEST switch for MiniRack: same tree, lower cost.
    expect(of(26)).toMatchObject({ confidence: 'external-upstream', upstreamDeviceId: null, upstreamName: '2GT-NW-STUDIO' });
    expect(of(8)).toMatchObject({ confidence: 'external-upstream', upstreamName: '2GT-NW-STUDIO' });
    expect(links.find((l) => l.id === of(26).viaLinkId)?.neighbor_identity).toBe('2GT-NW-STUDIO');
  });

  it('roots stay roots', () => {
    expect(of(1).confidence).toBe('is-root');
    expect(of(2).confidence).toBe('is-root');
  });

  it('matches MACs from the same box only', () => {
    expect(macNear('E0:63:DA:C7:B3:23', 'e0:63:da:c7:b3:24')).toBe(true);
    expect(macNear('E0:63:DA:C7:B3:23', 'E0:63:DA:C7:B4:23')).toBe(false);
  });
});
