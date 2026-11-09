/**
 * Change analysis — "will this change cut the manager off from the device?"
 *
 * The approach is deliberately a simulation rather than pattern-matching on the
 * request: apply the planned change to an in-memory copy of the live device state,
 * then re-check the management-path invariants. An invariant that was satisfied
 * before and violated after is a predicted lockout, and the invariant explains
 * itself, so the warning names the actual mechanism instead of being generic.
 */
import { planVlanWrite, planAccessRemovals, planTaggedRemovals } from '../../utils/bridgeVlanPlan';
import { evaluate, INVARIANTS, type InvariantStatus } from './invariants';
import { resolveManagementPath, expandVlanIds, type DeviceSnapshot, type ManagementPath, type RosRow } from './pathModel';
import type { GuardDevice } from './ChangeGuard';

export type PlannedChange =
  | { kind: 'bridge.vlan-filtering'; bridge: string; enabled: boolean }
  | {
      kind: 'port.vlan'; port: string; pvid: number; tagged: number[]; untagged: number[];
      /** Tagged list is the complete set: unlisted static tagged rows lose the port (#165). */
      replaceTagged?: boolean;
      /**
       * Set when the caller is also changing frame admission. Present from
       * v0.24.20; absent means only the PVID and membership move, which is a
       * materially smaller change (#151).
       */
      mode?: 'access' | 'trunk';
      /** A trunk that drops untagged frames. Otherwise a trunk admits all (1.0.11). */
      taggedOnly?: boolean;
    }
  | { kind: 'vlan.add'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.update'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.delete'; bridge: string; vlanId: number }
  | { kind: 'ip.remove'; addressId: string }
  /** Edit an address in place (#285); `fields` use RouterOS names, '' clears. */
  | { kind: 'ip.set'; addressId: string; fields: Record<string, string> }
  | { kind: 'interface.disable'; name: string; disabled: boolean }
  | { kind: 'bond.delete'; name: string }
  /** Ports into a bridge, or out of any bridge with `bridge: null` (#258). */
  | { kind: 'bridge-port.move'; ports: string[]; bridge: string | null }
  /** Delete a bridge; only empty ones are, but the model doesn't assume it. */
  | { kind: 'bridge.delete'; bridge: string }
  | { kind: 'route.remove'; routeId: string }
  /** A static route; `table` is the routing table (blank = main). */
  | { kind: 'route.add'; dstAddress: string; gateway: string; distance?: number; table?: string }
  | { kind: 'service.toggle'; serviceId: string; disabled: boolean }
  /**
   * Firewall filter edits. `fields` use RouterOS names; in firewall.set an
   * empty value clears the property, as DeviceCollector.setItem does.
   */
  | { kind: 'firewall.add'; fields: Record<string, string>; placeBefore?: string }
  | { kind: 'firewall.set'; ruleId: string; fields: Record<string, string> }
  | { kind: 'firewall.move'; ruleId: string; destination?: string }
  | { kind: 'firewall.remove'; ruleId: string }
  | { kind: 'address-list.add'; fields: Record<string, string> }
  | { kind: 'address-list.set'; entryId: string; fields: Record<string, string> }
  | { kind: 'address-list.remove'; entryId: string }
  // Interface lists and their members (#369 zones).
  | { kind: 'interface-list.add'; name: string }
  | { kind: 'interface-list.member.add'; list: string; interface: string }
  | { kind: 'interface-list.member.remove'; memberId: string }
  /**
   * A change the model can't simulate on an object the management path uses
   * (port speed, a bond's settings): not predicted to break, but reported as
   * a warning so auto-revert is required.
   */
  | { kind: 'path-object.change'; name: string; what: string }
  /** VLAN interfaces (#309). `fields` use RouterOS names; in set, '' clears. */
  | { kind: 'vlan-iface.add'; name: string; vlanId: number; parent: string; disabled?: boolean }
  | { kind: 'vlan-iface.set'; id: string; fields: Record<string, string> }
  | { kind: 'vlan-iface.remove'; id: string }
  /** Several changes applied in order, e.g. a VLAN copy. */
  | { kind: 'batch'; changes: PlannedChange[] };

export type Severity = 'safe' | 'warning' | 'critical';

export interface ChangeVerdict {
  severity: Severity;
  /** One-line summary suitable for a dialog heading. */
  headline: string;
  /** Invariants that flipped satisfied → violated. */
  violations: InvariantStatus[];
  /**
   * Invariants already violated before the change. Not caused by it, but reported
   * because they indicate the device is in a fragile state — and because a
   * pre-existing violation means that check cannot detect a new break.
   */
  preexisting: InvariantStatus[];
  /** Non-fatal concerns (including reduced confidence in the analysis itself). */
  warnings: string[];
  /** The management path the verdict was computed against, for explainability. */
  path: ManagementPath;
}

const clone = (snap: DeviceSnapshot): DeviceSnapshot =>
  JSON.parse(JSON.stringify(snap)) as DeviceSnapshot;

const csv = (v: string | undefined): string[] =>
  (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const join = (list: string[]): string => [...new Set(list)].filter(Boolean).join(',');

const isTrueValue = (v: string | undefined): boolean => v === 'true' || v === 'yes';

const isDynamic = (row: RosRow): boolean => row['dynamic'] === 'true' || row['dynamic'] === 'yes';

const BUILTIN_LISTS = new Set(['all', 'none', 'dynamic', 'static']);
const rowDisabled = (r: RosRow): boolean => r['disabled'] === 'true' || r['disabled'] === 'yes';

/**
 * The bridge ports an entry of a VLAN row's tagged/untagged list stands for.
 * A row can name an interface list (`tagged=all` is common), which RouterOS
 * expands into `current-*`. Undefined: a plain interface. Null: a list this
 * model can't expand (dynamic, static, or one built from other lists).
 */
function listPorts(snap: DeviceSnapshot, bridge: string, name: string): string[] | null | undefined {
  const isList = BUILTIN_LISTS.has(name) || (snap.interfaceLists ?? []).some((l) => l['name'] === name);
  if (!isList) return undefined;
  const ports = snap.bridgePorts.filter((p) => p['bridge'] === bridge && !rowDisabled(p)).map((p) => p['interface']);
  if (name === 'all') return ports;
  if (name === 'none') return [];
  if (name === 'dynamic' || name === 'static') return null;
  const def = (snap.interfaceLists ?? []).find((l) => l['name'] === name);
  if (!def || (def['include'] || '').trim() || (def['exclude'] || '').trim()) return null;
  const members = new Set((snap.interfaceListMembers ?? [])
    .filter((m) => m['list'] === name && !rowDisabled(m)).map((m) => m['interface']));
  return ports.filter((p) => members.has(p));
}

/** A configured list as RouterOS would show it in current-*, interface lists expanded. */
function effectiveMembers(snap: DeviceSnapshot, bridge: string, configured: string[], previous: string[], changed: string[]): string[] {
  const out = new Set<string>();
  let unknown = false;
  for (const name of configured) {
    const ports = listPorts(snap, bridge, name);
    if (ports === undefined) out.add(name);
    else if (ports === null) unknown = true;
    else for (const p of ports) out.add(p);
  }
  // A list we can't expand keeps the members it had, bar the port being changed.
  if (unknown) for (const p of previous) if (!changed.includes(p)) out.add(p);
  return [...out];
}

/**
 * Rewrite one VLAN row's membership. The effective (`current-*`) view is the
 * configured lists with any interface list expanded, as RouterOS does, so a
 * row like `tagged=all` keeps every port it covered (2GT-NW-100G, where
 * re-tagging VLAN 1 on sfp28-3 was predicted to drop sfp28-1 from it).
 */
function setMembership(row: RosRow, tagged: string[], untagged: string[], ctx?: { snap: DeviceSnapshot; changed: string[] }): void {
  const prevTagged = csv(row['current-tagged'] ?? row['tagged']);
  const prevUntagged = csv(row['current-untagged'] ?? row['untagged']);
  row['tagged'] = join(tagged);
  row['untagged'] = join(untagged);
  if (!ctx || !row['bridge']) {
    row['current-tagged'] = row['tagged'];
    row['current-untagged'] = row['untagged'];
    return;
  }
  const u = effectiveMembers(ctx.snap, row['bridge'], untagged, prevUntagged, ctx.changed);
  // A port listed untagged isn't tagged too, even when a list on the tagged side covers it.
  const t = effectiveMembers(ctx.snap, row['bridge'], tagged, prevTagged, ctx.changed).filter((p) => !u.includes(p));
  row['current-tagged'] = join(t);
  row['current-untagged'] = join(u);
}

/**
 * Apply a planned change to a copy of the snapshot. Only the fields the invariants
 * read need to be accurate — this is a reachability model, not a RouterOS emulator.
 */
export function simulate(snap: DeviceSnapshot, change: PlannedChange): DeviceSnapshot {
  const s = clone(snap);

  switch (change.kind) {
    case 'bridge.vlan-filtering': {
      const b = s.bridges.find((x) => x['name'] === change.bridge);
      if (b) b['vlan-filtering'] = change.enabled ? 'true' : 'false';
      break;
    }

    case 'port.vlan': {
      const port = s.bridgePorts.find((p) => p['interface'] === change.port);
      if (port) port['pvid'] = String(change.pvid);
      // Frame admission, when the caller is changing it. This matters more than
      // the PVID for lockout: admit-only-vlan-tagged on the port carrying
      // untagged management traffic cuts it off even though every VLAN row
      // still lists the port (#151).
      if (port && change.mode) {
        port['frame-types'] = change.mode === 'access'
          ? 'admit-only-untagged-and-priority-tagged'
          : change.taggedOnly ? 'admit-only-vlan-tagged' : 'admit-all';
        port['ingress-filtering'] = 'true';
      }
      const bridge = port?.['bridge'];
      if (!bridge) break;

      // Exactly what setPortVlanConfig does, using its own planner (P2-7):
      // the tagged VLANs first, then the untagged ones, each moving the port
      // between the lists, so a VLAN in both ends up untagged. Each VLAN's
      // row is the one whose vlan-ids is exactly that VLAN (the device query
      // the writer makes); with none, or only a dynamic one, a new static row
      // is added. VLANs not mentioned are left alone.
      const applyVlan = (vid: number, role: 'tagged' | 'untagged'): void => {
        const row = s.bridgeVlans.find((r) => r['bridge'] === bridge && (r['vlan-ids'] || '').trim() === String(vid));
        const plan = planVlanWrite(row ? { ...row, '.id': row['.id'] || 'sim' } : undefined, change.port, role);
        if (plan.action === 'noop') return;
        const ctx = { snap: s, changed: [change.port] };
        if (plan.action === 'set' && row) { setMembership(row, csv(plan.tagged), csv(plan.untagged), ctx); return; }
        const added: RosRow = { bridge, 'vlan-ids': String(vid), dynamic: 'false' };
        setMembership(added, csv(plan.tagged), csv(plan.untagged), ctx);
        s.bridgeVlans.push(added);
      };
      for (const vid of change.tagged) applyVlan(vid, 'tagged');
      for (const vid of change.untagged) applyVlan(vid, 'untagged');

      // The removal half, when requested, by the writer's own planner: static
      // rows only, whole rows only — a range row that still covers a kept VLAN
      // is left as it is, exactly as the device write leaves it. A trunk also
      // leaves the untagged rows other than its native VLAN's.
      if (change.replaceTagged) {
        const rows = s.bridgeVlans
          .map((row, i) => ({ row, i }))
          .filter(({ row }) => row['bridge'] === bridge);
        const native = change.mode === 'trunk' ? (change.taggedOnly ? null : change.pvid) : undefined;
        const plan = planTaggedRemovals(rows.map(({ row, i }) => ({
          '.id': String(i), bridge, dynamic: row['dynamic'], 'vlan-ids': row['vlan-ids'],
          tagged: row['current-tagged'] ?? row['tagged'], untagged: row['current-untagged'] ?? row['untagged'],
        })), bridge, change.port, change.tagged, native);
        for (const w of plan.writes) {
          const row = s.bridgeVlans[Number(w.id)];
          if (row) setMembership(row, csv(w.tagged), csv(w.untagged));
        }
      }
      // An access port leaves every VLAN but its PVID's, by the writer's own
      // planner: taking the management uplink to access drops its tagged
      // management VLAN, and that has to be predicted.
      if (change.mode === 'access') {
        const rows = s.bridgeVlans
          .map((row, i) => ({ row, i }))
          .filter(({ row }) => row['bridge'] === bridge);
        const plan = planAccessRemovals(rows.map(({ row, i }) => ({
          '.id': String(i), bridge, dynamic: row['dynamic'], 'vlan-ids': row['vlan-ids'],
          tagged: row['current-tagged'] ?? row['tagged'], untagged: row['current-untagged'] ?? row['untagged'],
        })), bridge, change.port, change.pvid);
        for (const w of plan.writes) {
          const row = s.bridgeVlans[Number(w.id)];
          if (row) setMembership(row, csv(w.tagged), csv(w.untagged), { snap: s, changed: [change.port] });
        }
      }
      break;
    }

    // updateBridgeVlan is remove-then-add, and removeBridgeVlan removes EVERY row
    // matching the VID — not just the first. Dynamic rows survive, because RouterOS
    // refuses to delete them and the collector swallows that error.
    case 'vlan.add':
    case 'vlan.update': {
      s.bridgeVlans = s.bridgeVlans.filter(
        (r) => !(r['bridge'] === change.bridge
          && expandVlanIds(r['vlan-ids']).includes(change.vlanId)
          && !isDynamic(r))
      );
      const row: RosRow = { bridge: change.bridge, 'vlan-ids': String(change.vlanId), dynamic: 'false' };
      setMembership(row, change.tagged, change.untagged, { snap: s, changed: [] });
      s.bridgeVlans.push(row);
      break;
    }

    case 'vlan.delete': {
      s.bridgeVlans = s.bridgeVlans.filter(
        (r) => !(r['bridge'] === change.bridge
          && expandVlanIds(r['vlan-ids']).includes(change.vlanId)
          && !isDynamic(r))
      );
      break;
    }

    case 'ip.remove': {
      s.addresses = s.addresses.filter((a) => a['.id'] !== change.addressId);
      break;
    }

    case 'ip.set': {
      s.addresses = s.addresses.map((a) => {
        if (a['.id'] !== change.addressId) return a;
        const row = mergeFields(a, change.fields);
        // As RouterOS does: an address on a bridge port is held by the bridge.
        const to = change.fields['interface'];
        if (to) {
          const port = s.bridgePorts.find((p) => p['interface'] === to && p['disabled'] !== 'true' && p['disabled'] !== 'yes');
          row['actual-interface'] = port?.['bridge'] || to;
        }
        return row;
      });
      break;
    }

    case 'interface.disable': {
      // By name, or by RouterOS id for callers that only have that (WireGuard).
      const iface = s.interfaces.find((i) => i['name'] === change.name || i['.id'] === change.name);
      if (iface) iface['disabled'] = change.disabled ? 'true' : 'false';
      break;
    }

    // What moveBridgePorts does: a port in a bridge moves with its row (PVID and
    // frame admission back to the defaults), one that isn't gets a new row, and
    // the old bridges' static VLAN rows stop listing it.
    case 'bridge-port.move': {
      for (const port of change.ports) {
        const row = s.bridgePorts.find((p) => p['interface'] === port);
        const from = row?.['bridge'];
        if (from === (change.bridge ?? undefined)) continue;
        if (from) {
          for (const v of s.bridgeVlans) {
            if (v['bridge'] !== from || isDynamic(v)) continue;
            const tagged = csv(v['current-tagged'] ?? v['tagged']);
            const untagged = csv(v['current-untagged'] ?? v['untagged']);
            if (!tagged.includes(port) && !untagged.includes(port)) continue;
            setMembership(v, tagged.filter((m) => m !== port), untagged.filter((m) => m !== port));
          }
        }
        if (!change.bridge) {
          s.bridgePorts = s.bridgePorts.filter((p) => p['interface'] !== port);
        } else if (row) {
          row['bridge'] = change.bridge;
          row['pvid'] = '1';
          row['frame-types'] = 'admit-all';
        } else {
          s.bridgePorts.push({ interface: port, bridge: change.bridge, pvid: '1', 'frame-types': 'admit-all', disabled: 'false' });
        }
      }
      break;
    }

    case 'bridge.delete': {
      s.bridges = s.bridges.filter((b) => b['name'] !== change.bridge);
      s.interfaces = s.interfaces.filter((i) => i['name'] !== change.bridge);
      s.bridgePorts = s.bridgePorts.filter((p) => p['bridge'] !== change.bridge);
      s.addresses = s.addresses.filter((a) => a['interface'] !== change.bridge);
      break;
    }

    case 'bond.delete': {
      s.interfaces = s.interfaces.filter((i) => i['name'] !== change.name);
      s.bridgePorts = s.bridgePorts.filter((p) => p['interface'] !== change.name);
      break;
    }

    case 'route.add': {
      const row: RosRow = {
        '.id': '*simulated',
        'dst-address': change.dstAddress,
        gateway: change.gateway,
        distance: String(change.distance ?? 1),
        'routing-table': change.table || 'main',
        active: 'true',
      };
      s.routes = [...s.routes, row];
      break;
    }

    case 'route.remove': {
      s.routes = s.routes.filter((r) => r['.id'] !== change.routeId);
      break;
    }

    case 'service.toggle': {
      const svc = s.services.find((x) => x['.id'] === change.serviceId || x['name'] === change.serviceId);
      if (svc) svc['disabled'] = change.disabled ? 'true' : 'false';
      break;
    }

    // RouterOS appends a new rule to the end of the table unless told where.
    case 'firewall.add': {
      const row: RosRow = { '.id': '*simulated', ...change.fields };
      const at = change.placeBefore ? s.firewallFilter.findIndex((r) => r['.id'] === change.placeBefore) : -1;
      if (at >= 0) s.firewallFilter.splice(at, 0, row); else s.firewallFilter.push(row);
      break;
    }

    case 'firewall.set': {
      s.firewallFilter = s.firewallFilter.map((r) => (r['.id'] === change.ruleId ? mergeFields(r, change.fields) : r));
      break;
    }

    // `move` puts the rule before `destination`, or at the end without one.
    case 'firewall.move': {
      const from = s.firewallFilter.findIndex((r) => r['.id'] === change.ruleId);
      if (from < 0) break;
      const [rule] = s.firewallFilter.splice(from, 1);
      const to = change.destination ? s.firewallFilter.findIndex((r) => r['.id'] === change.destination) : -1;
      if (to >= 0) s.firewallFilter.splice(to, 0, rule); else s.firewallFilter.push(rule);
      break;
    }

    case 'firewall.remove': {
      s.firewallFilter = s.firewallFilter.filter((r) => r['.id'] !== change.ruleId);
      break;
    }

    case 'address-list.add': {
      s.addressLists = [...(s.addressLists ?? []), { '.id': '*simulated', ...change.fields }];
      break;
    }

    case 'address-list.set': {
      const entry = (s.addressLists ?? []).find((e) => e['.id'] === change.entryId);
      if (entry) {
        s.addressLists = (s.addressLists ?? []).map((e) => (e === entry ? mergeFields(e, change.fields) : e));
      } else if (change.fields['list']) {
        // An entry we didn't read is moving into a list; that list can no
        // longer be vouched for.
        s.addressListsRead = (s.addressListsRead ?? []).filter((l) => l !== change.fields['list']);
      }
      break;
    }

    case 'address-list.remove': {
      s.addressLists = (s.addressLists ?? []).filter((e) => e['.id'] !== change.entryId);
      break;
    }

    case 'interface-list.add': {
      s.interfaceLists = [...(s.interfaceLists ?? []), { '.id': '*simulated', name: change.name }];
      break;
    }

    case 'interface-list.member.add': {
      s.interfaceListMembers = [...(s.interfaceListMembers ?? []), { '.id': '*simulated', list: change.list, interface: change.interface }];
      break;
    }

    case 'interface-list.member.remove': {
      s.interfaceListMembers = (s.interfaceListMembers ?? []).filter((m) => m['.id'] !== change.memberId);
      break;
    }

    case 'vlan-iface.add': {
      const disabled = change.disabled ? 'true' : 'false';
      s.vlanInterfaces.push({ name: change.name, 'vlan-id': String(change.vlanId), interface: change.parent, disabled });
      s.interfaces.push({ name: change.name, type: 'vlan', disabled });
      break;
    }

    // A rename isn't simulated: RouterOS carries it into everything that names
    // the interface (addresses, bridge VLANs, firewall), so it moves nothing.
    case 'vlan-iface.set': {
      const row = s.vlanInterfaces.find((v) => v['.id'] === change.id);
      if (!row) break;
      const fields = Object.fromEntries(Object.entries(change.fields).filter(([k]) => k !== 'name'));
      const merged = mergeFields(row, fields);
      s.vlanInterfaces = s.vlanInterfaces.map((v) => (v === row ? merged : v));
      if (change.fields['disabled'] !== undefined) {
        const iface = s.interfaces.find((x) => x['name'] === row['name']);
        if (iface) iface['disabled'] = isTrueValue(change.fields['disabled']) ? 'true' : 'false';
      }
      break;
    }

    // Its addresses go with it (DeviceCollector.removeVlanInterface).
    case 'vlan-iface.remove': {
      const row = s.vlanInterfaces.find((v) => v['.id'] === change.id);
      if (!row) break;
      const name = row['name'];
      s.vlanInterfaces = s.vlanInterfaces.filter((v) => v !== row);
      s.interfaces = s.interfaces.filter((x) => x['name'] !== name);
      s.addresses = s.addresses.filter((a) => (a['actual-interface'] || a['interface']) !== name);
      break;
    }

    case 'path-object.change':
      break; // not simulated; see analyzeChange

    case 'batch': {
      let cur = s;
      for (const c of change.changes) cur = simulate(cur, c);
      return cur;
    }
  }

  return s;
}

/** RouterOS property names; anything else in a request is ignored. */
const ROS_PROPERTY = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/**
 * A row with edited fields applied; an empty value clears the property.
 * Builds a new row from RouterOS-shaped names only, so request-supplied keys
 * never land on an existing object (CodeQL js/remote-property-injection).
 */
function mergeFields(row: RosRow, fields: Record<string, string>): RosRow {
  const edits = new Map(Object.entries(fields).filter(([k]) => ROS_PROPERTY.test(k)));
  const kept = Object.entries(row).filter(([k]) => !edits.has(k));
  const set = [...edits].filter(([, v]) => v !== '');
  return Object.fromEntries([...kept, ...set]);
}

/** Ports, bonds and the bridge itself, among those of `bridge`, that a change touches. */
function touchedPorts(snap: DeviceSnapshot, change: PlannedChange, bridge: string): string[] {
  const inScope = (n: string): boolean =>
    n === bridge
    || snap.bridgePorts.some((p) => p['interface'] === n && p['bridge'] === bridge)
    || snap.bonds.some((b) => b['name'] === n);
  const names = (c: PlannedChange): string[] => {
    switch (c.kind) {
      case 'batch': return c.changes.flatMap(names);
      case 'port.vlan': return [c.port];
      case 'bridge-port.move': return c.ports;
      case 'interface.disable': return [c.name];
      case 'bond.delete': return [c.name];
      case 'path-object.change': return [c.name];
      case 'vlan.add':
      case 'vlan.update': return [...c.tagged, ...c.untagged];
      case 'vlan.delete':
      case 'bridge.delete':
      case 'bridge.vlan-filtering': return [c.bridge];
      default: return [];
    }
  };
  return [...new Set(names(change).filter(inScope))];
}

/** Objects the management path runs through, by name. */
function pathObjects(path: ManagementPath): Set<string> {
  const names = path.hops.map((h) => h.name);
  if (path.mgmtInterface) names.push(path.mgmtInterface);
  if (path.ingressPort) names.push(path.ingressPort);
  if (path.ingressBond) names.push(path.ingressBond);
  if (path.bridge) names.push(path.bridge);
  return new Set(names);
}

function pathObjectChanges(change: PlannedChange): { name: string; what: string }[] {
  if (change.kind === 'path-object.change') return [{ name: change.name, what: change.what }];
  if (change.kind === 'batch') return change.changes.flatMap(pathObjectChanges);
  return [];
}

const touchesFirewall = (change: PlannedChange): boolean =>
  change.kind.startsWith('firewall.') || change.kind.startsWith('address-list.')
  || (change.kind === 'batch' && change.changes.some(touchesFirewall));

/**
 * Compare invariants before and after. The management path is resolved once, on the
 * *current* state — the question is whether the path the manager is using right now
 * survives, not what a hypothetical new path might look like.
 */
export function analyzeChange(
  snap: DeviceSnapshot,
  device: GuardDevice,
  change: PlannedChange
): ChangeVerdict {
  const path = resolveManagementPath(snap, device);
  const before = evaluate(snap, path, device);
  const after = evaluate(simulate(snap, change), path, device);

  const violations: InvariantStatus[] = [];
  const preexisting: InvariantStatus[] = [];
  for (const inv of INVARIANTS) {
    const b = before.get(inv.id);
    const a = after.get(inv.id);
    // A violation already present is not this change's doing, but one that gets
    // WORSE is: a pre-existing warning must not hide a new critical break.
    const worse = !!b && !b.ok && !!a && !a.ok
      && (a.severity ?? 'critical') === 'critical' && (b.severity ?? 'critical') === 'warning';
    if (worse && a) {
      violations.push({
        id: inv.id, title: inv.title, before: false, after: false,
        detail: a.detail, severity: 'critical',
      });
    }
    if (b && !b.ok) {
      preexisting.push({
        id: inv.id,
        title: inv.title,
        before: false,
        after: !!a?.ok,
        detail: b.detail,
        severity: b.severity ?? 'critical',
      });
      continue; // already broken; a "new" break can't be attributed to this change
    }
    if (b?.ok && a && !a.ok) {
      violations.push({
        id: inv.id,
        title: inv.title,
        before: true,
        after: false,
        detail: a.detail,
        severity: a.severity ?? 'critical',
      });
    } else if (a?.ok && a.uncertain && (!b?.uncertain || a.failed || touchesFirewall(change))) {
      // Not predicted to break, but the check can't vouch for it either:
      // either this change made it uncertain, or it edits the very rules the
      // check couldn't fully evaluate.
      violations.push({
        id: inv.id,
        title: inv.title,
        before: true,
        after: true,
        detail: a.detail,
        severity: 'warning',
      });
    }
  }

  const onPath = pathObjects(path);
  for (const p of pathObjectChanges(change)) {
    if (!onPath.has(p.name)) continue;
    violations.push({
      id: 'path-object-change',
      title: 'An object the management path uses is being changed',
      before: true,
      after: true,
      detail: `${p.what} on ${p.name}, which the manager's connection runs through. ` +
        `This can't be simulated, so it runs only with auto-revert.`,
      severity: 'warning',
    });
  }

  // Port-level changes judged without knowing where management enters. Nothing
  // above can fail for a port it cannot name, so the verdict would be a clean
  // "safe"; make it a warning, which makes auto-revert mandatory. (A guess from
  // the default gateway is left to the invariants: it is still a named port.)
  if (path.bridge && path.ingressPortSource === 'unknown') {
    const touched = touchedPorts(snap, change, path.bridge);
    if (touched.length > 0) {
      violations.push({
        id: 'ingress-port-unknown',
        title: 'Where management enters the device is not certain',
        before: true,
        after: true,
        detail: `Which port management arrives on could not be determined, and this change touches ${touched.join(', ')} on ${path.bridge}. ` +
          `It can't be checked, so it runs only with auto-revert.`,
        severity: 'warning',
      });
    }
  }

  const warnings = [...path.warnings];
  for (const p of preexisting) {
    warnings.push(`Pre-existing issue (not caused by this change): ${p.detail}`);
  }
  // Say so plainly when the analysis itself is running blind, rather than implying
  // a clean bill of health.
  if (path.ingressPortSource === 'unknown' && path.bridge) {
    warnings.push('The ingress port could not be determined, so port-level checks were skipped — treat a "safe" result here with caution.');
  }

  const hasCritical = violations.some((v) => v.severity === 'critical');
  const severity: Severity = hasCritical ? 'critical' : violations.length > 0 ? 'warning' : 'safe';
  const headline =
    severity === 'critical'
      ? `This change is predicted to cut management access to ${device.name}.`
      : severity === 'warning'
        ? `This change leaves management on ${device.name} in a fragile state.`
        : `No management-path problem predicted for ${device.name}.`;

  return { severity, headline, violations, preexisting, warnings, path };
}
