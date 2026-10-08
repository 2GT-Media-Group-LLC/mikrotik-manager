import { l3hwView } from '../l3hw';
import { ruleL3HwOffloadOff, isL3HwChip } from '../../services/changeGuard/configHealth';
import type { DeviceSnapshot } from '../../services/changeGuard/pathModel';

// As a CRS309 (Marvell-98DX8208) on 7.24.5 reports them.
type R = Record<string, string>;
const chipOff: R[] = [{ '.id': '*0', name: 'switch1', type: 'Marvell-98DX8208', 'l3-hw-offloading': 'false' }];
const chipOn: R[] = [{ ...chipOff[0], 'l3-hw-offloading': 'true' }];
const ports: R[] = [
  { name: 'sfp-sfpplus1', switch: 'switch1', 'l3-hw-offloading': 'true' },
  { name: 'sfp-sfpplus2', switch: 'switch1', 'l3-hw-offloading': 'false' },
];
const vlans: R[] = [{ name: 'vlan10', interface: 'bridge', 'vlan-id': '10' }, { name: 'vlan20', interface: 'bridge', 'vlan-id': '20' }, { name: 'vlan30', interface: 'bridge', disabled: 'true' }];
const addrs: R[] = [
  { address: '10.10.0.1/24', interface: 'vlan10' }, { address: '10.20.0.1/24', interface: 'vlan20' },
  { address: '10.30.0.1/24', interface: 'vlan30' }, { address: '192.168.0.51/24', interface: 'bridge' },
];

describe('L3 hardware offloading (#254)', () => {
  it('recognises the Marvell 98DX chips and nothing else', () => {
    expect(isL3HwChip('Marvell-98DX8208')).toBe(true);   // CRS309
    expect(isL3HwChip('Marvell-98DX8525')).toBe(true);   // CCR2216
    expect(isL3HwChip('Marvell-98DX226S')).toBe(true);   // CRS310
    expect(isL3HwChip('QCA-8337')).toBe(false);
    expect(isL3HwChip(undefined)).toBe(false);
  });

  it('describes the chip, routed VLANs and the rules offloading would bypass', () => {
    const v = l3hwView(chipOn, ports, { 'ipv6-hw': 'false', 'fasttrack-hw': 'true', 'hw-supports-fasttrack': 'true' },
      { 'ipv4-routes-hw': '12', 'ipv4-routes-cpu': '1', 'ipv4-hosts': '40' }, vlans, addrs,
      [{ chain: 'forward', action: 'drop' }, { chain: 'input', action: 'drop' }, { chain: 'forward', disabled: 'true' }] as R[],
      [{ chain: 'srcnat', action: 'masquerade' }]);
    expect(v).toMatchObject({
      supported: true, enabled: true, switch: { name: 'switch1', type: 'Marvell-98DX8208' },
      portsOff: ['sfp-sfpplus2'], ipv6: false, fasttrackHw: true, routesHw: 12, routesCpu: 1, hostsHw: 40,
      routedVlans: ['vlan10', 'vlan20'], forwardRules: 1, natRules: 1,
    });
  });

  it('names routed VLANs whose bridge has VLAN filtering off, which stay on the CPU', () => {
    const v = l3hwView(chipOn, [], undefined, undefined, vlans, addrs, [], [], [{ name: 'bridge', 'vlan-filtering': 'false' }]);
    expect(v.notOffloadable).toEqual([{ vlan: 'vlan10', bridge: 'bridge' }, { vlan: 'vlan20', bridge: 'bridge' }]);
    expect(l3hwView(chipOn, [], undefined, undefined, vlans, addrs, [], [], [{ name: 'bridge', 'vlan-filtering': 'true' }]).notOffloadable).toEqual([]);
  });

  it('says unsupported for a device without a 98DX chip', () => {
    expect(l3hwView([], [], undefined, undefined, [], [], [], []).supported).toBe(false);
  });

  it('flags routing between VLANs on the CPU, once per chip', () => {
    const snap = { switches: chipOff, vlanInterfaces: vlans, addresses: addrs } as unknown as DeviceSnapshot;
    const [f, ...rest] = ruleL3HwOffloadOff(snap);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rule: 'l3-hw-offload-off', fingerprint: 'l3-hw-offload-off:switch1', severity: 'info', objects: ['switch1', 'vlan10', 'vlan20'] });
    expect(ruleL3HwOffloadOff({ ...snap, switches: chipOn } as DeviceSnapshot)).toEqual([]);
    // One routed VLAN is not routing between VLANs.
    expect(ruleL3HwOffloadOff({ ...snap, addresses: addrs.slice(0, 1) } as DeviceSnapshot)).toEqual([]);
  });
});
