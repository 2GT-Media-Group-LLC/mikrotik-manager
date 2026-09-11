import { findUpstreamWithinSelection, type TopologyEdge } from '../rolloutTopology';
import type { StpBridge } from '../stpUpstream';

const link = (from: number, to: number | null, iface = 'ether1'): TopologyEdge =>
  ({ from_device_id: from, to_device_id: to, from_interface: iface });

const root = (id: number, bridgeId: string): StpBridge =>
  ({ device_id: id, bridge_name: 'bridge', bridge_id: bridgeId, root_bridge: true,
     root_bridge_id: bridgeId, root_port: 'none', root_path_cost: 0 });

const under = (
  id: number, bridgeId: string, rootId: string, port: string, cost: number
): StpBridge =>
  ({ device_id: id, bridge_name: 'bridge', bridge_id: bridgeId, root_bridge: false,
     root_bridge_id: rootId, root_port: port, root_path_cost: cost });

const ROOT_ID = '0x8000.AA';

describe('findUpstreamWithinSelection', () => {
  // The case the warning exists for: two devices reach the network through a
  // switch, and all three are being upgraded together.
  it('flags a device the others are reached through', () => {
    const bridges = [
      root(1, ROOT_ID),
      under(2, '0x8000.BB', ROOT_ID, 'e1', 10),
      under(3, '0x8000.CC', ROOT_ID, 'e1', 10),
    ];
    const links = [link(2, 1, 'e1'), link(3, 1, 'e1')];
    expect(findUpstreamWithinSelection([1, 2, 3], links, bridges)).toEqual([1]);
  });

  /**
   * This is the improvement. Previously the port roles were read directly, and
   * any port resolving to several neighbours had to be abandoned — which on a
   * real fleet was every port, so the warning never fired. Spanning tree settles
   * it: of the three neighbours on that port, only one is in the same domain and
   * nearer the root.
   */
  it('resolves a port that discovery left ambiguous', () => {
    const bridges = [
      root(1, ROOT_ID),
      under(7, '0x8000.BB', ROOT_ID, 'sfp28-2', 800),
      under(8, '0x8000.CC', '0x2000.EXTERNAL', 'ether1', 41010),
      root(2, '0x8000.DD'),
    ];
    // sfp28-2 sees three neighbours; only device 1 qualifies.
    const links = [
      link(7, 2, 'sfp28-2'), link(7, 1, 'sfp28-2'), link(7, 8, 'sfp28-2'),
    ];
    expect(findUpstreamWithinSelection([1, 2, 7, 8], links, bridges)).toEqual([1]);
  });

  // A device under a root nobody manages has an upstream we cannot see, so
  // there is nothing to warn about within this selection.
  it('says nothing when the root is unmanaged', () => {
    const bridges = [
      root(1, ROOT_ID),
      under(8, '0x8000.CC', '0x2000.EXTERNAL', 'ether1', 41010),
    ];
    const links = [link(8, 1, 'ether1')];
    expect(findUpstreamWithinSelection([1, 8], links, bridges)).toEqual([]);
  });

  it('declines when several neighbours genuinely qualify', () => {
    const bridges = [
      root(1, ROOT_ID),
      under(2, '0x8000.BB', ROOT_ID, 'e1', 10),
      under(3, '0x8000.CC', ROOT_ID, 'e1', 10),
      under(4, '0x8000.DD', ROOT_ID, 'e9', 50),
    ];
    const links = [link(4, 2, 'e9'), link(4, 3, 'e9')];
    expect(findUpstreamWithinSelection([2, 3, 4], links, bridges)).toEqual([]);
  });

  // A switch upstream of something not in this rollout is not a risk to it.
  it('ignores an upstream outside the selection', () => {
    const bridges = [root(1, ROOT_ID), under(2, '0x8000.BB', ROOT_ID, 'e1', 10)];
    const links = [link(2, 1, 'e1')];
    expect(findUpstreamWithinSelection([2, 3], links, bridges)).toEqual([]);
  });

  it('needs at least two selected devices', () => {
    const bridges = [root(1, ROOT_ID), under(2, '0x8000.BB', ROOT_ID, 'e1', 10)];
    expect(findUpstreamWithinSelection([2], [link(2, 1, 'e1')], bridges)).toEqual([]);
    expect(findUpstreamWithinSelection([], [link(2, 1, 'e1')], bridges)).toEqual([]);
  });

  // No spanning tree at all is the common case on flat networks; it must be
  // quiet rather than throwing or guessing.
  it('is quiet when there is no STP data', () => {
    expect(findUpstreamWithinSelection([1, 2], [link(2, 1, 'e1')], [])).toEqual([]);
    expect(findUpstreamWithinSelection([1, 2], [link(2, 1, 'e1')])).toEqual([]);
  });

  it('reports several upstream devices in a stable order', () => {
    const bridges = [
      root(1, ROOT_ID), root(2, '0x8000.ZZ'),
      under(4, '0x8000.DD', ROOT_ID, 'e1', 10),
      under(3, '0x8000.CC', '0x8000.ZZ', 'e1', 10),
    ];
    const links = [link(4, 1, 'e1'), link(3, 2, 'e1')];
    expect(findUpstreamWithinSelection([1, 2, 3, 4], links, bridges)).toEqual([1, 2]);
  });

  it('tolerates unresolved neighbours and self links', () => {
    const bridges = [root(1, ROOT_ID), under(2, '0x8000.BB', ROOT_ID, 'e1', 10)];
    const links = [link(2, null, 'e1'), link(2, 2, 'e1'), link(2, 1, 'e1')];
    expect(findUpstreamWithinSelection([1, 2], links, bridges)).toEqual([1]);
  });
});
