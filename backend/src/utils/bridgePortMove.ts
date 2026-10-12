/**
 * Moving ports between bridges (#258): the checks and the plan, without a device.
 *
 * A port moves with `/interface/bridge/port/set bridge=…` when it is already a
 * bridge port, is added when it isn't, and removed for "no bridge". Its VLAN
 * settings belonged to the old bridge, so the PVID and frame admission go back
 * to the defaults, and the old bridge's VLAN table stops listing it; a stale
 * entry there would be invalid, and would come back to life if the port
 * returned.
 */

import { rosList } from './vlan';

export type RosRow = Record<string, string>;

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';

/** Names the manager creates bridges with: short, and safe in every RouterOS context. */
export const BRIDGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface BridgePortOp {
  action: 'set' | 'add' | 'remove';
  port: string;
  /** The bridge-port row, for set and remove. */
  id?: string;
}

export interface VlanEdit {
  id: string;
  bridge: string;
  vlanIds: string;
  tagged: string[];
  untagged: string[];
}

export interface BridgePortPlan {
  /** Set when the target bridge is created as part of the move. */
  createBridge?: string;
  /** Old bridges' VLAN rows that listed a moving port, without it. */
  vlanEdits: VlanEdit[];
  ops: BridgePortOp[];
  /** Ports already where they were asked to go. */
  unchanged: string[];
}

export function planBridgePortMove(input: {
  ports: string[];
  /** The bridge to move to, or null to take the ports out of any bridge. */
  target: string | null;
  createTarget?: boolean;
  bridgePorts: RosRow[];
  interfaces: RosRow[];
  /** Static and dynamic VLAN rows of every bridge; dynamic ones are left alone. */
  bridgeVlans: RosRow[];
}): { ok: true; plan: BridgePortPlan } | { ok: false; error: string } {
  const ports = [...new Set(input.ports.map((p) => p.trim()).filter(Boolean))];
  if (ports.length === 0) return { ok: false, error: 'Choose at least one port.' };

  const ifaceByName = new Map(input.interfaces.map((i) => [i['name'], i]));
  const target = input.target?.trim() || null;

  if (input.createTarget) {
    if (!target) return { ok: false, error: 'Give the new bridge a name.' };
    if (!BRIDGE_NAME.test(target)) {
      return { ok: false, error: 'Bridge names start with a letter or digit and use only letters, digits, dot, dash and underscore (up to 32).' };
    }
    if (ifaceByName.has(target)) return { ok: false, error: `There is already an interface called ${target}.` };
  } else if (target) {
    const t = ifaceByName.get(target);
    if (!t || t['type'] !== 'bridge') return { ok: false, error: `There is no bridge called ${target} on this device.` };
  }

  for (const port of ports) {
    const iface = ifaceByName.get(port);
    if (!iface) return { ok: false, error: `There is no interface called ${port} on this device.` };
    if (iface['type'] === 'bridge') return { ok: false, error: `${port} is a bridge. Bridges can't be put inside other bridges here.` };
    if (port === target) return { ok: false, error: `${port} can't be put inside itself.` };
    if (isTrue(iface['slave']) && !input.bridgePorts.some((r) => r['interface'] === port)) {
      return { ok: false, error: `${port} is a member of a bond. Move the bond instead.` };
    }
    const row = input.bridgePorts.find((r) => r['interface'] === port);
    if (row && isTrue(row['dynamic'])) {
      return { ok: false, error: `${port} was added to ${row['bridge']} automatically (by CAPsMAN or another service), so it can't be moved by hand.` };
    }
  }

  const plan: BridgePortPlan = { vlanEdits: [], ops: [], unchanged: [] };
  if (input.createTarget && target) plan.createBridge = target;

  const leaving = new Map<string, string[]>(); // old bridge -> ports leaving it
  for (const port of ports) {
    const row = input.bridgePorts.find((r) => r['interface'] === port);
    const current = row?.['bridge'] || null;
    if (current === target) { plan.unchanged.push(port); continue; }
    if (current) leaving.set(current, [...(leaving.get(current) ?? []), port]);
    if (!target) plan.ops.push({ action: 'remove', port, id: row!['.id'] });
    else if (row) plan.ops.push({ action: 'set', port, id: row['.id'] });
    else plan.ops.push({ action: 'add', port });
  }
  if (plan.ops.length === 0) {
    return { ok: false, error: target ? `Already in ${target}.` : 'Those ports are not in a bridge.' };
  }

  for (const [bridge, gone] of leaving) {
    for (const row of input.bridgeVlans) {
      if (row['bridge'] !== bridge || isTrue(row['dynamic']) || !row['.id']) continue;
      const tagged = rosList(row['tagged']);
      const untagged = rosList(row['untagged']);
      if (![...tagged, ...untagged].some((m) => gone.includes(m))) continue;
      plan.vlanEdits.push({
        id: row['.id'], bridge, vlanIds: row['vlan-ids'] || '',
        tagged: tagged.filter((m) => !gone.includes(m)),
        untagged: untagged.filter((m) => !gone.includes(m)),
      });
    }
  }
  return { ok: true, plan };
}

/**
 * Addresses and DHCP clients on ports about to join a bridge. Once a port is in
 * a bridge, an address on the port itself stops working: the classic way to cut
 * a router's internet is to drop the WAN port into the LAN bridge.
 */
export function addressesOnPorts(ports: string[], addresses: RosRow[], dhcpClients: RosRow[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    if (ports.includes(a['interface']) && !isTrue(a['dynamic'])) out.push(`${a['interface']} has address ${a['address']}`);
  }
  for (const d of dhcpClients) {
    if (ports.includes(d['interface'])) out.push(`${d['interface']} gets its address over DHCP`);
  }
  return out;
}

/** Why a bridge can't be deleted, or null. Only empty, unused bridges are. */
export function bridgeDeleteRefusal(bridge: string, rows: {
  bridgePorts: RosRow[]; addresses: RosRow[]; vlanInterfaces: RosRow[]; dhcpServers: RosRow[];
}): string | null {
  const members = rows.bridgePorts.filter((p) => p['bridge'] === bridge).map((p) => p['interface']);
  if (members.length) return `${bridge} still has ports (${members.join(', ')}). Move them out first.`;
  const addr = rows.addresses.find((a) => a['interface'] === bridge);
  if (addr) return `${bridge} has address ${addr['address']}. Remove it first.`;
  const vlan = rows.vlanInterfaces.find((v) => v['interface'] === bridge);
  if (vlan) return `VLAN interface ${vlan['name']} runs on ${bridge}. Remove it first.`;
  const dhcp = rows.dhcpServers.find((d) => d['interface'] === bridge);
  if (dhcp) return `DHCP server ${dhcp['name']} runs on ${bridge}. Remove it first.`;
  return null;
}
