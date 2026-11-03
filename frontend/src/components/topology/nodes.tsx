import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { Handle, Position } from '@xyflow/react';
import {
  Users, Wifi, Cable, Globe, Router, Shield, Network, Server, HardDrive, Printer, Camera, Phone, Monitor, Cloud, Box, ChevronDown, ChevronUp,
  RadioTower,
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
  wisp: '⊙',
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

/**
 * What a neighbour's LLDP capabilities say it is. A computer with a software
 * bridge (Hyper-V, a Linux bridge) advertises "bridge" as well as "station",
 * and was labelled a switch (#260); an access point advertises "bridge" and
 * "wlan-ap". Those win over "bridge". "bridge" stays ahead of "router",
 * because a layer-3 switch advertises both.
 */
export function capsLabel(caps: string | undefined): string {
  if (!caps) return '';
  const c = caps.toLowerCase().split(/[\s,]+/);
  if (c.includes('station'))   return 'Computer';
  if (c.includes('wlan-ap'))   return 'AP';
  if (c.includes('telephone')) return 'Phone';
  if (c.includes('bridge'))    return 'Switch';
  if (c.includes('router'))    return 'Router';
  return '';
}

/**
 * Access points that advertise only "bridge" in LLDP, told apart by what they
 * call themselves: a Cisco 9120 was labelled a switch (#367). Model codes are
 * matched as written; the words in any case.
 */
const AP_WORDS = /\b(access[- ]?point|ap software|aironet)\b/i;
const AP_MODELS = /\b(AIR-[A-Z]*AP[0-9A-Z-]*|C91[0-9]{2}AX[A-Z0-9-]*|CW91[0-9]{2}[A-Z0-9-]*|UAP(-[A-Za-z0-9]+)*|U6(-[A-Za-z0-9]+)*|U7(-[A-Za-z0-9]+)*|AP-[0-9]{3}[A-Z]*|MR[0-9]{2}[A-Z]?|EAP[0-9]{3}|cAP|wAP)\b/;

/** What a neighbour is, from its LLDP capabilities and, failing a clear answer, its platform or description. */
export function neighbourType(caps: string | undefined, platform: string | undefined): string {
  const byCaps = capsLabel(caps);
  if (byCaps === 'AP' || byCaps === 'Computer' || byCaps === 'Phone') return byCaps;
  if (platform && (AP_WORDS.test(platform) || AP_MODELS.test(platform))) return 'AP';
  return byCaps;
}

/** Icons for the compact view (#367): by device type, and for a neighbour by what it is. */
const DEVICE_ICONS: Record<string, typeof Globe> = { router: Router, switch: Network, wireless_ap: Wifi, wisp: RadioTower, other: Box };
const NEIGHBOUR_ICONS: Record<string, typeof Globe> = { AP: Wifi, Switch: Network, Router: Router, Computer: Monitor, Phone: Phone };

/**
 * The compact view's tile (#367): an icon with a status dot, a role chip
 * above, the name and address below. The rest is in the hover.
 */
function Tile({ Icon, badge, dot, chip, name, sub, title, look, ring }: {
  Icon: typeof Globe;
  /** A small second icon on the tile: Wi-Fi on a CAPsMAN controller. */
  badge?: typeof Globe;
  dot?: string;
  chip?: string | null;
  name: string;
  sub?: string | null;
  title: string;
  look: 'device' | 'neighbour' | 'manual';
  /** Border colour of a device tile: amber for the spanning-tree root. */
  ring?: string;
}) {
  const Badge = badge;
  const tile = look === 'device'
    ? (ring ? { border: `2px solid ${ring}` } : undefined)
    : { border: `1.5px dashed ${look === 'manual' ? '#8b5cf6' : '#94a3b8'}` };
  return (
    <div className="w-[136px] flex flex-col items-center text-center select-none" title={title}>
      {chip && (
        <span className={clsx('mb-1 px-1.5 py-px rounded-full text-[10px] font-medium leading-tight whitespace-nowrap max-w-full truncate border',
          look === 'device' ? 'border-teal-300 text-teal-700 bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:bg-teal-900/30'
            : 'border-gray-300 text-gray-500 bg-gray-50 dark:border-slate-600 dark:text-slate-400 dark:bg-slate-800')}>
          {chip}
        </span>
      )}
      <div className={clsx('relative w-11 h-11 rounded-xl flex items-center justify-center shadow-sm',
        look === 'device' ? clsx('bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-100', !ring && 'border border-gray-300 dark:border-slate-500')
          : look === 'manual' ? 'bg-white dark:bg-slate-800 text-violet-500' : 'bg-gray-100 dark:bg-slate-700/60 text-gray-400 dark:text-slate-400')}
        style={tile}>
        <Icon className="w-5 h-5" />
        {Badge && <Badge className="absolute -bottom-1 -right-1 w-3.5 h-3.5 p-px rounded-full bg-white dark:bg-slate-800 text-sky-500" />}
        {dot && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-white dark:border-slate-900" style={{ background: dot }} />}
      </div>
      <div className={clsx('mt-1 text-[11px] font-semibold leading-tight [overflow-wrap:anywhere]',
        look === 'neighbour' ? 'text-gray-500 dark:text-slate-400' : 'text-gray-900 dark:text-white')}>{name}</div>
      {sub && <div className="text-[10px] font-mono text-gray-400 dark:text-slate-500 truncate max-w-full">{sub}</div>}
    </div>
  );
}

/** The role chip above a device's tile: what it does in the network. */
export function deviceRole(d: { gateway?: boolean; isRootBridge?: boolean; wifi_role?: string | null }): string | null {
  const parts: string[] = [];
  if (d.gateway) parts.push('Gateway');
  if (d.wifi_role === 'controller' || d.wifi_role === 'controller_cap') parts.push('CAPsMAN');
  else if (d.wifi_role === 'cap') parts.push('CAP');
  if (d.isRootBridge) parts.push('STP root');
  return parts.length ? parts.join(' · ') : null;
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
  const device = data as unknown as TopologyDevice & {
    isRootBridge: boolean; connectMode: boolean; orphan: boolean; stpNote: string | null; gateway?: boolean; compact?: boolean;
  };
  if (device.compact) {
    const controller = device.wifi_role === 'controller' || device.wifi_role === 'controller_cap';
    const title = [
      device.name, device.ip_address, device.model, device.ros_version ? `RouterOS ${device.ros_version}` : null,
      device.isRootBridge ? 'Spanning-tree root bridge' : null, device.stpNote,
      device.orphan ? 'No known connections' : null, 'Double-click to open',
    ].filter(Boolean).join('\n');
    return (
      <div className={clsx(device.orphan && 'opacity-60')}>
        <Handles connectable={!!device.connectMode} />
        <Tile Icon={DEVICE_ICONS[device.device_type] ?? Box} badge={controller && device.device_type !== 'wireless_ap' ? Wifi : undefined}
          dot={statusColor[device.status] ?? '#94a3b8'} chip={deviceRole(device)} name={device.name} sub={device.ip_address}
          title={title} look="device" ring={device.isRootBridge ? '#f59e0b' : undefined} />
      </div>
    );
  }
  return (
    <div
      className={clsx('card px-3 py-2 min-w-[148px] max-w-[200px] text-xs shadow-md select-none', device.orphan && 'opacity-60')}
      style={{
        borderColor: device.isRootBridge ? '#f59e0b' : statusColor[device.status] ?? '#94a3b8',
        borderWidth: device.isRootBridge ? 2 : 1,
      }}
    >
      <Handles connectable={!!device.connectMode} />
      {/* Names wrap rather than cut off, with the full name on hover (#363):
          site naming schemes run past 20 characters. */}
      <div className="flex items-start gap-1.5 mb-1">
        <span className="text-base leading-none">{deviceIcon[device.device_type] || '◈'}</span>
        <span className="w-2 h-2 mt-1 rounded-full flex-shrink-0" style={{ background: statusColor[device.status] ?? '#94a3b8' }} />
        <span className="font-semibold min-w-0 leading-tight [overflow-wrap:anywhere] text-gray-900 dark:text-white" title={device.name}>{device.name}</span>
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
  const node = data as unknown as ExternalTopologyNode & { connectMode: boolean; overrideKind?: string | null; compact?: boolean };
  // A type set by hand (#260) wins over what discovery says.
  const cl = node.overrideKind ? kindInfo(node.overrideKind).label : neighbourType(node.caps, node.platform);
  const gone = node.caps === 'gone';
  if (node.compact) {
    const Icon = node.overrideKind ? kindInfo(node.overrideKind).Icon : NEIGHBOUR_ICONS[cl] ?? Box;
    const title = [node.name + (cl ? ` (${cl})` : ''), node.address, node.platform,
      gone ? 'No longer seen by discovery' : 'Seen by discovery, not managed'].filter(Boolean).join('\n');
    return (
      <div>
        <Handles connectable={!!node.connectMode} />
        <Tile Icon={Icon} chip={gone ? 'no longer seen' : 'not managed'} name={node.name} sub={node.address || null} title={title} look="neighbour" />
      </div>
    );
  }
  return (
    <div className="px-3 py-2 min-w-[130px] max-w-[200px] text-xs rounded-lg bg-gray-100 dark:bg-slate-700/60 shadow-sm select-none" style={{ border: '1.5px dashed #94a3b8' }}>
      <Handles connectable={!!node.connectMode} />
      <div className="flex items-start gap-1.5 mb-1">
        <span className="text-base leading-none text-gray-400">◌</span>
        <span className="font-semibold min-w-0 leading-tight [overflow-wrap:anywhere] text-gray-600 dark:text-slate-300" title={node.name}>{node.name}{cl ? ` (${cl})` : ''}</span>
      </div>
      {node.address && <div className="font-mono text-gray-400 dark:text-slate-500">{node.address}</div>}
      {node.platform && <div className="text-gray-400 dark:text-slate-500 truncate">{node.platform}</div>}
      <div className="text-gray-400 dark:text-slate-500 mt-0.5">{gone ? 'No longer seen by discovery' : 'Seen by discovery, not managed'}</div>
    </div>
  );
}

/** A node added by hand (#147). */
function ManualNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as TopologyNode & { connectMode: boolean; orphan: boolean; compact?: boolean };
  const { Icon, label } = kindInfo(node.kind);
  if (node.compact) {
    const title = [node.name, node.address, label, 'Added by hand. Click to edit', node.orphan ? 'Not connected yet' : null].filter(Boolean).join('\n');
    return (
      <div className={clsx('cursor-pointer', node.orphan && 'opacity-70')}>
        <Handles connectable={!!node.connectMode} />
        <Tile Icon={Icon} name={node.name} sub={node.address || null} title={title} look="manual" />
      </div>
    );
  }
  return (
    <div className={clsx('px-3 py-2 min-w-[140px] max-w-[200px] text-xs rounded-lg bg-white dark:bg-slate-800 shadow-sm select-none cursor-pointer', node.orphan && 'opacity-70')}
      style={{ border: '1.5px dashed #8b5cf6' }} title="Added by hand. Click to edit">
      <Handles connectable={!!node.connectMode} />
      <div className="flex items-start gap-1.5 mb-1">
        <Icon className="w-3.5 h-3.5 mt-px text-violet-500 flex-shrink-0" />
        <span className="font-semibold min-w-0 leading-tight [overflow-wrap:anywhere] text-gray-900 dark:text-white">{node.name}</span>
      </div>
      {node.address && <div className="font-mono text-gray-400 dark:text-slate-500 truncate">{node.address}</div>}
      <div className="text-violet-500/80 dark:text-violet-400/80">{label}</div>
      {node.orphan && <div className="mt-1 text-orange-400 text-[10px]">Not connected yet</div>}
    </div>
  );
}

/** "12 clients" under a switch or AP; click to show them one by one. */
function ClientGroupNode({ data }: { data: Record<string, unknown> }) {
  const g = data as { count: number; wireless: number; expanded?: boolean; label?: string; hosts?: boolean };
  // Computers whose network cards send LLDP, grouped under their switch (#367).
  if (g.hosts) {
    return (
      <div className="px-2.5 py-1.5 text-xs rounded-full bg-gray-100 dark:bg-slate-700/60 text-gray-600 dark:text-slate-300 shadow-sm select-none cursor-pointer flex items-center gap-1.5"
        style={{ border: '1.5px dashed #94a3b8' }}
        title={`${g.count} computers that send LLDP without a name or capabilities. ${g.expanded ? 'Click to fold them back into a count' : 'Click to show each'}. Name one to keep it on the map as its own card.`}>
        <Handles connectable={false} />
        <Monitor className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="font-medium whitespace-nowrap">{g.count} hosts</span>
        {g.expanded ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
      </div>
    );
  }
  return (
    <div className="px-2.5 py-1.5 text-xs rounded-full bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 shadow-sm select-none cursor-pointer flex items-center gap-1.5 max-w-[225px]"
      style={{ border: '1px solid #7dd3fc' }}
      title={`${g.label ? `${g.label}: ` : ''}${g.count} client${g.count === 1 ? '' : 's'}. ${g.expanded ? 'Click to fold them back into a count' : 'Click to show each client'}`}>
      <Handles connectable={false} />
      <Users className="w-3.5 h-3.5 flex-shrink-0" />
      {/* A long VLAN name is cut short; the whole of it is in the hover (#296). */}
      {g.label && <span className="font-semibold truncate min-w-0">{g.label} ·</span>}
      <span className="font-medium whitespace-nowrap flex-shrink-0">{g.count} client{g.count === 1 ? '' : 's'}</span>
      {g.wireless > 0 && <span className="text-sky-500/80 flex items-center gap-0.5"><Wifi className="w-3 h-3" />{g.wireless}</span>}
      {g.expanded ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
    </div>
  );
}

/** What a client card's hover tells (#296): where and when it was seen. */
function clientHover(c: TopologyClient, formatDateTime: (value: string) => string): string {
  const lines = [
    c.name,
    c.ip ? `IP ${c.ip}` : null,
    `MAC ${c.mac}`,
    c.vendor ? `Vendor ${c.vendor}` : null,
    c.vlan ? `VLAN ${c.vlan.replace(/^VLAN\s+/i, '')}` : null,
    c.interface ? `${c.wireless ? 'Wireless on' : 'Port'} ${c.interface}` : (c.wireless ? 'Wireless' : 'Wired'),
    c.lastSeen ? `Last seen ${formatDateTime(c.lastSeen)}` : null,
    c.portKnown ? 'Click to open the client' : 'Only seen in ARP or on an uplink, so where it plugs in is a guess. Click to open the client',
  ];
  return lines.filter(Boolean).join('\n');
}

function ClientNode({ data }: { data: Record<string, unknown> }) {
  const { formatDateTime } = useDateTimeFormat();
  const c = data as unknown as TopologyClient;
  return (
    <div className="px-2.5 py-1.5 min-w-[120px] max-w-[170px] text-[11px] rounded-md bg-white dark:bg-slate-800 shadow-sm select-none cursor-pointer"
      style={{ border: '1px solid #bae6fd' }}
      title={clientHover(c, formatDateTime)}>
      <Handles connectable={false} />
      <div className="flex items-center gap-1">
        {c.wireless ? <Wifi className="w-3 h-3 text-sky-500 flex-shrink-0" /> : <Cable className="w-3 h-3 text-gray-400 flex-shrink-0" />}
        <span className="font-medium truncate text-gray-800 dark:text-slate-200">{c.name}</span>
      </div>
      {c.ip && <div className="font-mono text-gray-400 dark:text-slate-500 truncate">{c.ip}</div>}
      <div className="font-mono text-[10px] text-gray-400 dark:text-slate-500 truncate">{c.mac}</div>
      {c.vendor && c.vendor !== c.name && <div className="text-[10px] text-gray-400 dark:text-slate-500 truncate">{c.vendor}</div>}
      {!c.portKnown && <div className="text-[10px] text-gray-400 italic">port not known</div>}
    </div>
  );
}


export const nodeTypes = { device: DeviceNode, external: ExternalNode, manual: ManualNode, clientGroup: ClientGroupNode, client: ClientNode };
