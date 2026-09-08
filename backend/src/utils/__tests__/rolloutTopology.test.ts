import { findUpstreamWithinSelection, type TopologyEdge } from '../rolloutTopology';

const link = (
  from: number, to: number | null, iface = 'ether1', role: string | null = 'root'
): TopologyEdge => ({ from_device_id: from, to_device_id: to, from_interface: iface, stp_role: role });

describe('findUpstreamWithinSelection', () => {
  // The case the warning exists for: two devices reach the network through a
  // switch, and all three are being upgraded together.
  it('flags a device reached through, when the link is unambiguous', () => {
    const links = [
      link(2, 1, 'ether1', 'root'),
      link(3, 1, 'ether1', 'root'),
    ];
    expect(findUpstreamWithinSelection([1, 2, 3], links)).toEqual([1]);
  });

  /**
   * The failure that prompted the rewrite. Links are bidirectional and a trunk
   * port often resolves to several neighbours, so counting adjacency flagged
   * every device on a real four-device fleet. A warning that fires on
   * everything trains people to ignore it.
   */
  it('says nothing when a port resolves to several neighbours', () => {
    const links = [
      link(7, 1, 'sfp28-2', 'root'),
      link(7, 8, 'sfp28-2', 'root'),
      link(7, 2, 'sfp28-2', 'root'),
    ];
    expect(findUpstreamWithinSelection([1, 2, 7, 8], links)).toEqual([]);
  });

  it('is not fooled by the reverse direction of the same link', () => {
    // Both ends report each other; only the root-port end means "upstream".
    const links = [
      link(2, 1, 'ether1', 'root'),
      link(1, 2, 'sfp1', 'designated'),
    ];
    expect(findUpstreamWithinSelection([1, 2], links)).toEqual([1]);
  });

  it('ignores designated ports, which face away from the root', () => {
    const links = [link(1, 2, 'sfp1', 'designated')];
    expect(findUpstreamWithinSelection([1, 2], links)).toEqual([]);
  });

  it('tolerates the -port suffix RouterOS sometimes reports', () => {
    const links = [link(2, 1, 'ether1', 'root-port')];
    expect(findUpstreamWithinSelection([1, 2], links)).toEqual([1]);
  });

  it('ignores links to devices outside the selection', () => {
    // A switch upstream of something not in this rollout is not a risk to it.
    const links = [link(50, 1, 'ether1', 'root')];
    expect(findUpstreamWithinSelection([1, 2], links)).toEqual([]);
  });

  it('needs at least two selected devices', () => {
    expect(findUpstreamWithinSelection([1], [link(2, 1)])).toEqual([]);
    expect(findUpstreamWithinSelection([], [link(2, 1)])).toEqual([]);
  });

  it('tolerates unresolved neighbours, self links and missing roles', () => {
    const links = [
      link(2, null, 'ether1', 'root'),
      link(1, 1, 'ether1', 'root'),
      link(3, 1, 'ether5', null),
      link(2, 1, 'ether9', 'root'),
    ];
    expect(findUpstreamWithinSelection([1, 2, 3], links)).toEqual([1]);
  });

  it('reports several upstream devices in a stable order', () => {
    const links = [
      link(3, 2, 'ether1', 'root'),
      link(4, 1, 'ether1', 'root'),
    ];
    expect(findUpstreamWithinSelection([1, 2, 3, 4], links)).toEqual([1, 2]);
  });
});
