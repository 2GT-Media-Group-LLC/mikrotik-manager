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
