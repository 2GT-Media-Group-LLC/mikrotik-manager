import { describe, it, expect } from 'vitest';
import { buildTopologyGraph, mergeCables, endFor, endId, type GraphInput } from './topologyGraph';
import type { TopologyLink, TopologyDevice } from '../types';

const dev = (id: number, name = `d${id}`): TopologyDevice => ({ id, name, ip_address: `10.0.0.${id}`, device_type: 'switch', status: 'online' });
const link = (id: number, from: number, to: number, fromIf: string, toIf: string, stp_role?: string): TopologyLink =>
  ({ id, from_device_id: from, to_device_id: to, from_interface: fromIf, to_interface: toIf, link_type: 'lldp', stp_role, discovered_at: '2026-10-10T00:00:00Z' });

const base = (over: Partial<GraphInput> = {}): GraphInput => ({
  devices: [], externalNodes: [], links: [], bridges: [], upstreams: [],
  nodes: [], handLinks: [], clients: null, expandedClients: new Set(), ...over,
});

describe('mergeCables', () => {
  it('draws one edge for a cable both ends report', () => {
    const links = [link(1, 1, 2, 'ether1', 'sfp1', 'designated'), link(2, 2, 1, 'sfp1', 'ether1', 'root')];
    const far = new Map([[1, '2'], [2, '1']]);
    const c = mergeCables(links, far);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: '1', target: '2', label: 'ether1 ↔ sfp1', role: 'root' });
  });

  it('keeps a second, blocked cable between the same two switches', () => {
    const links = [
      link(1, 1, 2, 'ether1', 'sfp1', 'designated'), link(2, 2, 1, 'sfp1', 'ether1', 'root'),
      link(3, 1, 2, 'ether2', 'sfp2', 'designated'), link(4, 2, 1, 'sfp2', 'ether2', 'alternate'),
    ];
    const far = new Map([[1, '2'], [2, '1'], [3, '2'], [4, '1']]);
    const c = mergeCables(links, far);
    expect(c.map((x) => x.role)).toEqual(['root', 'blocked']);
  });
});

describe('buildTopologyGraph', () => {
  it('puts a parallel blocked cable on the side handles', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1), dev(2)],
      links: [link(1, 1, 2, 'ether1', 'sfp1'), link(3, 1, 2, 'ether2', 'sfp2', 'alternate')],
    }));
    expect(g.edges.map((e) => e.parallel)).toEqual([0, 1]);
  });

  it('hangs clients off their device, as a count until expanded', () => {
    const input = base({
      devices: [dev(1), dev(2)],
      links: [link(1, 1, 2, 'ether1', 'sfp1')],
      clients: [
        { mac: 'A', name: 'laptop', ip: null, deviceId: 2, interface: 'ether5', wireless: false, portKnown: true },
        { mac: 'B', name: 'phone', ip: null, deviceId: 2, interface: 'wifi1', wireless: true, portKnown: true },
      ],
    });
    const collapsed = buildTopologyGraph(input);
    const group = collapsed.nodes.find((n) => n.kind === 'clientGroup')!;
    expect(group.data).toMatchObject({ count: 2, wireless: 1 });
    const parent = collapsed.nodes.find((n) => n.id === '2')!;
    expect(group.y).toBeGreaterThan(parent.y);

    const open = buildTopologyGraph({ ...input, expandedClients: new Set(['2']) });
    expect(open.nodes.filter((n) => n.kind === 'client')).toHaveLength(2);
    // Opened, the clients hang from the chip, below it, not beside the device's children.
    const chip = open.nodes.find((n) => n.kind === 'clientGroup')!;
    expect(chip.data.expanded).toBe(true);
    for (const c of open.nodes.filter((n) => n.kind === 'client')) expect(c.y).toBeGreaterThan(chip.y);
    expect(open.edges.filter((e) => e.kind === 'client' && e.source === chip.id)).toHaveLength(2);
  });

  it('hangs clients learned on a port facing an unmanaged switch under that switch', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(8)],
      externalNodes: [{ id: 'ext-studio', name: 'STUDIO', address: '', platform: '', mac: 'MM' }],
      links: [{ id: 1, from_device_id: 8, from_interface: 'ether1', neighbor_mac: 'MM', link_type: 'lldp', discovered_at: '' }],
      clients: [{ mac: 'C', name: 'tv', ip: null, deviceId: 8, interface: 'ether1', wireless: false, portKnown: true, behindNeighbour: true }],
    }));
    expect(g.edges.find((e) => e.kind === 'client')).toMatchObject({ source: 'ext-studio' });
  });

  it('places a hand-drawn modem above the router it feeds', () => {
    const g = buildTopologyGraph(base({
      devices: [{ ...dev(1, 'router'), device_type: 'router' }, dev(2)],
      links: [link(1, 1, 2, 'ether2', 'sfp1')],
      nodes: [{ id: 5, site_id: 1, name: 'ISP modem', kind: 'modem', address: null, notes: null }],
      handLinks: [{ id: 9, label: 'ether1', a: { kind: 'node', ref: 5 }, b: { kind: 'device', ref: 1 } }],
    }));
    const modem = g.nodes.find((n) => n.id === 'node-5')!;
    const router = g.nodes.find((n) => n.id === '1')!;
    expect(modem.y).toBeLessThan(router.y);
    expect(g.edges.find((e) => e.kind === 'hand')).toMatchObject({ source: 'node-5', target: '1', deleteId: 9, label: 'ether1' });
  });

  it('links a discovered neighbour by hand, and keeps it after discovery loses sight of it', () => {
    const ext = { id: 'ext-aa01', name: 'STUDIO', address: '', platform: '', mac: 'AA01' };
    const handLinks = [{ id: 3, label: null, a: { kind: 'external' as const, ref: 'ext-aa01', name: 'STUDIO' }, b: { kind: 'device' as const, ref: 2 } }];
    const seen = buildTopologyGraph(base({ devices: [dev(2)], externalNodes: [ext], handLinks }));
    expect(seen.edges.find((e) => e.kind === 'hand')).toMatchObject({ source: 'ext-aa01', target: '2', deleteId: 3 });
    const gone = buildTopologyGraph(base({ devices: [dev(2)], externalNodes: [], handLinks }));
    const ghost = gone.nodes.find((n) => n.id === 'ext-aa01')!;
    expect(ghost.data).toMatchObject({ name: 'STUDIO', caps: 'gone' });
    expect(gone.edges.find((e) => e.kind === 'hand')).toBeTruthy();
  });

  it('counts devices with no connection at all', () => {
    const g = buildTopologyGraph(base({ devices: [dev(1), dev(2), dev(3)], links: [link(1, 1, 2, 'e1', 'e2')] }));
    expect(g.orphanCount).toBe(1);
    expect(g.nodes.find((n) => n.id === '3')!.data.orphan).toBe(true);
  });

  it('notes a spanning-tree root outside the fleet on the top device', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1), dev(2)],
      links: [link(1, 1, 2, 'e1', 'e2')],
      bridges: [
        { device_id: 1, bridge_name: 'bridge', bridge_id: '0x8000.AA', root_bridge: false, root_bridge_id: '0x2000.FF', root_port: 'e9', root_path_cost: 10, protocol_mode: 'rstp' },
        { device_id: 2, bridge_name: 'bridge', bridge_id: '0x8000.BB', root_bridge: false, root_bridge_id: '0x2000.FF', root_port: 'e2', root_path_cost: 20, protocol_mode: 'rstp' },
      ],
    }));
    const noted = g.nodes.filter((n) => n.data.stpNote);
    expect(noted).toHaveLength(1);
    expect(String(noted[0].data.stpNote)).toContain('0x2000.FF');
  });
});

describe('ends of hand-drawn links', () => {
  it('maps map nodes to link ends and back', () => {
    expect(endFor('12')).toEqual({ kind: 'device', ref: 12 });
    expect(endFor('node-4')).toEqual({ kind: 'node', ref: 4 });
    expect(endFor('ext-ab12', 'CORE')).toEqual({ kind: 'external', ref: 'ext-ab12', name: 'CORE' });
    expect(endFor('client-AA')).toBeNull();
    expect(endId({ kind: 'node', ref: 4 })).toBe('node-4');
    expect(endId({ kind: 'external', ref: 'ext-ab12' })).toBe('ext-ab12');
  });
});

describe('positions arranged by hand', () => {
  const input = () => base({
    devices: [dev(1), dev(2), dev(3)],
    links: [link(1, 1, 2, 'e1', 'e2'), link(2, 2, 3, 'e3', 'e4')],
  });

  it('keeps saved positions exactly', () => {
    const g = buildTopologyGraph({ ...input(), saved: { '1': { x: 500, y: -40 }, '2': { x: 900, y: 300 }, '3': { x: 10, y: 10 } } });
    expect(g.nodes.find((n) => n.id === '2')).toMatchObject({ x: 900, y: 300, pinned: true });
  });

  it('puts a new node where the layout would, relative to its saved parent', () => {
    const plain = buildTopologyGraph(input());
    const at = (g: typeof plain, id: string) => g.nodes.find((n) => n.id === id)!;
    const offset = { x: at(plain, '3').x - at(plain, '2').x, y: at(plain, '3').y - at(plain, '2').y };
    const g = buildTopologyGraph({ ...input(), saved: { '1': { x: 0, y: 0 }, '2': { x: 2000, y: 700 } } });
    expect(at(g, '3')).toMatchObject({ x: 2000 + offset.x, y: 700 + offset.y });
    expect(at(g, '3').pinned).toBeFalsy();
  });

  it('puts an unsaved, unconnected device below the arranged part', () => {
    const g = buildTopologyGraph({ ...base({ devices: [dev(1), dev(2), dev(9)], links: [link(1, 1, 2, 'e1', 'e2')] }), saved: { '1': { x: 0, y: 0 }, '2': { x: 0, y: 400 } } });
    expect(g.nodes.find((n) => n.id === '9')!.y).toBeGreaterThan(400);
  });

  it('gives a cable an id that survives discovery rewriting its rows', () => {
    const a = buildTopologyGraph(base({ devices: [dev(1), dev(2)], links: [link(1, 1, 2, 'e1', 'e2')] }));
    const b = buildTopologyGraph(base({ devices: [dev(1), dev(2)], links: [link(777, 1, 2, 'e1', 'e2')] }));
    expect(a.edges[0].id).toBe(b.edges[0].id);
  });
});
