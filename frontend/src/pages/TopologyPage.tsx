import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  EdgeLabelRenderer,
  BaseEdge,
  getStraightPath,
  type Node,
  type Edge,
  type Connection,
  type EdgeProps,
  BackgroundVariant,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RefreshCw, GitBranch, Link2, Link2Off, X, AlertCircle } from 'lucide-react';
import { topologyApi } from '../services/api';
import type { TopologyDevice, TopologyLink, ExternalTopologyNode } from '../types';
import clsx from 'clsx';
import { useThemeStore } from '../store/themeStore';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const statusColor: Record<string, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  unknown: '#94a3b8',
};

const deviceIcon: Record<string, string> = {
  router: '⇌',
  switch: '⊞',
  wireless_ap: '⊙',
  other: '◈',
};

function capsLabel(caps: string | undefined): string {
  if (!caps) return '';
  const c = caps.toLowerCase();
  if (c.includes('bridge'))   return 'Switch';
  if (c.includes('router'))   return 'Router';
  if (c.includes('wlan-ap'))  return 'AP';
  if (c.includes('telephone')) return 'Phone';
  return '';
}

const handleStyle = { opacity: 0, width: 10, height: 10, zIndex: 50 };
const handleStyleVisible = { width: 12, height: 12, background: '#3b82f6', border: '2px solid #fff', zIndex: 50, cursor: 'crosshair' };

// ─── Node components ──────────────────────────────────────────────────────────

function DeviceNode({ data }: { data: Record<string, unknown> }) {
  const device  = data as unknown as TopologyDevice & { isRootBridge: boolean; connectMode: boolean; orphan: boolean };
  const hStyle  = device.connectMode ? handleStyleVisible : handleStyle;
  return (
    <div
      className={clsx('card px-3 py-2 min-w-[148px] text-xs shadow-md select-none', device.orphan && 'opacity-60')}
      style={{
        borderColor: device.isRootBridge ? '#f59e0b' : statusColor[device.status] ?? '#94a3b8',
        borderWidth: device.isRootBridge ? 2 : 1,
      }}
    >
      <Handle type="target" position={Position.Top}    isConnectable={!!device.connectMode} style={hStyle} />
      <Handle type="target" position={Position.Left}   isConnectable={!!device.connectMode} style={hStyle} />
      <Handle type="source" position={Position.Bottom} isConnectable={!!device.connectMode} style={hStyle} />
      <Handle type="source" position={Position.Right}  isConnectable={!!device.connectMode} style={hStyle} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none">{deviceIcon[device.device_type] || '◈'}</span>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor[device.status] ?? '#94a3b8' }} />
        <span className="font-semibold truncate text-gray-900 dark:text-white">{device.name}</span>
        {device.isRootBridge && <span title="Root Bridge" className="ml-auto text-amber-500 font-bold">★</span>}
      </div>
      <div className="font-mono text-gray-400 dark:text-slate-500">{device.ip_address}</div>
      {device.model && <div className="text-gray-400 dark:text-slate-500 truncate">{device.model}</div>}
      {device.orphan && <div className="mt-1 text-orange-400 dark:text-orange-500 text-[10px]">No known connections</div>}
    </div>
  );
}

function ExternalNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as ExternalTopologyNode & { connectMode: boolean };
  if (node.caps === 'segment') {
    return (
      <div className="px-3 py-2 min-w-[140px] text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 shadow-sm select-none" style={{ border: '2px dashed #f59e0b' }}>
        <Handle type="target" position={Position.Top}    isConnectable={false} style={handleStyle} />
        <Handle type="target" position={Position.Left}   isConnectable={false} style={handleStyle} />
        <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />
        <Handle type="source" position={Position.Right}  isConnectable={false} style={handleStyle} />
        <div className="font-semibold text-amber-700 dark:text-amber-400 mb-0.5">⊕ Shared Segment</div>
        {node.platform && <div className="text-amber-600 dark:text-amber-500">{node.platform}</div>}
        <div className="text-amber-400 dark:text-amber-600 mt-0.5 text-[10px]">Unmanaged L2 switch / hub</div>
      </div>
    );
  }
  const cl = capsLabel(node.caps);
  return (
    <div className="px-3 py-2 min-w-[130px] text-xs rounded-lg bg-gray-100 dark:bg-slate-700/60 shadow-sm select-none" style={{ border: '1.5px dashed #94a3b8' }}>
      <Handle type="target" position={Position.Top}    isConnectable={false} style={handleStyle} />
      <Handle type="target" position={Position.Left}   isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Right}  isConnectable={false} style={handleStyle} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none text-gray-400">◌</span>
        <span className="font-semibold truncate text-gray-600 dark:text-slate-300">{node.name}{cl ? ` (${cl})` : ''}</span>
      </div>
      {node.address && <div className="font-mono text-gray-400 dark:text-slate-500">{node.address}</div>}
      {node.platform && <div className="text-gray-400 dark:text-slate-500 truncate">{node.platform}</div>}
      <div className="text-gray-300 dark:text-slate-600 mt-0.5">External</div>
    </div>
  );
}

// ─── Manual Edge with delete button ──────────────────────────────────────────

function ManualEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const onDelete = (data as { onDelete?: (id: string) => void } | undefined)?.onDelete;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '6,3' }} />
      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-all flex items-center gap-1"
          style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
        >
          <span className="text-[9px] bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-1 rounded">manual</span>
          {onDelete && (
            <button
              className="w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
              style={{ fontSize: 8, lineHeight: 1 }}
              onClick={() => onDelete(id)}
              title="Remove this manual connection"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { deviceNode: DeviceNode, externalNode: ExternalNode };
const edgeTypes = { manualEdge: ManualEdge };

// ─── Layout constants ──────────────────────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 80;
const NODE_LAYOUT_W = 220;
const NODE_LAYOUT_H = 110;
const H_GAP = 60;
const V_GAP = 90;
const COMPONENT_GAP = 140;
const NODE_SLOT = NODE_LAYOUT_W + H_GAP;
const OVERLAP_SEP = 16;
const ORPHAN_ROW_GAP = 160;

// ─── Layout helpers ───────────────────────────────────────────────────────────

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function resolveOverlaps(positions: Map<string, { x: number; y: number }>, maxIt = 100): void {
  const ids = [...positions.keys()];
  if (ids.length < 2) return;
  const w = NODE_LAYOUT_W, h = NODE_LAYOUT_H;
  for (let round = 0; round < maxIt; round++) {
    let moved = false;
    const boxes = ids.map((id) => { const p = positions.get(id)!; return { id, x: p.x, y: p.y, w, h }; });
    boxes.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (!rectsOverlap(A, B)) continue;
        const dx = Math.abs((B.x + B.w / 2) - (A.x + A.w / 2));
        const dy = Math.abs((B.y + B.h / 2) - (A.y + A.h / 2));
        if (dy <= dx * 0.85) {
          const ny = A.y + A.h + OVERLAP_SEP;
          if (ny !== B.y) { positions.set(B.id, { x: B.x, y: ny }); B.y = ny; moved = true; }
        } else {
          const shift = B.x >= A.x ? 1 : -1;
          const nx = B.x + shift * (Math.min(w, h) / 2 + OVERLAP_SEP);
          if (nx !== B.x) { positions.set(B.id, { x: nx, y: B.y }); B.x = nx; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
}

// ─── Graph builder ────────────────────────────────────────────────────────────

function buildGraph(
  devices: TopologyDevice[],
  externalNodes: ExternalTopologyNode[],
  links: TopologyLink[],
  segConns: { src: string; dst: string; port: string }[],
  manualLinkIds: { id: number; from_device_id: number; to_device_id: number }[],
  connectMode: boolean,
  onDeleteManual: (edgeId: string) => void,
): { nodes: Node[]; edges: Edge[] } {

  const manualLinks  = links.filter((l) => l.link_type === 'manual');
  const activeLinks  = links.filter((l) => l.link_type !== 'manual');
  const allExtNodes  = externalNodes;

  // ── Build adjacency (for layout) ────────────────────────────────────────────
  const deviceIds = new Set(devices.map((d) => String(d.id)));
  const adj = new Map<string, Set<string>>();
  for (const d of devices)    adj.set(String(d.id), new Set());
  for (const e of allExtNodes) adj.set(e.id, new Set());

  const linkToExtId = new Map<number, string>();
  for (const link of activeLinks) {
    if (!link.from_device_id) continue;
    const src = String(link.from_device_id);
    let dst: string | null = null;
    if (link.to_device_id) {
      dst = String(link.to_device_id);
    } else {
      const ext = allExtNodes.find(
        (e) => (link.neighbor_address && e.address === link.neighbor_address) ||
               (link.neighbor_mac && e.mac === link.neighbor_mac) ||
               (!link.neighbor_address && !link.neighbor_mac && link.neighbor_identity && e.name === link.neighbor_identity)
      );
      if (ext) { dst = ext.id; linkToExtId.set(link.id, ext.id); }
    }
    if (dst && adj.has(src) && adj.has(dst)) {
      adj.get(src)!.add(dst); adj.get(dst)!.add(src);
    }
  }
  for (const { src, dst } of segConns) {
    if (adj.has(src) && adj.has(dst)) {
      adj.get(src)!.add(dst); adj.get(dst)!.add(src);
    }
  }
  // Manual links also participate in layout so they don't stay visually orphaned
  for (const ml of manualLinks) {
    const src = String(ml.from_device_id);
    const dst = String(ml.to_device_id);
    if (adj.has(src) && adj.has(dst)) {
      adj.get(src)!.add(dst); adj.get(dst)!.add(src);
    }
  }

  // ── STP root detection ───────────────────────────────────────────────────────
  const hasStp = links.some((l) => l.stp_role);
  const haveRootPort = new Set(links.filter((l) => l.stp_role === 'root').map((l) => String(l.from_device_id)));
  const stpRootId = hasStp ? devices.map((d) => String(d.id)).find((id) => !haveRootPort.has(id)) ?? '' : '';

  function pickRoot(componentIds: string[]): string {
    if (hasStp) {
      const r = componentIds.find((id) => deviceIds.has(id) && !haveRootPort.has(id));
      if (r) return r;
    }
    const inComp = new Set(componentIds);
    let best = componentIds[0], bestScore = -1;
    for (const id of componentIds) {
      const n = [...(adj.get(id) || [])].filter((x) => inComp.has(x)).length;
      const score = (deviceIds.has(id) ? 1000 : 0) + n;
      if (score > bestScore) { best = id; bestScore = score; }
    }
    return best;
  }

  // ── Connected components ─────────────────────────────────────────────────────
  const allIds = [...devices.map((d) => String(d.id)), ...allExtNodes.map((e) => e.id)];
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of allIds) {
    if (visited.has(id)) continue;
    const stack = [id], comp: string[] = [];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n); comp.push(n);
      for (const m of adj.get(n) || []) if (!visited.has(m)) stack.push(m);
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);

  // Identify singleton device nodes (orphans) — separate them into an "orphan row"
  const orphanIds = new Set<string>(
    components.filter((c) => c.length === 1 && deviceIds.has(c[0])).map((c) => c[0])
  );
  const connectedComponents = components.filter((c) => c.length > 1 || !deviceIds.has(c[0]));
  const orphanComponents    = components.filter((c) => c.length === 1 && deviceIds.has(c[0]));

  // ── Tidy-tree layout ─────────────────────────────────────────────────────────
  const positions = new Map<string, { x: number; y: number }>();
  let componentOffsetX = 0;
  let globalMaxDepth = 0;

  for (const comp of connectedComponents) {
    if (!comp.length) continue;
    const compSet = new Set(comp);
    const rootId  = pickRoot(comp);

    const depth    = new Map<string, number>();
    const children = new Map<string, string[]>();
    const bfs = [rootId];
    depth.set(rootId, 0);
    children.set(rootId, []);
    while (bfs.length) {
      const curr = bfs.shift()!;
      for (const n of adj.get(curr) || []) {
        if (!compSet.has(n) || depth.has(n)) continue;
        depth.set(n, depth.get(curr)! + 1);
        children.set(n, []);
        children.get(curr)!.push(n);
        bfs.push(n);
      }
    }

    for (const kids of children.values()) {
      kids.sort((a, b) => {
        const da = deviceIds.has(a) ? 0 : 1, db = deviceIds.has(b) ? 0 : 1;
        if (da !== db) return da - db;
        return (adj.get(b)?.size || 0) - (adj.get(a)?.size || 0);
      });
    }

    const slotWidth = new Map<string, number>();
    function computeWidth(id: string): number {
      const kids = children.get(id) || [];
      if (!kids.length) { slotWidth.set(id, 1); return 1; }
      let total = 0;
      for (const k of kids) total += computeWidth(k);
      slotWidth.set(id, Math.max(1, total));
      return slotWidth.get(id)!;
    }
    computeWidth(rootId);

    function assign(id: string, leftSlot: number): void {
      const kids = children.get(id) || [];
      if (!kids.length) {
        positions.set(id, {
          x: componentOffsetX + (leftSlot + 0.5) * NODE_SLOT - NODE_W / 2,
          y: (depth.get(id) || 0) * (NODE_H + V_GAP),
        });
        return;
      }
      let cursor = leftSlot;
      for (const k of kids) { assign(k, cursor); cursor += slotWidth.get(k)!; }
      const fk = positions.get(kids[0])!, lk = positions.get(kids[kids.length - 1])!;
      positions.set(id, { x: (fk.x + lk.x) / 2, y: (depth.get(id) || 0) * (NODE_H + V_GAP) });
    }
    assign(rootId, 0);

    let compMaxDepth = 0;
    for (const id of comp) {
      const d = depth.get(id);
      if (d !== undefined) compMaxDepth = Math.max(compMaxDepth, d);
    }
    globalMaxDepth = Math.max(globalMaxDepth, compMaxDepth);
    componentOffsetX += (slotWidth.get(rootId) || 1) * NODE_SLOT + COMPONENT_GAP;
  }

  // ── Orphan row at the bottom ─────────────────────────────────────────────────
  const orphanY = (globalMaxDepth + 1) * (NODE_H + V_GAP) + ORPHAN_ROW_GAP;
  let orphanX   = 0;
  for (const [oc] of orphanComponents.map((c) => [c[0]])) {
    positions.set(oc, { x: orphanX, y: orphanY });
    orphanX += NODE_SLOT;
  }

  // Center horizontally
  if (positions.size) {
    const xs = [...positions.values()].map((p) => p.x);
    const shift = (Math.min(...xs) + Math.max(...xs)) / 2;
    for (const [id, p] of positions) positions.set(id, { x: p.x - shift, y: p.y });
  }

  resolveOverlaps(positions);

  // ── React Flow nodes ─────────────────────────────────────────────────────────
  const nodes: Node[] = [
    ...devices.map((d) => ({
      id: String(d.id),
      type: 'deviceNode',
      position: positions.get(String(d.id)) ?? { x: 0, y: 0 },
      data: { ...d, isRootBridge: hasStp && String(d.id) === stpRootId, connectMode, orphan: orphanIds.has(String(d.id)) } as unknown as Record<string, unknown>,
    })),
    ...allExtNodes.map((e) => ({
      id: e.id,
      type: 'externalNode',
      position: positions.get(e.id) ?? { x: 0, y: orphanY },
      data: { ...e, connectMode } as unknown as Record<string, unknown>,
    })),
  ];

  // ── React Flow edges ─────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const edges: Edge[] = [];

  for (const link of activeLinks) {
    if (!link.from_device_id) continue;
    const src = String(link.from_device_id);
    const dst = link.to_device_id ? String(link.to_device_id) : (linkToExtId.get(link.id) ?? null);
    if (!dst) continue;

    const edgeKey = [src, dst].sort().join('--');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    let stroke = '#94a3b8', strokeDasharray: string | undefined, animated = false;
    if (link.stp_role === 'root')      { stroke = '#3b82f6'; animated = true; }
    else if (link.stp_role === 'designated') { stroke = '#22c55e'; }
    else if (link.stp_role === 'alternate' || link.stp_role === 'backup') {
      stroke = '#ef4444'; strokeDasharray = '6,3';
    }

    const stpLabel  = link.stp_role ? ` [${link.stp_role}]` : '';
    const portLabel = link.from_interface
      ? (link.to_interface ? `${link.from_interface} ↔ ${link.to_interface}` : link.from_interface)
      : (link.to_interface ?? '');

    edges.push({
      id: `edge-${link.id}`,
      source: src,
      target: dst,
      label: (portLabel + stpLabel) || undefined,
      labelStyle: { fontSize: 10, fill: 'var(--topology-edge-label, #64748b)' },
      className: 'topology-edge',
      style: { stroke, strokeWidth: 2, strokeDasharray },
      animated,
    });
  }

  // Shared-segment edges
  for (const { src, dst, port } of segConns) {
    const edgeKey = [src, dst].sort().join('--');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    if (!adj.has(src) || !adj.has(dst)) continue;
    edges.push({
      id: `segedge-${src}-${dst}`,
      source: src,
      target: dst,
      label: port || undefined,
      labelStyle: { fontSize: 10, fill: '#b45309' },
      className: 'topology-edge topology-edge--segment',
      style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5,3' },
      animated: false,
    });
  }

  // Manual edges
  for (const ml of manualLinks) {
    const src = String(ml.from_device_id);
    const dst = String(ml.to_device_id);
    const edgeKey = [src, dst].sort().join('--');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    // Find the real manual link id (positive int) for deletion
    const realId = manualLinkIds.find(
      (m) => (m.from_device_id === ml.from_device_id && m.to_device_id === ml.to_device_id) ||
             (m.from_device_id === ml.to_device_id  && m.to_device_id === ml.from_device_id)
    )?.id;

    edges.push({
      id: `manual-${src}-${dst}`,
      source: src,
      target: dst,
      type: 'manualEdge',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#8b5cf6' },
      data: { onDelete: realId !== undefined ? () => onDeleteManual(String(realId)) : undefined },
    });
  }

  return { nodes, edges };
}

// ─── Main page component ──────────────────────────────────────────────────────

export default function TopologyPage() {
  const theme = useThemeStore((s) => s.theme);
  const queryClient = useQueryClient();
  const [connectMode, setConnectMode] = useState(false);
  const pendingEdgeRef = useRef<{ from_device_id: number; to_device_id: number } | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['topology'],
    queryFn: () => topologyApi.get().then((r) => r.data),
  });

  const discoverMutation = useMutation({
    mutationFn: () => topologyApi.discover(),
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const createManualLinkMutation = useMutation({
    mutationFn: ({ from_device_id, to_device_id }: { from_device_id: number; to_device_id: number }) =>
      topologyApi.createManualLink(from_device_id, to_device_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topology'] }),
  });

  const deleteManualLinkMutation = useMutation({
    mutationFn: (id: number) => topologyApi.deleteManualLink(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['topology'] }),
  });

  // Depend on the stable `.mutate` function rather than the whole mutation object.
  // TanStack Query recreates the mutation result object on every render but keeps
  // `.mutate` referentially stable, so this keeps handleDeleteManual stable too.
  // Depending on the whole object would make handleDeleteManual — and therefore the
  // `graph` memo and the node/edge sync effect below — re-run on every render,
  // causing an infinite setNodes/setEdges loop (React error #185).
  const deleteManualLinkMutate = deleteManualLinkMutation.mutate;
  const handleDeleteManual = useCallback((edgeId: string) => {
    const id = parseInt(edgeId);
    if (!isNaN(id)) deleteManualLinkMutate(id);
  }, [deleteManualLinkMutate]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const graph = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    return buildGraph(
      (data.devices as TopologyDevice[]) || [],
      (data.externalNodes as ExternalTopologyNode[]) || [],
      (data.links as TopologyLink[]) || [],
      (data.segConns as { src: string; dst: string; port: string }[]) || [],
      (data.manualLinkIds as { id: number; from_device_id: number; to_device_id: number }[]) || [],
      connectMode,
      handleDeleteManual,
    );
  }, [data, connectMode, handleDeleteManual]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const srcId = parseInt(connection.source ?? '');
      const dstId = parseInt(connection.target ?? '');
      if (isNaN(srcId) || isNaN(dstId) || srcId === dstId) return;

      // Optimistically add the edge so the user sees it immediately
      setEdges((eds) => addEdge({
        ...connection,
        id: `manual-${srcId}-${dstId}-pending`,
        type: 'manualEdge',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#8b5cf6' },
        data: { onDelete: undefined },
      }, eds));

      pendingEdgeRef.current = { from_device_id: srcId, to_device_id: dstId };
      createManualLinkMutation.mutate({ from_device_id: srcId, to_device_id: dstId });
    },
    [setEdges, createManualLinkMutation]
  );

  if (isLoading) {
    return <div className="flex items-center justify-center h-96 text-gray-400">Loading topology…</div>;
  }

  const hasData = (data?.devices?.length ?? 0) > 0;
  const hasStp  = (data?.links as TopologyLink[])?.some((l) => l.stp_role);
  const links   = (data?.links as TopologyLink[]) ?? [];
  const orphanCount = (data?.devices?.length ?? 0) > 0
    ? (data!.devices as TopologyDevice[]).filter((d) => {
        const id = String(d.id);
        return !links.some((l) => String(l.from_device_id) === id || String(l.to_device_id) === id) &&
               !((data!.manualLinkIds ?? []) as { from_device_id: number; to_device_id: number }[]).some(
                 (m) => m.from_device_id === d.id || m.to_device_id === d.id
               );
      }).length
    : 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Network Topology</h1>
        <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
          <button
            onClick={() => setConnectMode((v) => !v)}
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
              connectMode
                ? 'bg-purple-600 text-white border-purple-700 hover:bg-purple-500'
                : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40'
            )}
            title={connectMode ? 'Exit connect mode' : 'Enable connect mode to manually draw links between devices'}
          >
            {connectMode ? <Link2Off className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
            {connectMode ? 'Exit Connect Mode' : 'Connect Mode'}
          </button>
          <button
            onClick={() => discoverMutation.mutate()}
            disabled={discoverMutation.isPending}
            className="btn-secondary flex items-center gap-2"
          >
            <RefreshCw className={clsx('w-4 h-4', discoverMutation.isPending && 'animate-spin')} />
            Discover
          </button>
        </div>
      </div>

      {/* Connect mode hint */}
      {connectMode && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 text-sm text-purple-700 dark:text-purple-300">
          <Link2 className="w-4 h-4 flex-shrink-0" />
          Drag from any device&apos;s blue handle to another device to manually draw a connection.
          Click the red × on a purple dashed edge to remove it.
        </div>
      )}

      {/* Orphan warning */}
      {orphanCount > 0 && !connectMode && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-sm text-orange-700 dark:text-orange-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {orphanCount} device{orphanCount !== 1 ? 's have' : ' has'} no discovered connections.
          Use <strong className="mx-1">Connect Mode</strong> to draw links manually, or run <strong className="mx-1">Discover</strong> to re-scan.
        </div>
      )}

      {!hasData ? (
        <div className="card p-16 flex flex-col items-center gap-4 text-center">
          <GitBranch className="w-16 h-16 text-gray-300 dark:text-slate-600" />
          <div>
            <p className="font-medium text-gray-700 dark:text-slate-300">No topology data yet</p>
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
              Add devices and click &quot;Discover&quot; to map your network via LLDP neighbors.
            </p>
          </div>
          <button onClick={() => discoverMutation.mutate()} disabled={discoverMutation.isPending} className="btn-primary flex items-center gap-2">
            <RefreshCw className={clsx('w-4 h-4', discoverMutation.isPending && 'animate-spin')} />
            Start Discovery
          </button>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden" style={{ height: 'min(620px, 65vh)' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connectMode ? onConnect : undefined}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.15, includeHiddenNodes: false }}
              minZoom={0.15}
              maxZoom={2.5}
              deleteKeyCode={null}
              className={clsx(
                'topology-reactflow h-full min-h-[400px] bg-slate-50 dark:bg-slate-800',
                theme === 'dark' && 'dark',
                connectMode && 'cursor-crosshair'
              )}
            >
              <Controls className="topology-controls !shadow-md" />
              <MiniMap
                className="!shadow-md"
                nodeColor={(n) => {
                  if (n.type === 'externalNode') return '#94a3b8';
                  const d = n.data as unknown as TopologyDevice;
                  return statusColor[d.status] || '#94a3b8';
                }}
              />
              <Background variant={BackgroundVariant.Dots} color="#94a3b8" gap={20} />
            </ReactFlow>
          </div>

          {/* Legend */}
          <div className="card px-4 py-3 flex flex-wrap gap-4 text-xs text-gray-500 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-0.5 bg-gray-400" />
              <span>LLDP (direct, point-to-point)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div style={{ width: 16, borderTop: '2px dashed #f59e0b' }} />
              <span>Shared segment (CDP/MNDP)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div style={{ width: 16, borderTop: '2px dashed #8b5cf6' }} />
              <span>Manual link (user-drawn)</span>
            </div>
            {hasStp && (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 bg-blue-500" />
                  <span>Root port (uplink)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 bg-green-500" />
                  <span>Designated port</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div style={{ width: 16, borderTop: '2px dashed #ef4444' }} />
                  <span>Alternate/Backup (blocked)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-amber-500 font-bold">★</span>
                  <span>Root Bridge</span>
                </div>
              </>
            )}
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded border-dashed border border-gray-400" />
              <span>External (unmanaged)</span>
            </div>
          </div>
        </>
      )}

      {/* Discovered links table */}
      {links.filter((l) => l.link_type !== 'manual').length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Discovered Links ({links.filter((l) => l.link_type !== 'manual').length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">From Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Local Port</th>
                  <th className="table-header px-4 py-2.5 text-left">Remote Port</th>
                  <th className="table-header px-4 py-2.5 text-left">Neighbor</th>
                  <th className="table-header px-4 py-2.5 text-left">Neighbor IP</th>
                  <th className="table-header px-4 py-2.5 text-left">Protocol</th>
                  <th className="table-header px-4 py-2.5 text-left">STP Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {links.filter((l) => l.link_type !== 'manual').map((link) => (
                  <tr key={link.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{link.from_device_name || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{link.from_interface || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{link.to_interface || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-slate-300">{link.to_device_name || link.neighbor_identity || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{link.neighbor_address || '—'}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {link.link_type ? (
                        <span className={clsx('px-1.5 py-0.5 rounded font-medium uppercase',
                          link.link_type === 'lldp' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
                          link.link_type === 'cdp'  && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                          link.link_type === 'mndp' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                          !['lldp','cdp','mndp'].includes(link.link_type) && 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
                        )}>
                          {link.link_type}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {link.stp_role ? (
                        <span className={clsx('px-1.5 py-0.5 rounded font-medium',
                          link.stp_role === 'root' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                          link.stp_role === 'designated' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
                          (link.stp_role === 'alternate' || link.stp_role === 'backup') && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
                        )}>
                          {link.stp_role}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
