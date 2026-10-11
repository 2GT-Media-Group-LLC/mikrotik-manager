import { useCanWrite } from '../hooks/useCanWrite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  BackgroundVariant,
  ConnectionMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RefreshCw, GitBranch, Link2, Link2Off, AlertCircle, Plus, Users, ChevronUp, RotateCcw } from 'lucide-react';
import { topologyApi } from '../services/api';
import type { TopologyDevice, TopologyNode, HandLinkEnd } from '../types';
import clsx from 'clsx';
import { useThemeStore } from '../store/themeStore';
import { buildTopologyGraph, endFor, type GraphEdge, type StpUpstream } from '../utils/topologyGraph';
import type { BridgeInfo } from '../utils/stpRoot';
import type { Side } from '../utils/topologyGeometry';
import { nodeTypes, statusColor } from '../components/topology/nodes';
import TopoEdge, { type TopoEdgeData } from '../components/topology/TopoEdge';
import EdgeMenu from '../components/topology/EdgeMenu';
import NodeEditor from '../components/topology/NodeEditor';
import HandLinksTable from '../components/topology/HandLinksTable';

const edgeTypes = { topo: TopoEdge };
const SHOW_CLIENTS_KEY = 'topology.showClients';

type Anchors = Record<string, { sourceHandle: Side | null; targetHandle: Side | null }>;

/** React Flow edge for a graph edge: the colour says what kind of link it is. */
function toFlowEdge(e: GraphEdge, anchors: Anchors, onDelete: (e: GraphEdge) => void, canWrite: boolean): Edge {
  const sides = anchors[e.id];
  const data: TopoEdgeData = { label: e.label, parallel: e.parallel, sourceSide: sides?.sourceHandle ?? null, targetSide: sides?.targetHandle ?? null };
  if (e.kind === 'hand') {
    return {
      id: e.id, source: e.source, target: e.target, type: 'topo',
      data: { ...data, hand: true, onDelete: canWrite && e.deleteId != null ? () => onDelete(e) : undefined },
      style: { stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '6,3' },
    };
  }
  if (e.kind === 'client') {
    return { id: e.id, source: e.source, target: e.target, type: 'topo', data: { ...data, label: undefined }, style: { stroke: '#7dd3fc', strokeWidth: 1 } };
  }
  const look = e.role === 'root' ? { stroke: '#3b82f6' }
    : e.role === 'designated' ? { stroke: '#22c55e' }
      : e.role === 'blocked' ? { stroke: '#ef4444', strokeDasharray: '6,3' }
        : { stroke: '#94a3b8' };
  return {
    id: e.id, source: e.source, target: e.target, type: 'topo',
    data: { ...data, label: e.label ? `${e.label}${e.role === 'blocked' ? ' [blocked]' : ''}` : (e.role === 'blocked' ? 'blocked' : undefined) },
    className: 'topology-edge',
    style: { strokeWidth: 2, ...look },
    animated: e.role === 'root',
  };
}

export default function TopologyPage() {
  const theme = useThemeStore((s) => s.theme);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Discover, links, nodes and the arrangement need write access on the server (U10).
  const canWrite = useCanWrite();
  const [connectMode, setConnectMode] = useState(false);
  const [showClients, setShowClients] = useState(() => {
    try { return localStorage.getItem(SHOW_CLIENTS_KEY) === '1'; } catch { return false; }
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<TopologyNode | 'new' | null>(null);
  const [linkError, setLinkError] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [anchorEdits, setAnchorEdits] = useState<Anchors>({});
  const rf = useRef<ReactFlowInstance | null>(null);
  /** Set by Reset layout: the next placement uses the automatic positions, then refits. */
  const resetting = useRef(false);
  /** Client cards moved by hand; others follow their chip and aren't saved. */
  const movedClients = useRef(new Set<string>());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['topology', showClients],
    queryFn: () => topologyApi.get(showClients).then((r) => r.data),
  });
  const invalidate = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['topology'] }); }, [queryClient]);

  const anchors: Anchors = useMemo(() => ({ ...(data?.layout?.anchors ?? {}), ...anchorEdits }), [data, anchorEdits]);

  const discoverMutation = useMutation({
    mutationFn: () => topologyApi.discover(),
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });
  const deleteMutate = useMutation({
    mutationFn: (id: number) => topologyApi.deleteHandLink(id),
    onSuccess: invalidate,
  }).mutate;
  // Confirmed first: a hand-drawn link can't be rebuilt from discovery (U10).
  const onDeleteEdge = useCallback((e: GraphEdge) => {
    if (e.deleteId != null && window.confirm('Remove this hand-drawn link?')) deleteMutate(e.deleteId);
  }, [deleteMutate]);

  const graph = useMemo(() => {
    if (!data) return null;
    return buildTopologyGraph({
      devices: (data.devices as TopologyDevice[]) || [],
      externalNodes: data.externalNodes || [],
      links: data.links || [],
      bridges: (data.bridges as BridgeInfo[]) || [],
      upstreams: (data.upstreams as StpUpstream[]) || [],
      nodes: data.nodes || [],
      handLinks: data.handLinks || [],
      clients: showClients ? data.clients ?? [] : null,
      expandedClients: expanded,
      saved: data.layout?.positions ?? {},
    });
  }, [data, showClients, expanded]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodesRef = useRef<Node[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // Cards already on screen keep where they are, whatever changed: a new link,
  // a new node or a refresh must not rearrange the map. Only new cards take the
  // position the graph gives them (next to what they hang from).
  useEffect(() => {
    if (!graph) return;
    const fresh = resetting.current;
    setNodes((prev) => {
      const here = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) => ({
        id: n.id, type: n.kind,
        position: (!fresh && here.get(n.id)) || { x: n.x, y: n.y },
        data: { ...n.data, connectMode: connectMode && (n.kind === 'device' || n.kind === 'manual' || n.kind === 'external') },
      }));
    });
    if (fresh) {
      resetting.current = false;
      setTimeout(() => rf.current?.fitView({ padding: 0.12, duration: 300 }), 80);
    }
  }, [graph, connectMode, setNodes]);

  useEffect(() => {
    if (!graph) return;
    setEdges(graph.edges.map((e) => toFlowEdge(e, anchors, onDeleteEdge, canWrite)));
  }, [graph, anchors, onDeleteEdge, canWrite, setEdges]);

  /**
   * Save where every card is, so the arrangement holds for everyone and after a
   * reload. Called on any edit, not only a drag: drawing a link or adding a
   * node is when an unsaved map would otherwise be laid out afresh.
   */
  const saveArrangement = useCallback(async () => {
    if (!canWrite) return;
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodesRef.current) {
      if (n.type === 'client' && !movedClients.current.has(n.id)) continue;
      positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    await topologyApi.saveLayout({ positions }).catch(() => { /* the map still works; it just isn't saved */ });
  }, [canWrite]);

  const onNodeDragStop = useCallback((_: unknown, _node: Node, moved: Node[]) => {
    for (const n of moved) if (n.type === 'client') movedClients.current.add(n.id);
    void saveArrangement();
  }, [saveArrangement]);

  const linkMutation = useMutation({
    mutationFn: async (c: { a: HandLinkEnd; b: HandLinkEnd }) => {
      await saveArrangement();
      return topologyApi.createHandLink(c.a, c.b);
    },
    onSuccess: () => { setLinkError(''); invalidate(); },
    onError: (e: unknown) => setLinkError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Couldn’t connect them'),
  });

  const setSides = useCallback((edgeId: string, source: Side | null, target: Side | null) => {
    setAnchorEdits((a) => ({ ...a, [edgeId]: { sourceHandle: source, targetHandle: target } }));
    void topologyApi.saveLayout({ anchors: { [edgeId]: source || target ? { sourceHandle: source, targetHandle: target } : null } });
  }, []);

  const resetLayout = useCallback(async () => {
    if (!window.confirm('Lay the map out automatically again? Where cards were moved to, and which sides links attach to, is forgotten for everything in view.')) return;
    await topologyApi.resetLayout(nodesRef.current.map((n) => n.id), edges.map((e) => e.id));
    movedClients.current.clear();
    setAnchorEdits(Object.fromEntries(edges.map((e) => [e.id, { sourceHandle: null, targetHandle: null }])));
    resetting.current = true;
    invalidate();
  }, [edges, invalidate]);

  // Hovering a node lights up its connections and dims the rest of the map.
  const lit = useMemo(() => {
    if (!hover) return null;
    const ids = new Set([hover]);
    const edgeIds = new Set<string>();
    for (const e of edges) if (e.source === hover || e.target === hover) { ids.add(e.source); ids.add(e.target); edgeIds.add(e.id); }
    return { ids, edgeIds };
  }, [hover, edges]);
  const shownNodes = lit ? nodes.map((n) => ({ ...n, style: { ...n.style, opacity: lit.ids.has(n.id) ? 1 : 0.3 } })) : nodes;
  const shownEdges = lit ? edges.map((e) => ({ ...e, style: { ...e.style, opacity: lit.edgeIds.has(e.id) ? 1 : 0.12 } })) : edges;

  const nameOfNode = useCallback((id: string) => String(graph?.nodes.find((n) => n.id === id)?.data.name ?? id), [graph]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const a = endFor(c.source, nameOfNode(c.source));
    const b = endFor(c.target, nameOfNode(c.target));
    if (!a || !b) return;
    linkMutation.mutate({ a, b });
  }, [linkMutation, nameOfNode]);

  // Clicking a link opens its menu: where it attaches, and removing a hand-drawn one.
  const onEdgeClick = useCallback((ev: React.MouseEvent, edge: Edge) => {
    setMenu({ x: ev.clientX, y: ev.clientY, edgeId: edge.id });
  }, []);
  const menuEdge = menu ? graph?.edges.find((e) => e.id === menu.edgeId) : undefined;

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    if (connectMode) return;
    if (n.type === 'clientGroup') {
      const dev = String((n.data as { deviceId: string }).deviceId);
      setExpanded((s) => { const next = new Set(s); if (next.has(dev)) next.delete(dev); else next.add(dev); return next; });
    } else if (n.type === 'client') {
      navigate(`/clients/${encodeURIComponent((n.data as { mac: string }).mac)}`);
    } else if (n.type === 'manual' && canWrite) {
      const node = (data?.nodes || []).find((x) => `node-${x.id}` === n.id);
      if (node) setEditing(node);
    }
  }, [connectMode, navigate, canWrite, data]);

  // Double-click opens a device's page; a single click is for arranging.
  const onNodeDoubleClick = useCallback((_: unknown, n: Node) => {
    if (n.type === 'device') navigate(`/devices/${n.id}`);
  }, [navigate]);

  const toggleClients = () => {
    const next = !showClients;
    setShowClients(next);
    setExpanded(new Set());
    try { localStorage.setItem(SHOW_CLIENTS_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-96 text-gray-400">Loading topology…</div>;
  }

  const hasData = (data?.devices?.length ?? 0) > 0;
  const links = data?.links ?? [];
  const hasStp = links.some((l) => l.stp_role);
  const discovered = links.filter((l) => l.link_type !== 'manual');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Network Topology</h1>
        <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
          <button
            onClick={toggleClients}
            className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
              showClients ? 'bg-sky-600 text-white border-sky-700 hover:bg-sky-500'
                : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40')}
            title="Show client devices under the switch port or access point they connect through"
          >
            <Users className="w-4 h-4" />{showClients ? 'Hide clients' : 'Show clients'}
          </button>
          {showClients && expanded.size > 0 && (
            <button className="text-sm text-sky-700 dark:text-sky-300 hover:underline flex items-center gap-1" onClick={() => setExpanded(new Set())}>
              <ChevronUp className="w-3.5 h-3.5" />Collapse clients
            </button>
          )}
          {canWrite && <>
            <button onClick={() => { void saveArrangement(); setEditing('new'); }} className="btn-secondary flex items-center gap-2" title="Add something the manager doesn't manage: ISP modem, server, unmanaged switch">
              <Plus className="w-4 h-4" />Add node
            </button>
            <button
              onClick={() => setConnectMode((v) => !v)}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                connectMode
                  ? 'bg-purple-600 text-white border-purple-700 hover:bg-purple-500'
                  : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40'
              )}
              title={connectMode ? 'Exit connect mode' : 'Draw links between devices and your own nodes'}
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
            <button onClick={resetLayout} className="text-sm text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-white flex items-center gap-1"
              title="Forget where things were moved to and lay the map out automatically again">
              <RotateCcw className="w-3.5 h-3.5" />Reset layout
            </button>
          </>}
        </div>
      </div>

      {connectMode && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 text-sm text-purple-700 dark:text-purple-300">
          <Link2 className="w-4 h-4 flex-shrink-0" />
          Drag from any blue handle to another node to draw a link: devices, your own nodes and neighbours discovery found can all be linked.
          Click any link to choose which side of each card it attaches to, or to remove a hand-drawn one.
          {linkError && <span className="ml-auto text-red-600 dark:text-red-400">{linkError}</span>}
        </div>
      )}

      {graph && graph.orphanCount > 0 && !connectMode && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-sm text-orange-700 dark:text-orange-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {graph.orphanCount} device{graph.orphanCount !== 1 ? 's have' : ' has'} no discovered connections.
          Use <strong className="mx-1">Connect Mode</strong> to draw links, or run <strong className="mx-1">Discover</strong> to re-scan.
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
          <div className="card overflow-hidden" style={{ height: 'max(520px, calc(100vh - 260px))' }}>
            <ReactFlow
              nodes={shownNodes}
              edges={shownEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connectMode && canWrite ? onConnect : undefined}
              connectionMode={ConnectionMode.Loose}
              onEdgeClick={onEdgeClick}
              onNodeDragStop={onNodeDragStop}
              onPaneClick={() => setMenu(null)}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeMouseEnter={(_, n) => setHover(n.id)}
              onNodeMouseLeave={() => setHover(null)}
              onInit={(i) => { rf.current = i; }}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.12, includeHiddenNodes: false }}
              minZoom={0.08}
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
                pannable
                zoomable
                nodeColor={(n) => {
                  if (n.type === 'device') return statusColor[(n.data as unknown as TopologyDevice).status] || '#94a3b8';
                  if (n.type === 'manual') return '#8b5cf6';
                  if (n.type === 'client' || n.type === 'clientGroup') return '#7dd3fc';
                  return '#94a3b8';
                }}
              />
              <Background variant={BackgroundVariant.Dots} color="#94a3b8" gap={20} />
            </ReactFlow>
          </div>

          {/* Legend */}
          <div className="card px-4 py-3 flex flex-wrap gap-4 text-xs text-gray-500 dark:text-slate-400">
            <div className="flex items-center gap-1.5"><div className="w-4 h-0.5 bg-gray-400" /><span>Discovered (LLDP/CDP/MNDP)</span></div>
            <div className="flex items-center gap-1.5"><div style={{ width: 16, borderTop: '2px dashed #8b5cf6' }} /><span>Drawn by hand</span></div>
            {hasStp && (
              <>
                <div className="flex items-center gap-1.5"><div className="w-4 h-0.5 bg-blue-500" /><span>Root port (uplink)</span></div>
                <div className="flex items-center gap-1.5"><div className="w-4 h-0.5 bg-green-500" /><span>Designated port</span></div>
                <div className="flex items-center gap-1.5"><div style={{ width: 16, borderTop: '2px dashed #ef4444' }} /><span>Blocked by spanning tree</span></div>
                <div className="flex items-center gap-1.5"><span className="text-amber-500 font-bold">★</span><span>Root bridge</span></div>
              </>
            )}
            <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded border-dashed border border-gray-400" /><span>Seen by discovery, not managed</span></div>
            <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded border-dashed border border-violet-500" /><span>Your own node</span></div>
            {showClients && <div className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-sky-500" /><span>Clients (click to show each)</span></div>}
            <span className="ml-auto text-gray-400">Drag cards to arrange the map (saved for everyone) · click a link to choose where it attaches · hover a device to light up its links</span>
          </div>
        </>
      )}

      {/* Links drawn by hand, removable from here as well as on the map */}
      {(data?.handLinks?.length ?? 0) > 0 && (
        <HandLinksTable links={data!.handLinks} graph={graph} canWrite={canWrite} onRemove={(id) => { if (window.confirm('Remove this hand-drawn link?')) deleteMutate(id); }} />
      )}

      {/* Discovered links table */}
      {discovered.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Discovered Links ({discovered.length})</h3>
          </div>
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-800">
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
                {discovered.map((link) => (
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

      {menu && menuEdge && (
        <EdgeMenu
          at={menu}
          title={`${nameOfNode(menuEdge.source)} ↔ ${nameOfNode(menuEdge.target)}`}
          ports={menuEdge.kind === 'discovered' ? menuEdge.label : undefined}
          sourceName={nameOfNode(menuEdge.source)}
          targetName={nameOfNode(menuEdge.target)}
          sourceSide={anchors[menuEdge.id]?.sourceHandle ?? null}
          targetSide={anchors[menuEdge.id]?.targetHandle ?? null}
          canWrite={canWrite}
          onSides={(src, dst) => setSides(menuEdge.id, src, dst)}
          onRemove={menuEdge.kind === 'hand' ? () => { setMenu(null); onDeleteEdge(menuEdge); } : undefined}
          onClose={() => setMenu(null)}
        />
      )}

      {editing && (
        <NodeEditor node={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      )}
    </div>
  );
}
