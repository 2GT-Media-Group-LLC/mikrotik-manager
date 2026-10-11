import { Handle, Position } from '@xyflow/react';
import {
  Users, Wifi, Cable, Globe, Router, Shield, Network, Server, HardDrive, Printer, Camera, Phone, Monitor, Cloud, Box, ChevronDown, ChevronUp,
} from 'lucide-react';
import clsx from 'clsx';
import type { TopologyDevice, ExternalTopologyNode, TopologyNode, TopologyClient } from '../../types';

/** The node cards on the topology map (#147). */

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const statusColor: Record<string, string> = {
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

/** Kinds of node you can add by hand (#147), with their icon and label. */
export const NODE_KINDS: { kind: string; label: string; Icon: typeof Globe }[] = [
  { kind: 'modem', label: 'ISP modem / ONT', Icon: Globe },
  { kind: 'cloud', label: 'Internet / WAN', Icon: Cloud },
  { kind: 'router', label: 'Router (other vendor)', Icon: Router },
  { kind: 'firewall', label: 'Firewall', Icon: Shield },
  { kind: 'switch', label: 'Unmanaged switch', Icon: Network },
  { kind: 'ap', label: 'Access point (other vendor)', Icon: Wifi },
  { kind: 'server', label: 'Server', Icon: Server },
  { kind: 'nas', label: 'NAS / storage', Icon: HardDrive },
  { kind: 'printer', label: 'Printer', Icon: Printer },
  { kind: 'camera', label: 'Camera / NVR', Icon: Camera },
  { kind: 'phone', label: 'Phone system', Icon: Phone },
  { kind: 'computer', label: 'Computer', Icon: Monitor },
  { kind: 'other', label: 'Other', Icon: Box },
];
export const kindInfo = (kind: string) => NODE_KINDS.find((k) => k.kind === kind) ?? NODE_KINDS[NODE_KINDS.length - 1];

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

/** Four handles: top/left take edges in, bottom/right send them; ids pick a side for parallel cables. */
function Handles({ connectable }: { connectable: boolean }) {
  const s = connectable ? handleStyleVisible : handleStyle;
  return (
    <>
      <Handle id="t" type="target" position={Position.Top} isConnectable={connectable} style={s} />
      <Handle id="l" type="target" position={Position.Left} isConnectable={connectable} style={s} />
      <Handle id="b" type="source" position={Position.Bottom} isConnectable={connectable} style={s} />
      <Handle id="r" type="source" position={Position.Right} isConnectable={connectable} style={s} />
    </>
  );
}

// ─── Node components ──────────────────────────────────────────────────────────

function DeviceNode({ data }: { data: Record<string, unknown> }) {
  const device = data as unknown as TopologyDevice & { isRootBridge: boolean; connectMode: boolean; orphan: boolean; stpNote: string | null };
  return (
    <div
      className={clsx('card px-3 py-2 min-w-[148px] max-w-[200px] text-xs shadow-md select-none', device.orphan && 'opacity-60')}
      style={{
        borderColor: device.isRootBridge ? '#f59e0b' : statusColor[device.status] ?? '#94a3b8',
        borderWidth: device.isRootBridge ? 2 : 1,
      }}
    >
      <Handles connectable={!!device.connectMode} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none">{deviceIcon[device.device_type] || '◈'}</span>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor[device.status] ?? '#94a3b8' }} />
        <span className="font-semibold truncate text-gray-900 dark:text-white">{device.name}</span>
        {device.isRootBridge && <span title="Spanning-tree root bridge" className="ml-auto text-amber-500 font-bold">★</span>}
      </div>
      <div className="font-mono text-gray-400 dark:text-slate-500">{device.ip_address}</div>
      {device.model && <div className="text-gray-400 dark:text-slate-500 truncate">{device.model}</div>}
      {device.orphan && <div className="mt-1 text-orange-400 dark:text-orange-500 text-[10px]">No known connections</div>}
      {device.stpNote && <div className="mt-1 text-amber-600 dark:text-amber-400 text-[10px] leading-snug">{device.stpNote}</div>}
    </div>
  );
}

function ExternalNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as ExternalTopologyNode & { connectMode: boolean };
  const cl = capsLabel(node.caps);
  const gone = node.caps === 'gone';
  return (
    <div className="px-3 py-2 min-w-[130px] max-w-[200px] text-xs rounded-lg bg-gray-100 dark:bg-slate-700/60 shadow-sm select-none" style={{ border: '1.5px dashed #94a3b8' }}>
      <Handles connectable={!!node.connectMode} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none text-gray-400">◌</span>
        <span className="font-semibold truncate text-gray-600 dark:text-slate-300">{node.name}{cl ? ` (${cl})` : ''}</span>
      </div>
      {node.address && <div className="font-mono text-gray-400 dark:text-slate-500">{node.address}</div>}
      {node.platform && <div className="text-gray-400 dark:text-slate-500 truncate">{node.platform}</div>}
      <div className="text-gray-400 dark:text-slate-500 mt-0.5">{gone ? 'No longer seen by discovery' : 'Seen by discovery, not managed'}</div>
    </div>
  );
}

/** A node added by hand (#147). */
function ManualNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as TopologyNode & { connectMode: boolean; orphan: boolean };
  const { Icon, label } = kindInfo(node.kind);
  return (
    <div className={clsx('px-3 py-2 min-w-[140px] max-w-[200px] text-xs rounded-lg bg-white dark:bg-slate-800 shadow-sm select-none cursor-pointer', node.orphan && 'opacity-70')}
      style={{ border: '1.5px dashed #8b5cf6' }} title="Added by hand. Click to edit">
      <Handles connectable={!!node.connectMode} />
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
        <span className="font-semibold truncate text-gray-900 dark:text-white">{node.name}</span>
      </div>
      {node.address && <div className="font-mono text-gray-400 dark:text-slate-500 truncate">{node.address}</div>}
      <div className="text-violet-500/80 dark:text-violet-400/80">{label}</div>
      {node.orphan && <div className="mt-1 text-orange-400 text-[10px]">Not connected yet</div>}
    </div>
  );
}

/** "12 clients" under a switch or AP; click to show them one by one. */
function ClientGroupNode({ data }: { data: Record<string, unknown> }) {
  const g = data as { count: number; wireless: number; expanded?: boolean };
  return (
    <div className="px-2.5 py-1.5 text-xs rounded-full bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 shadow-sm select-none cursor-pointer flex items-center gap-1.5"
      style={{ border: '1px solid #7dd3fc' }} title={g.expanded ? 'Click to fold them back into a count' : 'Click to show each client'}>
      <Handles connectable={false} />
      <Users className="w-3.5 h-3.5" />
      <span className="font-medium">{g.count} client{g.count === 1 ? '' : 's'}</span>
      {g.wireless > 0 && <span className="text-sky-500/80 flex items-center gap-0.5"><Wifi className="w-3 h-3" />{g.wireless}</span>}
      {g.expanded ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
    </div>
  );
}

function ClientNode({ data }: { data: Record<string, unknown> }) {
  const c = data as unknown as TopologyClient;
  return (
    <div className="px-2.5 py-1.5 min-w-[120px] max-w-[170px] text-[11px] rounded-md bg-white dark:bg-slate-800 shadow-sm select-none cursor-pointer"
      style={{ border: '1px solid #bae6fd' }}
      title={c.portKnown ? 'Click to open the client' : 'Only seen in ARP or on an uplink, so where it plugs in is a guess. Click to open the client'}>
      <Handles connectable={false} />
      <div className="flex items-center gap-1">
        {c.wireless ? <Wifi className="w-3 h-3 text-sky-500 flex-shrink-0" /> : <Cable className="w-3 h-3 text-gray-400 flex-shrink-0" />}
        <span className="font-medium truncate text-gray-800 dark:text-slate-200">{c.name}</span>
      </div>
      {c.ip && <div className="font-mono text-gray-400 dark:text-slate-500 truncate">{c.ip}</div>}
      {!c.portKnown && <div className="text-[10px] text-gray-400 italic">port not known</div>}
    </div>
  );
}


export const nodeTypes = { device: DeviceNode, external: ExternalNode, manual: ManualNode, clientGroup: ClientGroupNode, client: ClientNode };
