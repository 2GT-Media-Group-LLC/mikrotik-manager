/**
 * Change analysis — "will this change cut the manager off from the device?"
 *
 * The approach is deliberately a simulation rather than pattern-matching on the
 * request: apply the planned change to an in-memory copy of the live device state,
 * then re-check the management-path invariants. An invariant that was satisfied
 * before and violated after is a predicted lockout, and the invariant explains
 * itself, so the warning names the actual mechanism instead of being generic.
 */
import { planVlanWrite } from '../../utils/bridgeVlanPlan';
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
    }
  | { kind: 'vlan.add'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.update'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.delete'; bridge: string; vlanId: number }
  | { kind: 'ip.remove'; addressId: string }
  | { kind: 'interface.disable'; name: string; disabled: boolean }
  | { kind: 'bond.delete'; name: string }
  | { kind: 'route.remove'; routeId: string }
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
  /**
   * A change the model can't simulate on an object the management path uses
   * (port speed, a bond's settings): not predicted to break, but reported as
   * a warning so auto-revert is required.
   */
  | { kind: 'path-object.change'; name: string; what: string }
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

const isDynamic = (row: RosRow): boolean => row['dynamic'] === 'true' || row['dynamic'] === 'yes';

/** Rewrite one VLAN row's membership, preserving the effective (`current-*`) view. */
function setMembership(row: RosRow, tagged: string[], untagged: string[]): void {
  row['tagged'] = join(tagged);
  row['untagged'] = join(untagged);
  row['current-tagged'] = row['tagged'];
  row['current-untagged'] = row['untagged'];
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
          : 'admit-only-vlan-tagged';
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
        if (plan.action === 'set' && row) { setMembership(row, csv(plan.tagged), csv(plan.untagged)); return; }
        const added: RosRow = { bridge, 'vlan-ids': String(vid), dynamic: 'false' };
        setMembership(added, csv(plan.tagged), csv(plan.untagged));
        s.bridgeVlans.push(added);
      };
      for (const vid of change.tagged) applyVlan(vid, 'tagged');
      for (const vid of change.untagged) applyVlan(vid, 'untagged');

      // The removal half, when requested. Mirrors planTaggedRemovals: static
      // rows only, whole rows only — a range row that still covers a kept VLAN
      // is left as it is, exactly as the device write leaves it.
      if (change.replaceTagged) {
        const keep = new Set(change.tagged);
        for (const row of s.bridgeVlans) {
          if (row['bridge'] !== bridge || isDynamic(row)) continue;
          const tagged = csv(row['current-tagged'] ?? row['tagged']);
          if (!tagged.includes(change.port)) continue;
          const vids = expandVlanIds(row['vlan-ids']);
          if (vids.some((v) => keep.has(v))) continue;
          setMembership(row, tagged.filter((p) => p !== change.port), csv(row['current-untagged'] ?? row['untagged']));
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
      setMembership(row, change.tagged, change.untagged);
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

    case 'interface.disable': {
      // By name, or by RouterOS id for callers that only have that (WireGuard).
      const iface = s.interfaces.find((i) => i['name'] === change.name || i['.id'] === change.name);
      if (iface) iface['disabled'] = change.disabled ? 'true' : 'false';
      break;
    }

    case 'bond.delete': {
      s.interfaces = s.interfaces.filter((i) => i['name'] !== change.name);
      s.bridgePorts = s.bridgePorts.filter((p) => p['interface'] !== change.name);
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
    } else if (a?.ok && a.uncertain && (!b?.uncertain || touchesFirewall(change))) {
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
