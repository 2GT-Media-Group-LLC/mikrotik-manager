/**
 * The spanning trees among the bridges in view, for the Spanning Tree card on
 * the Topology page: who is root of each, every bridge's priority, root port
 * and distance, and what's wrong with how the trees are set up.
 *
 * One network should be one tree with its core as root, chosen on purpose by
 * priority. Two trees in one network means a link between them is dropping
 * BPDUs, so neither side protects the other from a loop. A root left at the
 * default priority won by having the lowest MAC, which can be any box,
 * including an access point.
 */
import type { BridgeInfo } from './stpRoot';
import type { StpDomainInfo } from './topologyGraph';

export interface StpTreeDevice { id: number; name: string; device_type?: string | null }

export interface StpTreeRow {
  deviceId: number;
  deviceName: string;
  deviceType: string | null;
  bridgeName: string;
  mode: string;
  /** This bridge's priority, from its bridge id ("0x8000.MAC"). */
  priority: string | null;
  isRoot: boolean;
  rootPort: string | null;
  cost: number | null;
}

export interface StpTree {
  rootBridgeId: string;
  /** The managed device that is root, or the name discovery saw, or the bridge id. */
  rootName: string;
  rootDeviceId: number | null;
  rootPriority: string | null;
  defaultPriority: boolean;
  rows: StpTreeRow[];
}

export interface StpWarning { tone: 'warn' | 'info'; text: string }

export interface StpOverview {
  trees: StpTree[];
  /** Bridges with spanning tree off: they take no part in any tree. */
  off: StpTreeRow[];
  warnings: StpWarning[];
}

/** "0x8000.F4:1E:57:51:74:1E" → "0x8000". */
export function bridgePriority(bridgeId: string | null | undefined): string | null {
  const m = /^(0x[0-9a-f]+)\./i.exec((bridgeId ?? '').trim());
  return m ? `0x${m[1].slice(2).toLowerCase().padStart(4, '0')}` : null;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function stpOverview(devices: StpTreeDevice[], bridges: BridgeInfo[], domains: StpDomainInfo[]): StpOverview {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const rowOf = (b: BridgeInfo): StpTreeRow => {
    const port = (b.root_port ?? '').trim();
    return {
      deviceId: b.device_id,
      deviceName: byId.get(b.device_id)?.name ?? `Device ${b.device_id}`,
      deviceType: byId.get(b.device_id)?.device_type ?? null,
      bridgeName: b.bridge_name,
      mode: (b.protocol_mode ?? '').toLowerCase() || 'none',
      priority: bridgePriority(b.bridge_id),
      isRoot: b.root_bridge === true,
      rootPort: port && port.toLowerCase() !== 'none' ? port : null,
      cost: b.root_path_cost,
    };
  };

  const inView = bridges.filter((b) => byId.has(b.device_id));
  const off = inView.filter((b) => !b.protocol_mode || b.protocol_mode.toLowerCase() === 'none').map(rowOf);
  const on = inView.filter((b) => b.protocol_mode && b.protocol_mode.toLowerCase() !== 'none' && b.root_bridge_id);

  const groups = new Map<string, BridgeInfo[]>();
  for (const b of on) {
    const k = norm(b.root_bridge_id);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const trees: StpTree[] = [...groups.entries()].map(([k, members]) => {
    const domain = domains.find((d) => norm(d.rootBridgeId) === k);
    const rootId = members[0].root_bridge_id ?? k;
    const rootBridge = inView.find((b) => norm(b.bridge_id) === k);
    const rootDeviceId = rootBridge?.device_id ?? domain?.ownerDeviceId ?? null;
    const rows = members.map(rowOf).sort((a, b) =>
      Number(b.isRoot) - Number(a.isRoot) || (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.deviceName.localeCompare(b.deviceName));
    return {
      rootBridgeId: rootId,
      rootName: rootDeviceId != null ? (byId.get(rootDeviceId)?.name ?? `Device ${rootDeviceId}`) : (domain?.guessedName || rootId),
      rootDeviceId,
      rootPriority: bridgePriority(rootId),
      defaultPriority: bridgePriority(rootId) === '0x8000',
      rows,
    };
  }).sort((a, b) => b.rows.length - a.rows.length || a.rootName.localeCompare(b.rootName));

  const warnings: StpWarning[] = [];
  if (trees.length > 1) {
    warnings.push({ tone: 'warn', text: `These bridges form ${trees.length} separate spanning trees. If they're one network, a link between them `
      + 'is dropping BPDUs (spanning tree off on a port or bridge, BPDU filtering, or an unmanaged switch that doesn\'t pass them), '
      + 'so the trees don\'t protect each other from a loop.' });
  }
  for (const t of trees) {
    if (t.rootDeviceId == null) {
      warnings.push({ tone: 'info', text: `${t.rootName} is root of a tree but isn't managed here${t.rootPriority ? ` (priority ${t.rootPriority})` : ''}. `
        + 'To make a managed switch root instead, give it a lower priority.' });
    } else if (t.defaultPriority) {
      const ap = byId.get(t.rootDeviceId)?.device_type === 'wireless_ap';
      warnings.push({ tone: 'warn', text: `${t.rootName} is root only because it has the lowest MAC: its priority is the default 0x8000`
        + `${ap ? ', and it\'s an access point' : ''}. Give the core switch a lower priority so the root is chosen on purpose.` });
    }
  }
  return { trees, off, warnings };
}
