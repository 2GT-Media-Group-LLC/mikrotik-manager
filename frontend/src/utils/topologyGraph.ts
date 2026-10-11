/**
 * Builds the topology map from what /api/topology returns: which nodes exist,
 * how they hang together as trees, where each goes, and which edges to draw
 * (#115, #147). Pure: no React, no React Flow, so it can be tested; the page
 * turns the result into React Flow nodes and edges and owns all styling.
 */
import type {
  TopologyDevice, TopologyLink, ExternalTopologyNode, TopologyNode, HandLink, HandLinkEnd, TopologyClient,
} from '../types';
import { resolveStpRoot, type BridgeInfo, type RootVerdict } from './stpRoot';
import { layoutForest } from './topologyLayout';

/** Upstream verdict as returned by /api/topology; resolved server-side. */
export interface StpUpstream {
  deviceId: number;
  bridgeName: string;
  upstreamDeviceId: number | null;
  confidence: 'resolved' | 'is-root' | 'external-root' | 'ambiguous' | 'unknown';
  rootBridgeId: string | null;
}

export interface GraphInput {
  devices: TopologyDevice[];
  externalNodes: ExternalTopologyNode[];
  links: TopologyLink[];
  bridges: BridgeInfo[];
  upstreams: StpUpstream[];
  nodes: TopologyNode[];
  /** Links drawn by hand, between any two things on the map. */
  handLinks: HandLink[];
  /** Client devices, or null when they are hidden. */
  clients: TopologyClient[] | null;
  /** Node ids (devices, or unmanaged neighbours) whose clients are shown one by one rather than as a count. */
  expandedClients: Set<string>;
  /** Positions someone arranged by hand, in pixels, by node id (#147). */
  saved?: Record<string, { x: number; y: number }>;
}

export type GraphNodeKind = 'device' | 'external' | 'manual' | 'clientGroup' | 'client';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  /** What the node shows; shape depends on `kind`. */
  data: Record<string, unknown>;
  /** True when its position was arranged by hand and saved. */
  pinned?: boolean;
}

export type GraphEdgeKind = 'discovered' | 'hand' | 'client';

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  /** Second and later cables between the same two nodes use the side handles. */
  parallel: number;
  label?: string;
  /** Spanning-tree role of a discovered cable, the more telling of its two ends. */
  role?: 'root' | 'designated' | 'blocked';
  /** For deleting: the hand-drawn link's id. */
  deleteId?: number;
}

export interface GraphOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Managed devices with no connection of any kind. */
  orphanCount: number;
}

/** Pixel size of one layout slot and row. */
export const SLOT_W = 240;
export const ROW_H = 150;

export const nodeId = {
  device: (id: number) => String(id),
  manual: (id: number) => `node-${id}`,
  clientGroup: (deviceId: number | string) => `clients-${deviceId}`,
  client: (mac: string) => `client-${mac}`,
};

/** The map node an end of a hand-drawn link refers to. */
export function endId(end: HandLinkEnd): string {
  if (end.kind === 'device') return nodeId.device(Number(end.ref));
  if (end.kind === 'node') return nodeId.manual(Number(end.ref));
  return String(end.ref);
}

/** The end of a hand-drawn link a map node stands for, or null when it can't be linked (a client). */
export function endFor(id: string, name?: string): HandLinkEnd | null {
  if (/^\d+$/.test(id)) return { kind: 'device', ref: Number(id) };
  if (id.startsWith('node-')) return { kind: 'node', ref: Number(id.slice(5)) };
  if (id.startsWith('ext-')) return { kind: 'external', ref: id, name: name ?? null };
  return null;
}

/** Node kinds that sit above the network rather than in it. */
const UPSTREAM_KINDS = new Set(['modem', 'cloud']);

export function buildTopologyGraph(input: GraphInput): GraphOutput {
  const { devices, links, bridges, upstreams, nodes, handLinks, clients } = input;
  const deviceIds = new Set(devices.map((d) => nodeId.device(d.id)));
  // A neighbour linked by hand stays on the map, under the name it had when
  // linked, even after discovery stops seeing it, so its link can be removed.
  const externalNodes = [...input.externalNodes];
  const seenExt = new Set(externalNodes.map((e) => e.id));
  for (const hl of handLinks) {
    for (const end of [hl.a, hl.b]) {
      if (end.kind === 'external' && !seenExt.has(String(end.ref))) {
        seenExt.add(String(end.ref));
        externalNodes.push({ id: String(end.ref), name: end.name || 'Neighbour', address: '', platform: '', mac: '', caps: 'gone' });
      }
    }
  }
  const manualById = new Map(nodes.map((n) => [nodeId.manual(n.id), n]));
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string) => { if (!adj.has(id)) adj.set(id, new Set()); return adj.get(id)!; };
  const connect = (a: string, b: string) => { if (adj.has(a) && adj.has(b) && a !== b) { adj.get(a)!.add(b); adj.get(b)!.add(a); } };

  for (const d of devices) ensure(nodeId.device(d.id));
  for (const e of externalNodes) ensure(e.id);
  for (const n of nodes) ensure(nodeId.manual(n.id));

  // ── Discovered links, resolved to their far end ──────────────────────────
  const discovered = links.filter((l) => l.link_type !== 'manual');
  const farEnd = new Map<number, string>();
  for (const link of discovered) {
    if (!link.from_device_id) continue;
    let dst: string | null = null;
    if (link.to_device_id) dst = nodeId.device(link.to_device_id);
    else {
      const ext = externalNodes.find((e) =>
        (link.neighbor_address && e.address === link.neighbor_address)
        || (link.neighbor_mac && e.mac === link.neighbor_mac)
        || (!link.neighbor_address && !link.neighbor_mac && link.neighbor_identity && e.name === link.neighbor_identity));
      if (ext) dst = ext.id;
    }
    if (dst) { farEnd.set(link.id, dst); connect(nodeId.device(link.from_device_id), dst); }
  }
  for (const hl of handLinks) connect(endId(hl.a), endId(hl.b));

  // ── Clients hang off the device they connect through ─────────────────────
  const clientNodes: GraphNode[] = [];
  const clientEdges: GraphEdge[] = [];
  if (clients) {
    // A client learned on a port facing an unmanaged neighbour is behind that
    // neighbour, so it hangs there rather than on the switch that saw it.
    const neighbourOnPort = new Map<string, string>();
    for (const l of discovered) {
      const far = farEnd.get(l.id);
      if (l.from_device_id && l.from_interface && far && !deviceIds.has(far)) {
        neighbourOnPort.set(`${l.from_device_id}:${l.from_interface.toLowerCase()}`, far);
      }
    }
    const byDevice = new Map<string, TopologyClient[]>();
    for (const c of clients) {
      const dev = nodeId.device(c.deviceId);
      if (!deviceIds.has(dev)) continue;
      const behind = c.behindNeighbour ? neighbourOnPort.get(`${c.deviceId}:${(c.interface ?? '').toLowerCase()}`) : undefined;
      const at = behind ?? dev;
      if (!byDevice.has(at)) byDevice.set(at, []);
      byDevice.get(at)!.push(c);
    }
    for (const [dev, list] of byDevice) {
      // The count chip always stays: open, its clients hang from it as one
      // block, so they never mix with the device's real children in a row.
      const group = nodeId.clientGroup(dev);
      const open = input.expandedClients.has(dev);
      ensure(group); connect(dev, group);
      clientNodes.push({
        id: group, kind: 'clientGroup', x: 0, y: 0,
        data: { deviceId: dev, count: list.length, wireless: list.filter((c) => c.wireless).length, expanded: open },
      });
      clientEdges.push({ id: `cgedge-${dev}`, kind: 'client', source: dev, target: group, parallel: 0 });
      if (!open) continue;
      for (const c of list) {
        const id = nodeId.client(c.mac);
        ensure(id); connect(group, id);
        clientNodes.push({ id, kind: 'client', x: 0, y: 0, data: { ...c } });
        clientEdges.push({ id: `cedge-${c.mac}`, kind: 'client', source: group, target: id, parallel: 0, label: c.interface ?? undefined });
      }
    }
  }

  // ── Spanning-tree parents, where the switches agree on one ───────────────
  const stpParent = new Map<string, string>();
  for (const u of upstreams) {
    if (u.confidence === 'resolved' && u.upstreamDeviceId != null) stpParent.set(nodeId.device(u.deviceId), nodeId.device(u.upstreamDeviceId));
  }
  const stpRoots = new Set<string>();
  const notes = new Map<string, string>();

  const pickRoot = (comp: string[]): string => {
    const managed = comp.filter((id) => deviceIds.has(id));
    let root: string | null = null;
    let verdict: RootVerdict | null = null;
    if (bridges.length && managed.length) {
      verdict = resolveStpRoot(managed, bridges);
      if (verdict.deviceId && managed.includes(verdict.deviceId)) { stpRoots.add(verdict.deviceId); root = verdict.deviceId; }
    }
    if (!root) {
      const inComp = new Set(comp);
      let bestScore = -1;
      for (const id of comp) {
        const score = (deviceIds.has(id) ? 1000 : 0) + [...(adj.get(id) || [])].filter((x) => inComp.has(x)).length;
        if (score > bestScore) { root = id; bestScore = score; }
      }
    }
    // A modem or "the internet" drawn by hand goes above the device it feeds.
    const above = [...(adj.get(root!) || [])].find((n) => UPSTREAM_KINDS.has(manualById.get(n)?.kind ?? ''));
    if (verdict?.confidence === 'external' && root) {
      notes.set(root, `Spanning-tree root is outside the managed fleet${verdict.rootBridgeId ? ` (${verdict.rootBridgeId})` : ''}`);
    }
    return above ?? root!;
  };

  // ── Components, each a tree ───────────────────────────────────────────────
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of adj.keys()) {
    if (visited.has(id)) continue;
    const stack = [id];
    const comp: string[] = [];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n); comp.push(n);
      for (const m of adj.get(n) || []) if (!visited.has(m)) stack.push(m);
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  const loose = components.filter((c) => c.length === 1).map((c) => c[0]);
  const trees = components.filter((c) => c.length > 1).map((comp) => {
    const inComp = new Set(comp);
    const root = pickRoot(comp);
    const children = new Map<string, string[]>([[root, []]]);
    const placed = new Set([root]);
    const queue = [root];
    // Where spanning tree names a node's upstream, that is its parent; the rest
    // attach to whichever neighbour reaches them first.
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of adj.get(cur) || []) {
        if (!inComp.has(n) || placed.has(n)) continue;
        const real = stpParent.get(n);
        if (real && real !== cur && inComp.has(real) && !placed.has(real)) continue;
        placed.add(n); children.set(n, []); children.get(cur)!.push(n); queue.push(n);
      }
    }
    // Anything left (its STP parent was never reached) attaches to any placed neighbour.
    let left = comp.filter((id) => !placed.has(id));
    while (left.length) {
      const before = left.length;
      for (const id of [...left]) {
        const at = [...(adj.get(id) || [])].find((n) => placed.has(n));
        if (!at) continue;
        placed.add(id); children.set(id, []); children.get(at)!.push(id);
        left = left.filter((x) => x !== id);
      }
      if (left.length === before) break;
    }
    return { rootId: root, children };
  });

  // Clients and their count chips are smaller cards than devices.
  const clientIds = new Set(clientNodes.map((c) => c.id));
  const laid = layoutForest(trees, loose, undefined, undefined,
    (id) => (clientIds.has(id) ? { w: 0.75, h: 0.5 } : { w: 1, h: 1 }));
  // Automatic positions, in pixels.
  const auto = (id: string) => {
    const p = laid.positions.get(id) ?? { x: 0, y: 0 };
    return { x: p.x * SLOT_W, y: p.y * ROW_H };
  };
  // Where someone arranged the map by hand, that wins. A node with no saved
  // place but a saved parent goes where the layout would put it relative to
  // that parent, so a new switch or an opened client list appears next to what
  // it hangs from. Anything else unsaved goes below the arranged part.
  const saved = input.saved ?? {};
  const parentOf = new Map<string, string>();
  for (const t of trees) for (const [p, kids] of t.children) for (const k of kids) parentOf.set(k, p);
  const placed = new Map<string, { x: number; y: number }>();
  const savedVals = Object.values(saved);
  const anySaved = savedVals.length > 0;
  const belowY = anySaved ? Math.max(...savedVals.map((v) => v.y)) + ROW_H * 1.5 : 0;
  const unsavedTop = (() => {
    const ys = [...adj.keys()].filter((id) => !saved[id]).map((id) => auto(id).y);
    return ys.length ? Math.min(...ys) : 0;
  })();
  const resolve = (id: string, depth = 0): { x: number; y: number } => {
    const hit = placed.get(id);
    if (hit) return hit;
    let out: { x: number; y: number };
    if (saved[id]) out = saved[id];
    else {
      const parent = parentOf.get(id);
      if (parent && depth < 64 && hasSavedAncestor(parent)) {
        const pp = resolve(parent, depth + 1);
        const a = auto(id); const ap = auto(parent);
        out = { x: pp.x + (a.x - ap.x), y: pp.y + (a.y - ap.y) };
      } else if (anySaved) {
        const a = auto(id);
        out = { x: a.x, y: belowY + (a.y - unsavedTop) };
      } else out = auto(id);
    }
    placed.set(id, out);
    return out;
  };
  function hasSavedAncestor(id: string): boolean {
    let cur: string | undefined = id;
    for (let i = 0; cur && i < 64; i++) { if (saved[cur]) return true; cur = parentOf.get(cur); }
    return false;
  }
  const pos = (id: string) => resolve(id);

  const hasEdge = new Set<string>();
  const outNodes: GraphNode[] = [
    ...devices.map((d) => {
      const id = nodeId.device(d.id);
      return {
        id, kind: 'device' as const, ...pos(id),
        data: { ...d, isRootBridge: stpRoots.has(id), stpNote: notes.get(id) ?? null, orphan: loose.includes(id) } as Record<string, unknown>,
      };
    }),
    ...externalNodes.map((e) => ({ id: e.id, kind: 'external' as const, ...pos(e.id), data: { ...e } as Record<string, unknown> })),
    ...nodes.map((n) => {
      const id = nodeId.manual(n.id);
      return { id, kind: 'manual' as const, ...pos(id), data: { ...n, orphan: loose.includes(id) } as Record<string, unknown> };
    }),
    ...clientNodes.map((c) => ({ ...c, ...pos(c.id) })),
  ].map((n) => (saved[n.id] ? { ...n, pinned: true } : n));

  // ── Edges ─────────────────────────────────────────────────────────────────
  const edges: GraphEdge[] = [];
  const pairCount = new Map<string, number>();
  const nextParallel = (a: string, b: string) => {
    const k = [a, b].sort().join('|');
    const n = pairCount.get(k) ?? 0;
    pairCount.set(k, n + 1);
    hasEdge.add(a); hasEdge.add(b);
    return n;
  };

  for (const cable of mergeCables(discovered, farEnd)) {
    edges.push({ ...cable, parallel: nextParallel(cable.source, cable.target) });
  }
  for (const hl of handLinks) {
    const src = endId(hl.a);
    const dst = endId(hl.b);
    if (!adj.has(src) || !adj.has(dst)) continue;
    edges.push({ id: `hand-${hl.id}`, kind: 'hand', source: src, target: dst, label: hl.label ?? undefined, deleteId: hl.id, parallel: nextParallel(src, dst) });
  }
  for (const e of clientEdges) edges.push(e);

  const orphanCount = devices.filter((d) => !hasEdge.has(nodeId.device(d.id)) && loose.includes(nodeId.device(d.id))).length;
  return { nodes: outNodes, edges, orphanCount };
}

/**
 * One edge per cable. Each end of a cable reports it (A sees B on ether5, B sees
 * A on sfp1), and a pair of switches can be joined by two cables, one of them
 * blocked by spanning tree. Two reports are the same cable when their ports
 * match up; the cable takes the more telling role of its two ends.
 */
export function mergeCables(
  discovered: TopologyLink[],
  farEnd: Map<number, string>,
): Omit<GraphEdge, 'parallel'>[] {
  interface Cable { a: string; b: string; aPort?: string; bPort?: string; roles: string[]; ids: number[] }
  const cables: Cable[] = [];
  for (const l of discovered) {
    const dst = farEnd.get(l.id);
    if (!l.from_device_id || !dst) continue;
    const src = String(l.from_device_id);
    const fromPort = l.from_interface || undefined;
    const toPort = l.to_interface || undefined;
    const same = cables.find((c) => {
      if (c.a === src && c.b === dst) {
        // The same end reported twice (LLDP and MNDP on one port).
        return !fromPort || !c.aPort || c.aPort === fromPort;
      }
      if (c.a === dst && c.b === src) {
        // The other end: its ports must agree with this report where both are known.
        const portsAgree = (!fromPort || !c.bPort || c.bPort === fromPort) && (!toPort || !c.aPort || c.aPort === toPort);
        return portsAgree;
      }
      return false;
    });
    if (same) {
      if (same.a === src) { same.aPort ??= fromPort; same.bPort ??= toPort; } else { same.bPort ??= fromPort; same.aPort ??= toPort; }
      if (l.stp_role) same.roles.push(l.stp_role);
      same.ids.push(l.id);
    } else {
      cables.push({ a: src, b: dst, aPort: fromPort, bPort: toPort, roles: l.stp_role ? [l.stp_role] : [], ids: [l.id] });
    }
  }
  const used = new Map<string, number>();
  return cables.map((c) => {
    const role = c.roles.some((r) => r === 'alternate' || r === 'backup') ? 'blocked'
      : c.roles.includes('root') ? 'root'
        : c.roles.includes('designated') ? 'designated' : undefined;
    const ports = c.aPort && c.bPort ? `${c.aPort} ↔ ${c.bPort}` : c.aPort ?? c.bPort ?? '';
    // Built from the ends, not a row id: discovery rewrites its rows on every
    // poll, and a link's saved attachment points must survive that.
    const ends = [`${c.a}@${c.aPort ?? ''}`, `${c.b}@${c.bPort ?? ''}`].sort();
    const base = `cable:${ends.join('|')}`.replace(/[^A-Za-z0-9:_.|@-]/g, '_');
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    // Two cables between the same switches with ports unknown would share an id.
    const id = n ? `${base}.${n}` : base;
    return { id, kind: 'discovered' as const, source: c.a, target: c.b, label: ports || undefined, role };
  });
}
