import { describe, it, expect } from 'vitest';
import { buildTopologyGraph, mergeCables, foldLogical, endFor, endId, type GraphInput, type GraphEdge } from './topologyGraph';
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

// Discussion #85: a discovered link that isn't a real cable can be hidden.
describe('links hidden by hand', () => {
  const sw = { id: 'ext-aabbcc000001', name: 'new-switch', address: '', platform: '', mac: 'AA:BB:CC:00:00:01', caps: '' };
  const toSwitch = (id: number, from: number, fromIf: string): TopologyLink =>
    ({ id, from_device_id: from, from_interface: fromIf, to_interface: 'port24', neighbor_mac: 'AA:BB:CC:00:00:01', link_type: 'lldp', discovered_at: '2026-10-12T00:00:00Z' });
  const input = (hidden?: Set<string>) => base({
    devices: [dev(1, 'router'), dev(2, 'ap')],
    externalNodes: [sw],
    links: [link(1, 1, 2, 'ether3', 'ether1'), toSwitch(2, 1, 'ether5'), toSwitch(3, 2, 'ether1')],
    hidden,
  });

  it('leaves out a hidden link, and keeps the rest', () => {
    const all = buildTopologyGraph(input());
    const wrong = all.edges.find((e) => e.source === '2' || (e.target === '2' && e.source === sw.id))!;
    const toAp = all.edges.find((e) => [e.source, e.target].includes(sw.id) && [e.source, e.target].includes('2'))!;
    expect(toAp).toBeDefined();
    const g = buildTopologyGraph(input(new Set([toAp.id])));
    expect(g.edges.some((e) => e.id === toAp.id)).toBe(false);
    expect(g.edges.filter((e) => [e.source, e.target].includes(sw.id))).toHaveLength(1);
    expect(g.nodes.some((n) => n.id === sw.id)).toBe(true);
    expect(wrong).toBeDefined();
  });

  it('removes a neighbour that only hidden links reached', () => {
    const all = buildTopologyGraph(input());
    const toSw = all.edges.filter((e) => [e.source, e.target].includes(sw.id)).map((e) => e.id);
    const g = buildTopologyGraph(input(new Set(toSw)));
    expect(g.nodes.some((n) => n.id === sw.id)).toBe(false);
    expect(g.nodes.filter((n) => n.kind === 'device')).toHaveLength(2);
  });
});

// #260: editing the map by hand.
describe('hand edits on the map', () => {
  it('shows the ports typed for a hand-drawn link, then its label', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1), dev(2)],
      handLinks: [{ id: 7, label: 'trunk', aPort: 'ether5', bPort: 'sfp1', a: { kind: 'device', ref: 1 }, b: { kind: 'device', ref: 2 } }],
    }));
    expect(g.edges.find((e) => e.id === 'hand-7')?.label).toBe('ether5 ↔ sfp1 · trunk');
  });

  it('names and types a neighbour as set by hand, keeping what discovery called it', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1)],
      externalNodes: [{ id: 'ext-aa', name: 'DESKTOP-1234', address: '', platform: '', mac: 'AA', caps: 'bridge,station' }],
      links: [{ id: 1, from_device_id: 1, from_interface: 'ether3', neighbor_mac: 'AA', link_type: 'lldp', discovered_at: '2026-10-12T00:00:00Z' }],
      neighbourOverrides: { 'ext-aa': { name: 'Rich PC', kind: 'computer' } },
    }));
    const n = g.nodes.find((x) => x.id === 'ext-aa')!;
    expect(n.data).toMatchObject({ name: 'Rich PC', discoveredName: 'DESKTOP-1234', overrideKind: 'computer' });
  });
});

// #367: logical sightings beside a cable, and computers that speak LLDP.
const sighting = (id: number, from: number, to: number, fromIf: string, type: string | null, link_type = 'cdp', toIf?: string): TopologyLink =>
  ({ id, from_device_id: from, to_device_id: to, from_interface: fromIf, to_interface: toIf, from_interface_type: type, link_type, discovered_at: '' });

describe('logical links fold into the cable (#367)', () => {
  it('two routers: one cable and 15 VLAN/VRRP sightings draw one line with a count', () => {
    const vlans = [10, 20, 30, 40, 50, 60, 70, 98];
    const links: TopologyLink[] = [
      link(1, 1, 2, 'sfp28-2', 'sfp28-2'),
      ...vlans.map((v, i) => sighting(100 + i, 1, 2, `vlan${v}`, 'vlan')),
      ...vlans.slice(0, 7).map((v, i) => sighting(200 + i, 1, 2, `vrrp${v}`, 'vrrp')),
    ];
    const g = buildTopologyGraph(base({ devices: [dev(1), dev(2)], links }));
    const between = g.edges.filter((e) => e.kind === 'discovered');
    expect(between).toHaveLength(1);
    expect(between[0].label).toBe('sfp28-2 ↔ sfp28-2');
    expect(between[0].logical).toBeUndefined();
    expect(between[0].folded).toHaveLength(15);
    expect(between[0].folded).toContain('vlan10');
    expect(between[0].parallel).toBe(0);
  });

  it('home: the vlan300 sightings over MNDP and CDP fold into the LLDP cable', () => {
    const links: TopologyLink[] = [
      link(1, 1, 2, 'sfp-sfpplus1', 'sfp-sfpplus1'),
      sighting(2, 1, 2, 'vlan300', 'vlan', 'mndp'),
      sighting(3, 2, 1, 'vlan300', 'vlan', 'cdp'),
    ];
    const g = buildTopologyGraph(base({ devices: [dev(1), dev(2)], links }));
    const between = g.edges.filter((e) => e.kind === 'discovered');
    expect(between).toHaveLength(1);
    expect(between[0].folded).toEqual(['vlan300 ↔ vlan300']);
  });

  it('keeps every cable, and folds a far end named Vlan10 even without a type', () => {
    const links: TopologyLink[] = [
      link(1, 1, 2, 'sfp1', 'Te1/0/1'),
      link(2, 1, 2, 'sfp2', 'Te1/0/2'),
      sighting(3, 1, 2, 'ether9', null, 'cdp', 'Vlan10'),
    ];
    const g = buildTopologyGraph(base({ devices: [dev(1), dev(2)], links }));
    const between = g.edges.filter((e) => e.kind === 'discovered');
    expect(between.map((e) => e.label)).toEqual(['sfp1 ↔ Te1/0/1', 'sfp2 ↔ Te1/0/2']);
    expect(between[0].folded).toEqual(['ether9 ↔ Vlan10']);
    expect(between.map((e) => e.parallel)).toEqual([0, 1]);
  });

  it('with no cable, keeps the first logical one and folds the rest into it', () => {
    const c = foldLogical<Omit<GraphEdge, 'parallel'>>([
      { id: 'a', kind: 'discovered', source: '1', target: '2', label: 'vlan10', logical: 'logical' },
      { id: 'b', kind: 'discovered', source: '2', target: '1', label: 'vlan20', logical: 'logical' },
      { id: 'c', kind: 'discovered', source: '1', target: '3', label: 'ether1' },
    ]);
    expect(c.map((x) => x.id)).toEqual(['a', 'c']);
    expect(c[0].folded).toEqual(['vlan20']);
  });

  it('a WireGuard neighbour is a tunnel, drawn on its own', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1)],
      externalNodes: [{ id: 'ext-af', name: '254_AF', address: '', platform: '', mac: 'AF' }],
      links: [{ id: 1, from_device_id: 1, from_interface: 'WG1', from_interface_type: 'wg', neighbor_mac: 'AF', link_type: 'mndp', discovered_at: '' }],
    }));
    expect(g.edges.find((e) => e.kind === 'discovered')).toMatchObject({ target: 'ext-af', logical: 'tunnel' });
  });
});

describe('computers that speak LLDP (#367)', () => {
  const pc = (n: number, extra: Record<string, unknown> = {}) =>
    ({ id: `ext-pc${n}`, name: 'Unknown', address: '', platform: '', mac: `00:E0:4C:00:00:0${n}`, caps: '', host: true, ...extra });
  const pcLink = (n: number, from = 1): TopologyLink =>
    ({ id: 50 + n, from_device_id: from, from_interface: `ether${n}`, neighbor_mac: `00:E0:4C:00:00:0${n}`, link_type: 'lldp', discovered_at: '' });
  const ap = { id: 'ext-ap', name: 'AP-2F', address: '', platform: '', mac: 'AP', caps: 'bridge,wlan-ap' };
  const apLink: TopologyLink = { id: 90, from_device_id: 1, from_interface: 'ether24', neighbor_mac: 'AP', link_type: 'lldp', discovered_at: '' };
  const input = (over: Partial<GraphInput> = {}) => base({
    devices: [dev(1, 'ASW')],
    externalNodes: [pc(1), pc(2), pc(3), ap],
    links: [pcLink(1), pcLink(2), pcLink(3), apLink],
    ...over,
  });

  it('groups them into one chip under the switch, and leaves the AP alone', () => {
    const g = buildTopologyGraph(input());
    expect(g.nodes.filter((n) => n.kind === 'external').map((n) => n.id)).toEqual(['ext-ap']);
    const chip = g.nodes.find((n) => n.id === 'hosts-1')!;
    expect(chip).toMatchObject({ kind: 'clientGroup', data: { count: 3, hosts: true, expanded: false } });
    expect(chip.y).toBeGreaterThan(g.nodes.find((n) => n.id === '1')!.y);
    expect(g.edges.filter((e) => e.target.startsWith('ext-pc'))).toHaveLength(0);
    expect(g.edges.find((e) => e.target === 'hosts-1')).toMatchObject({ source: '1', kind: 'client' });
  });

  it('opened, the hosts hang from the chip with their ports', () => {
    const g = buildTopologyGraph(input({ expandedClients: new Set(['hosts-1']) }));
    const hosts = g.edges.filter((e) => e.target.startsWith('ext-pc'));
    expect(hosts.map((e) => [e.source, e.label])).toEqual([['hosts-1', 'ether1'], ['hosts-1', 'ether2'], ['hosts-1', 'ether3']]);
    const chip = g.nodes.find((n) => n.id === 'hosts-1')!;
    for (const n of g.nodes.filter((x) => x.id.startsWith('ext-pc'))) expect(n.y).toBeGreaterThan(chip.y);
  });

  it('opened, the hosts sit in a row under the chip, whatever was saved for them before chips', () => {
    // aziz: one host landed under the switch, the other far to the right,
    // where each had been saved when it had a card of its own.
    const g = buildTopologyGraph(input({
      expandedClients: new Set(['hosts-1']),
      saved: { '1': { x: 500, y: 100 }, 'ext-pc1': { x: 520, y: 260 }, 'ext-pc2': { x: 2400, y: 90 } },
    }));
    const chip = g.nodes.find((n) => n.id === 'hosts-1')!;
    const hosts = g.nodes.filter((x) => x.id.startsWith('ext-pc'));
    expect(new Set(hosts.map((h) => h.y)).size).toBe(1);
    expect(hosts[0].y).toBeGreaterThan(chip.y);
    for (const h of hosts) {
      expect(Math.abs(h.x - chip.x)).toBeLessThan(2 * 240);
      expect(h.pinned).toBeFalsy();
      expect(h.data.inChip).toBe(true);
    }
    expect(g.nodes.find((n) => n.id === 'ext-ap')!.data.inChip).toBeUndefined();
  });

  it('a lone host, a named one and one linked by hand keep their cards', () => {
    const lone = buildTopologyGraph(input({ externalNodes: [pc(1), ap], links: [pcLink(1), apLink] }));
    expect(lone.nodes.some((n) => n.id === 'ext-pc1')).toBe(true);
    expect(lone.nodes.some((n) => n.id === 'hosts-1')).toBe(false);

    const named = buildTopologyGraph(input({ neighbourOverrides: { 'ext-pc3': { name: 'reception', kind: 'computer' } } }));
    expect(named.nodes.find((n) => n.id === 'hosts-1')?.data.count).toBe(2);
    expect(named.nodes.some((n) => n.id === 'ext-pc3')).toBe(true);

    const hand = buildTopologyGraph(input({ handLinks: [{ id: 4, label: null, a: { kind: 'external', ref: 'ext-pc2', name: 'Unknown' }, b: { kind: 'device', ref: 1 } }] }));
    expect(hand.nodes.find((n) => n.id === 'hosts-1')?.data.count).toBe(2);
    expect(hand.nodes.some((n) => n.id === 'ext-pc2')).toBe(true);
  });

  it('clients learned behind a grouped host stay on the switch', () => {
    const g = buildTopologyGraph(input({
      clients: [{ mac: 'C', name: 'vm', ip: null, deviceId: 1, interface: 'ether1', wireless: false, portKnown: true, behindNeighbour: true }],
    }));
    expect(g.edges.find((e) => e.id === 'cgedge-1')).toMatchObject({ source: '1' });
  });
});

describe('mergeCables: the near end\'s bond (#367)', () => {
  it('carries each end\'s own bond in label order', () => {
    const far = new Map([[1, '2'], [2, '1']]);
    const edges = mergeCables([
      { id: 1, from_device_id: 1, from_interface: 'sfp-sfpplus9', to_interface: 'bridge/Po1/sfp-sfpplus2', from_interface_bond: 'Po9', discovered_at: '' },
    ] as never, far);
    expect(edges[0].label).toBe('sfp-sfpplus9 ↔ bridge/Po1/sfp-sfpplus2');
    expect(edges[0].bonds).toEqual(['Po9', undefined]);
    // Without bonds, nothing extra on the edge.
    expect(mergeCables([{ id: 2, from_device_id: 1, from_interface: 'ether1', to_interface: 'ether2', discovered_at: '' }] as never, far)[0].bonds).toBeUndefined();
  });
});

describe('OSPF links (#373)', () => {
  it('reaches an unmanaged OSPF router by its node id, and keeps the down state', () => {
    const g = buildTopologyGraph(base({
      devices: [dev(1)],
      externalNodes: [{ id: 'ext-ospf10999', name: '10.9.9.9', address: '172.16.5.2', platform: 'OSPF router', mac: '' }],
      links: [{ id: -2000000, from_device_id: 1, from_interface: 'gre-y', neighbor_address: '172.16.6.2',
        neighbor_identity: '10.9.9.9', link_type: 'ospf', external_id: 'ext-ospf10999', link_state: 'down', discovered_at: '' }],
    }));
    const edge = g.edges.find((e) => e.kind === 'discovered')!;
    expect([edge.source, edge.target].sort()).toEqual(['1', 'ext-ospf10999'].sort());
    expect(edge).toMatchObject({ ospf: true, down: true });
  });
});
