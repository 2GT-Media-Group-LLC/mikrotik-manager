import { describe, it, expect } from 'vitest';
import { wayUpParents, pickTops, deviceTier } from './topologyTiers';
import { buildTopologyGraph, type GraphInput } from './topologyGraph';
import type { TopologyLink, TopologyDevice, DeviceType } from '../types';
import type { BridgeInfo } from './stpRoot';

const byName = (a: string, b: string) => a.localeCompare(b);

describe('wayUpParents (#367)', () => {
  it('follows a managed way up, or the far end of the link for an unmanaged one', () => {
    const p = wayUpParents(
      [{ deviceId: 2, upstreamDeviceId: 1, viaLinkId: 10 }, { deviceId: 3, upstreamDeviceId: null, viaLinkId: 11 }],
      new Map([[11, 'ext-sw']]), () => true, byName);
    expect([...p]).toEqual([['2', '1'], ['3', 'ext-sw']]);
  });

  it('drops a way up to something not on the map', () => {
    const p = wayUpParents([{ deviceId: 2, upstreamDeviceId: 9, viaLinkId: 10 }], new Map(), (id) => id !== '9', byName);
    expect(p.size).toBe(0);
  });

  it('breaks a loop at the one that goes first', () => {
    // Two switches with no root port, each choosing the other; a third under one.
    const p = wayUpParents([
      { deviceId: 1, upstreamDeviceId: 7, viaLinkId: 1 },
      { deviceId: 7, upstreamDeviceId: 1, viaLinkId: 2 },
      { deviceId: 2, upstreamDeviceId: 7, viaLinkId: 3 },
    ], new Map(), () => true, byName);
    expect(p.has('1')).toBe(false);
    expect(p.get('7')).toBe('1');
    expect(p.get('2')).toBe('7');
  });
});

describe('pickTops (#367)', () => {
  const tiers: Record<string, number> = { r1: 0, r2: 0, csw: 1, lone: 1, ap: 2 };
  const tierOf = (id: string) => tiers[id];

  it('puts both gateway routers on top', () => {
    const parent = new Map([['csw', 'r1'], ['ap', 'csw']]);
    expect(pickTops(['r1', 'r2', 'csw', 'ap'], parent, tierOf, byName)).toEqual(['r1', 'r2']);
  });

  it("leaves out a switch whose uplink wasn't found when another has devices under it", () => {
    const parent = new Map([['ap', 'csw']]);
    expect(pickTops(['csw', 'lone', 'ap'], parent, tierOf, byName)).toEqual(['csw']);
  });

  it('is empty when nothing has a way up', () => {
    expect(pickTops(['csw', 'lone'], new Map(), tierOf, byName)).toEqual([]);
  });

  it('ranks types as the server does', () => {
    expect([deviceTier('router'), deviceTier('switch'), deviceTier('wireless_ap'), deviceTier(undefined)]).toEqual([0, 1, 2, 2]);
  });
});

// ── The map ─────────────────────────────────────────────────────────────────

const dev = (id: number, name: string, device_type: DeviceType): TopologyDevice =>
  ({ id, name, ip_address: `10.0.0.${id}`, device_type, status: 'online' });
const link = (id: number, from: number, to: number, fromIf = `p${id}`, toIf = `q${id}`): TopologyLink =>
  ({ id, from_device_id: from, to_device_id: to, from_interface: fromIf, to_interface: toIf, link_type: 'lldp', discovered_at: '2026-11-01T00:00:00Z' });
const base = (over: Partial<GraphInput>): GraphInput => ({
  devices: [], externalNodes: [], links: [], bridges: [], upstreams: [],
  nodes: [], handLinks: [], clients: null, expandedClients: new Set(), ...over,
});
const bridge = (device_id: number, root: boolean): BridgeInfo => ({
  device_id, bridge_name: 'bridge', bridge_id: `8000.${device_id}`, root_bridge: root,
  root_bridge_id: '8000.11', root_port: root ? null : 'sfp1', root_path_cost: root ? 0 : 2000, protocol_mode: 'rstp',
});

describe('tiered layout (#367)', () => {
  // aziz's campus: two gateway routers joined to each other, a core switch
  // under each (CSW1 is the spanning-tree root), access switches, an AP.
  const devices = [
    dev(1, 'R1', 'router'), dev(2, 'R2', 'router'),
    dev(11, 'CSW1', 'switch'), dev(12, 'CSW2', 'switch'),
    dev(21, 'ASW1', 'switch'), dev(22, 'ASW2', 'switch'),
    dev(31, 'AP1', 'wireless_ap'),
  ];
  const links = [
    link(1, 1, 2), link(2, 11, 1), link(3, 12, 2), link(4, 11, 12),
    link(5, 21, 11), link(6, 22, 12), link(7, 21, 12), link(8, 31, 21),
  ];
  const waysUp = [
    { deviceId: 11, upstreamDeviceId: 1, viaLinkId: 2 },
    { deviceId: 12, upstreamDeviceId: 2, viaLinkId: 3 },
    { deviceId: 21, upstreamDeviceId: 11, viaLinkId: 5 },
    { deviceId: 22, upstreamDeviceId: 12, viaLinkId: 6 },
    { deviceId: 31, upstreamDeviceId: 21, viaLinkId: 8 },
  ];
  const bridges = [bridge(11, true), bridge(12, false), bridge(21, false), bridge(22, false)];
  const at = (g: ReturnType<typeof buildTopologyGraph>, id: number) => g.nodes.find((n) => n.id === String(id))!;

  it('puts the gateway routers side by side on top, then core, access and APs', () => {
    const g = buildTopologyGraph(base({ devices, links, bridges, waysUp }));
    const y = (id: number) => at(g, id).y;
    expect(y(1)).toBe(y(2));
    expect(y(11)).toBeGreaterThan(y(1));
    expect(y(12)).toBe(y(11));
    expect(y(21)).toBeGreaterThan(y(11));
    expect(y(31)).toBeGreaterThan(y(21));
    // Nothing else on the routers' row, so the cable between them is clear.
    expect(g.nodes.filter((n) => n.y === y(1)).map((n) => n.id).sort()).toEqual(['1', '2']);
    // Each switch under its own way up.
    expect(Math.sign(at(g, 11).x - at(g, 12).x)).toBe(Math.sign(at(g, 1).x - at(g, 2).x));
    // The spanning-tree root keeps its star.
    expect(at(g, 11).data.isRootBridge).toBe(true);
  });

  it('draws a tunnel peer beside its router, not in the tree under it', () => {
    const wg: TopologyLink = { id: 99, from_device_id: 1, from_interface: 'WG1', from_interface_type: 'wg', neighbor_mac: 'af',
      neighbor_identity: 'HQ', link_type: 'mndp', discovered_at: '2026-11-01T00:00:00Z' };
    const g = buildTopologyGraph(base({
      devices, links: [...links, wg], bridges, waysUp,
      externalNodes: [{ id: 'ext-hq', name: 'HQ', address: '', platform: '', mac: 'af', caps: 'router' }],
    }));
    const peer = g.nodes.find((n) => n.id === 'ext-hq')!;
    expect(peer.y).toBe(at(g, 1).y);
    // Beside it on the outside, so the tunnel doesn't run behind the other router.
    expect(Math.sign(peer.x - at(g, 1).x)).not.toBe(Math.sign(at(g, 2).x - at(g, 1).x));
    expect(Math.abs(peer.x - at(g, 1).x)).toBeLessThanOrEqual(1.1 * 240 + 1);
    // Not between the core switches.
    expect(g.nodes.filter((n) => n.y === at(g, 11).y).map((n) => n.id).sort()).toEqual(['11', '12']);
  });

  it('keeps the spanning-tree root on top without ways up, as before', () => {
    const g = buildTopologyGraph(base({ devices, links, bridges }));
    expect(at(g, 11).y).toBeLessThan(at(g, 1).y);
  });

  it('breaks a loop of two switches, and draws an unmanaged way up between', () => {
    // The lab: 100G and BigSwitch each choose the other; TEST goes up through
    // STUDIO, a switch only TEST hears; AP4 under BigSwitch.
    const lab = [dev(1, '100G', 'switch'), dev(7, 'BigSwitch', 'switch'), dev(8, 'TEST', 'switch'), dev(2, 'AP4', 'wireless_ap')];
    const g = buildTopologyGraph(base({
      devices: lab,
      externalNodes: [{ id: 'ext-studio', name: 'STUDIO', address: '', platform: '', mac: 'aa', caps: 'bridge' }],
      links: [link(1, 1, 7), link(2, 7, 1), link(3, 2, 7), link(4, 8, 7),
        { id: 5, from_device_id: 8, from_interface: 'ether1', neighbor_mac: 'aa', neighbor_identity: 'STUDIO', link_type: 'lldp', discovered_at: '2026-11-01T00:00:00Z' }],
      bridges: [bridge(1, true), bridge(7, false)],
      waysUp: [
        { deviceId: 1, upstreamDeviceId: 7, viaLinkId: 1 },
        { deviceId: 7, upstreamDeviceId: 1, viaLinkId: 2 },
        { deviceId: 2, upstreamDeviceId: 7, viaLinkId: 3 },
        { deviceId: 8, upstreamDeviceId: null, viaLinkId: 5 },
      ],
    }));
    const y = (id: string) => g.nodes.find((n) => n.id === id)!.y;
    // The spanning-tree root wins the loop.
    expect(y('1')).toBeLessThan(y('7'));
    expect(y('2')).toBeGreaterThan(y('7'));
    expect(y('ext-studio')).toBeLessThan(y('8'));
  });
});
