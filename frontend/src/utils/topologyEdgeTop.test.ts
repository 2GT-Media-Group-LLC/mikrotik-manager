import { describe, it, expect } from 'vitest';
import { buildTopologyGraph, type GraphInput } from './topologyGraph';
import type { TopologyDevice, TopologyLink, ExternalTopologyNode, DeviceType } from '../types';

/**
 * A network whose managed devices all go up into unmanaged switches, under a
 * firewall added by hand: the layout Rich arranged by hand, which the map now
 * draws on its own.
 *
 *   UniFi EFG (firewall, added by hand)
 *     └ CORE (unmanaged)
 *         ├ 100G ── BigSwitch
 *         └ TOR (unmanaged)
 *             ├ AP4
 *             ├ Test Router
 *             └ STUDIO (unmanaged) ── 10G-TEST ── MiniRack
 */
const dev = (id: number, name: string, device_type: DeviceType = 'switch'): TopologyDevice =>
  ({ id, name, ip_address: `10.0.0.${id}`, device_type, status: 'online' });
const ext = (id: string, name: string): ExternalTopologyNode => ({ id, name, address: '', platform: '', mac: id.toUpperCase() });
const cable = (id: number, from: number, to: number, fromIf: string, toIf: string): TopologyLink =>
  ({ id, from_device_id: from, to_device_id: to, from_interface: fromIf, to_interface: toIf, link_type: 'lldp', discovered_at: '2026-11-19T00:00:00Z' });
const toNeighbour = (id: number, from: number, fromIf: string, extId: string): TopologyLink =>
  ({ id, from_device_id: from, from_interface: fromIf, neighbor_mac: extId.toUpperCase(), link_type: 'lldp', discovered_at: '2026-11-19T00:00:00Z' });

const input = (over: Partial<GraphInput> = {}): GraphInput => ({
  devices: [dev(1, '100G'), dev(7, 'BigSwitch'), dev(2, 'AP4', 'wireless_ap'), dev(28, 'Test Router', 'router'), dev(8, '10G-TEST'), dev(26, 'MiniRack')],
  externalNodes: [ext('ext-core', 'CORE'), ext('ext-tor', 'TOR'), ext('ext-studio', 'STUDIO')],
  links: [
    toNeighbour(10, 1, 'sfp28-1', 'ext-core'),
    cable(11, 1, 7, 'sfp28-2', 'sfp28-2'),
    toNeighbour(12, 2, 'ether2', 'ext-tor'),
    toNeighbour(13, 28, 'ether5', 'ext-tor'),
    toNeighbour(14, 8, 'ether1', 'ext-studio'),
    cable(15, 8, 26, 'sfp1', 'sfp1'),
  ],
  bridges: [], upstreams: [],
  // As the server gives them: CDP and MNDP cross the unmanaged switches, so
  // three devices "go up" to switches they aren't cabled to.
  waysUp: [
    { deviceId: 26, upstreamDeviceId: 7, viaLinkId: 99 },
    { deviceId: 2, upstreamDeviceId: 7, viaLinkId: 98 },
    { deviceId: 1, upstreamDeviceId: 7, viaLinkId: 11 },
    { deviceId: 7, upstreamDeviceId: 1, viaLinkId: 11 },
    { deviceId: 8, upstreamDeviceId: 28, viaLinkId: 97 },
  ],
  nodes: [{ id: 2, site_id: 1, name: 'UniFi EFG', kind: 'firewall', address: '192.168.0.1', notes: null }],
  handLinks: [
    { id: 1, label: null, a: { kind: 'node', ref: 2 }, b: { kind: 'external', ref: 'ext-core', name: 'CORE' } },
    { id: 2, label: null, a: { kind: 'external', ref: 'ext-core', name: 'CORE' }, b: { kind: 'external', ref: 'ext-tor', name: 'TOR' } },
    { id: 3, label: null, a: { kind: 'external', ref: 'ext-studio', name: 'STUDIO' }, b: { kind: 'external', ref: 'ext-tor', name: 'TOR' } },
  ],
  clients: null, expandedClients: new Set(),
  ...over,
});

const at = (g: ReturnType<typeof buildTopologyGraph>) => {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return (id: string) => { const n = byId.get(id); if (!n) throw new Error(`no node ${id}`); return n; };
};

describe('the top of the map (Rich, 2026-11-19)', () => {
  it('puts a firewall added by hand on top, and each device under what it is cabled to', () => {
    const n = at(buildTopologyGraph(input()));
    const efg = n('node-2'), core = n('ext-core'), tor = n('ext-tor'), studio = n('ext-studio');
    expect(core.y).toBeGreaterThan(efg.y);
    // 100G and TOR hang from CORE, side by side.
    expect(n('1').y).toBe(tor.y);
    expect(tor.y).toBeGreaterThan(core.y);
    // The router off TOR's port is under TOR, not the top of the map.
    expect(n('28').y).toBeGreaterThan(tor.y);
    expect(n('2').y).toBe(n('28').y);
    expect(studio.y).toBe(n('28').y);
    // Down the chain, not up to the switches CDP heard through TOR.
    expect(n('7').y).toBeGreaterThan(n('1').y);
    expect(n('8').y).toBeGreaterThan(studio.y);
    expect(n('26').y).toBeGreaterThan(n('8').y);
  });

  it('centres a parent over its children', () => {
    const n = at(buildTopologyGraph(input()));
    const kids = ['2', '28', 'ext-studio'].map((id) => n(id).x);
    expect(n('ext-tor').x).toBeCloseTo((Math.min(...kids) + Math.max(...kids)) / 2, 5);
  });

  it('takes a neighbour marked as the Internet the same way', () => {
    const n = at(buildTopologyGraph(input({
      nodes: [], handLinks: input().handLinks.slice(1),
      neighbourOverrides: { 'ext-core': { name: null, kind: 'cloud' } },
    })));
    const top = Math.min(...['ext-core', 'ext-tor', '1', '2', '28'].map((id) => n(id).y));
    expect(n('ext-core').y).toBe(top);
    expect(n('28').y).toBeGreaterThan(n('ext-tor').y);
  });

  it('draws the same tree left to right', () => {
    const n = at(buildTopologyGraph(input({ direction: 'right' })));
    expect(n('ext-core').x).toBeGreaterThan(n('node-2').x);
    expect(n('ext-tor').x).toBeGreaterThan(n('ext-core').x);
    expect(n('28').x).toBeGreaterThan(n('ext-tor').x);
    // Siblings stack down a column.
    expect(n('2').x).toBe(n('28').x);
    expect(n('2').y).not.toBe(n('28').y);
  });
});
