/**
 * Change analysis — "will this change cut the manager off from the device?"
 *
 * The approach is deliberately a simulation rather than pattern-matching on the
 * request: apply the planned change to an in-memory copy of the live device state,
 * then re-check the management-path invariants. An invariant that was satisfied
 * before and violated after is a predicted lockout, and the invariant explains
 * itself, so the warning names the actual mechanism instead of being generic.
 */
import { evaluate, INVARIANTS, type InvariantStatus } from './invariants';
import { resolveManagementPath, expandVlanIds, type DeviceSnapshot, type ManagementPath, type RosRow } from './pathModel';
import type { GuardDevice } from './ChangeGuard';

export type PlannedChange =
  | { kind: 'bridge.vlan-filtering'; bridge: string; enabled: boolean }
  | { kind: 'port.vlan'; port: string; pvid: number; tagged: number[]; untagged: number[] }
  | { kind: 'vlan.add'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.update'; bridge: string; vlanId: number; tagged: string[]; untagged: string[] }
  | { kind: 'vlan.delete'; bridge: string; vlanId: number }
  | { kind: 'ip.remove'; addressId: string }
  | { kind: 'interface.disable'; name: string; disabled: boolean }
  | { kind: 'bond.delete'; name: string }
  | { kind: 'route.remove'; routeId: string }
  | { kind: 'service.toggle'; serviceId: string; disabled: boolean };

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
      const bridge = port?.['bridge'];
      if (!bridge) break;

      // setPortVlanConfig only rewrites rows for the VLANs actually listed in the
      // request, and silently skips VLANs that have no row. Crucially it does NOT
      // strip the port from VLANs the caller didn't mention — modelling it as a
      // full replacement would invent violations that the real change never causes.
      for (const row of s.bridgeVlans) {
        if (row['bridge'] !== bridge) continue;
        const vids = expandVlanIds(row['vlan-ids']);
        const wantTagged = vids.some((v) => change.tagged.includes(v));
        const wantUntagged = vids.some((v) => change.untagged.includes(v));
        if (!wantTagged && !wantUntagged) continue;

        const tagged = csv(row['current-tagged'] ?? row['tagged']).filter((p) => p !== change.port);
        const untagged = csv(row['current-untagged'] ?? row['untagged']).filter((p) => p !== change.port);
        if (wantTagged) tagged.push(change.port);
        if (wantUntagged) untagged.push(change.port);
        setMembership(row, tagged, untagged);
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
      const iface = s.interfaces.find((i) => i['name'] === change.name);
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
  }

  return s;
}

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
