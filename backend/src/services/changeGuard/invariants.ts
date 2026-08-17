/**
 * Management-path invariants — the conditions that must hold for the manager to
 * keep reaching a device.
 *
 * Checking invariants beats maintaining a blocklist of "dangerous operations":
 * a blocklist only catches the change shapes someone thought of, which is exactly
 * how deleting an *unused* bond and editing a VLAN both slipped through. Here we
 * state what must remain true, then re-evaluate it against the post-change state,
 * so novel change shapes are covered for free.
 *
 * Rules follow MikroTik's own documentation: the bridge interface is the CPU port
 * and must be a tagged or untagged member of the management VLAN once
 * vlan-filtering is on, and PVID-derived untagged membership is added dynamically
 * (which is why effective `current-*` membership is what we test).
 */
import { detectLockoutRisk } from '../../utils/firewallSafety';
import { vlanMembership, type DeviceSnapshot, type ManagementPath } from './pathModel';
import type { GuardDevice } from './ChangeGuard';

export interface InvariantResult {
  ok: boolean;
  /** Explanation shown to the user when this flips to violated. */
  detail: string;
  /**
   * How bad a violation is. 'critical' = management is predicted to break.
   * 'warning' = it would survive only on a fragile assumption (e.g. a
   * dynamically-added PVID entry that a later change could remove).
   */
  severity?: 'critical' | 'warning';
}

export interface Invariant {
  id: string;
  title: string;
  check(snap: DeviceSnapshot, path: ManagementPath, device: GuardDevice): InvariantResult;
}

const isTrue = (v: string | undefined): boolean => v === 'true' || v === 'yes';
const stripCidr = (a: string): string => (a || '').split('/')[0].trim();
const ok = (detail = ''): InvariantResult => ({ ok: true, detail });

/**
 * Read vlan-filtering from the snapshot being evaluated, never from the resolved
 * path. The path is frozen at the pre-change state, so keying off it would make
 * "enable vlan-filtering" — the most important case to predict — invisible.
 */
const filteringOn = (snap: DeviceSnapshot, bridge: string | null): boolean =>
  !!bridge && isTrue(snap.bridges.find((b) => b['name'] === bridge)?.['vlan-filtering']);

export const INVARIANTS: Invariant[] = [
  {
    id: 'mgmt-ip-present',
    title: 'The management address still exists on the device',
    check(snap, path) {
      const found = snap.addresses.some(
        (a) => !isTrue(a['disabled']) && !isTrue(a['invalid']) && stripCidr(a['address']) === path.mgmtIp
      );
      return found
        ? ok()
        : { ok: false, detail: `No enabled IP address ${path.mgmtIp} would remain on the device — the manager connects to exactly that address.` };
    },
  },

  {
    id: 'mgmt-iface-up',
    title: 'The interface holding the management address is enabled',
    check(snap, path) {
      if (!path.mgmtInterface) return ok();
      const row = snap.interfaces.find((i) => i['name'] === path.mgmtInterface);
      if (!row) {
        return { ok: false, detail: `Interface ${path.mgmtInterface}, which holds the management address, would no longer exist.` };
      }
      return isTrue(row['disabled'])
        ? { ok: false, detail: `Interface ${path.mgmtInterface} holds the management address and would be disabled.` }
        : ok();
    },
  },

  {
    id: 'vlan-iface-tagged',
    title: 'The bridge is a tagged member of the management VLAN',
    check(snap, path) {
      // Only applies when management rides a tagged VLAN sub-interface on a
      // VLAN-filtering bridge.
      if (!path.taggedManagement || !path.bridge || !filteringOn(snap, path.bridge) || path.mgmtVlanId == null) {
        return ok();
      }
      const m = vlanMembership(snap, path.bridge, path.mgmtVlanId);
      if (!m.found) {
        return {
          ok: false,
          detail: `VLAN ${path.mgmtVlanId} would have no entry in ${path.bridge}'s VLAN table, so the bridge (the CPU port) could not receive tagged management traffic.`,
        };
      }
      return m.tagged.includes(path.bridge)
        ? ok()
        : {
            ok: false,
            detail: `${path.bridge} would not be a tagged member of VLAN ${path.mgmtVlanId}. Management arrives tagged on that VLAN, and the bridge is the CPU port — without it, traffic never reaches the device's CPU.`,
          };
    },
  },

  {
    id: 'bridge-untagged-member',
    title: 'The bridge and ingress port are untagged members of the management VLAN',
    check(snap, path) {
      if (path.taggedManagement || !path.bridge || !filteringOn(snap, path.bridge) || path.mgmtVlanId == null) {
        return ok();
      }
      const vid = path.mgmtVlanId;
      const m = vlanMembership(snap, path.bridge, vid);

      // No entry for the management VLAN. RouterOS *may* re-add untagged membership
      // dynamically from the PVID, but that depends on frame-types and is exactly
      // the fragile assumption that strands devices — so treat it as a violation.
      // A device that already had no entry stays quiet: analyzeChange only reports
      // invariants that FLIP, so this fires on removal, not on pre-existing state.
      if (!m.found) {
        return {
          ok: false,
          detail: `VLAN ${vid} would have no entry in ${path.bridge}'s VLAN table. Management arrives untagged on that VLAN, and relying on RouterOS to re-add the bridge dynamically is not safe once VLAN filtering is on.`,
        };
      }

      if (!m.untagged.includes(path.bridge)) {
        return {
          ok: false,
          severity: 'critical',
          detail: `${path.bridge} would not be an untagged member of VLAN ${vid}. Management arrives untagged and the bridge is the CPU port — this is the single most common way to lock a MikroTik out of management.`,
        };
      }

      // Present, but only because RouterOS auto-added it from the PVID. That entry
      // disappears if the PVID or frame-types change, so management would be
      // resting on something the operator did not configure.
      if (!m.untaggedStatic.includes(path.bridge)) {
        return {
          ok: false,
          severity: 'warning',
          detail: `${path.bridge} would remain an untagged member of VLAN ${vid} only through a dynamic "added by pvid" entry, not a configured one. Management would keep working for now, but any later change to the bridge PVID or frame-types would remove it. Add ${path.bridge} to VLAN ${vid} explicitly.`,
        };
      }

      // The ingress port must be a member of the VLAN, but it need NOT be an
      // untagged one: a tagged trunk that also accepts untagged frames via its PVID
      // is a normal and correct configuration. Requiring "untagged" here produced a
      // false positive on real hardware — and because a violation that is already
      // present before a change is (rightly) not reported as a new one, that false
      // positive silently suppressed genuine detections.
      if (path.ingressPort && !m.untagged.includes(path.ingressPort) && !m.tagged.includes(path.ingressPort)) {
        return {
          ok: false,
          severity: 'critical',
          detail: `${path.ingressPort} — the port management traffic arrives on — would not be a member of VLAN ${vid} at all.`,
        };
      }
      return ok();
    },
  },

  {
    id: 'ingress-port-pvid',
    title: 'The ingress port still stamps the management VLAN',
    check(snap, path) {
      if (path.taggedManagement || !path.bridge || !filteringOn(snap, path.bridge)) return ok();
      if (!path.ingressPort || path.mgmtVlanId == null) return ok();
      const port = snap.bridgePorts.find(
        (p) => p['interface'] === path.ingressPort && p['bridge'] === path.bridge
      );
      if (!port) return ok(); // covered by ingress-port-member
      const pvid = parseInt(port['pvid'] || '', 10);
      return isNaN(pvid) || pvid === path.mgmtVlanId
        ? ok()
        : {
            ok: false,
            detail: `${path.ingressPort} would stamp untagged traffic with VLAN ${pvid} instead of the management VLAN ${path.mgmtVlanId}, moving management into a VLAN the CPU does not receive.`,
          };
    },
  },

  {
    id: 'ingress-port-member',
    title: 'The ingress port is still a member of the bridge and enabled',
    check(snap, path) {
      if (!path.ingressPort || !path.bridge) return ok();
      const member = snap.bridgePorts.some(
        (p) => p['interface'] === path.ingressPort && p['bridge'] === path.bridge && !isTrue(p['disabled'])
      );
      if (!member) {
        return {
          ok: false,
          detail: `${path.ingressPort} would no longer be an enabled member of ${path.bridge}, and that is the port management traffic arrives on.`,
        };
      }
      const iface = snap.interfaces.find((i) => i['name'] === path.ingressPort);
      return iface && isTrue(iface['disabled'])
        ? { ok: false, detail: `${path.ingressPort} would be disabled, and that is the port management traffic arrives on.` }
        : ok();
    },
  },

  {
    id: 'bond-has-slaves',
    title: 'The bond carrying management still has members',
    check(snap, path) {
      if (!path.ingressBond) return ok();
      const bond = snap.interfaces.find((i) => i['name'] === path.ingressBond);
      if (!bond) {
        return { ok: false, detail: `Bond ${path.ingressBond} carries management traffic and would no longer exist.` };
      }
      const slaves = (bond['slaves'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      return slaves.length > 0
        ? ok()
        : { ok: false, detail: `Bond ${path.ingressBond} carries management traffic and would be left with no member ports.` };
    },
  },

  {
    id: 'mgmt-service-open',
    title: 'The API service the manager uses stays enabled on its port',
    check(snap, path, device) {
      const wanted = device.api_port === 8729 ? 'api-ssl' : 'api';
      const svc = snap.services.find((s) => s['name'] === wanted);
      if (!svc) return ok();
      if (isTrue(svc['disabled'])) {
        return { ok: false, detail: `The ${wanted} service would be disabled — that is the service the manager connects through.` };
      }
      const port = parseInt(svc['port'] || '', 10);
      return !isNaN(port) && port !== device.api_port
        ? { ok: false, detail: `The ${wanted} service would move to port ${port}, but the manager connects on ${device.api_port}.` }
        : ok();
    },
  },

  {
    id: 'input-chain-permits',
    title: 'No input-chain rule blocks the management port',
    check(snap, path, device) {
      for (const rule of snap.firewallFilter) {
        const risk = detectLockoutRisk(rule, { mgmtPorts: [device.api_port] });
        if (risk.risky) {
          return { ok: false, detail: `A firewall rule would block management access: ${risk.reason}` };
        }
      }
      return ok();
    },
  },

  {
    id: 'route-to-manager',
    title: 'A route back toward the manager still exists',
    check(snap, path) {
      // Only meaningful when the manager is reached via a gateway rather than
      // being on the same subnet.
      if (path.ingressPortSource !== 'fdb-default-gw') return ok();
      const hasDefault = snap.routes.some(
        (r) => (r['dst-address'] || '') === '0.0.0.0/0' && r['active'] !== 'false' && !isTrue(r['disabled'])
      );
      return hasDefault
        ? ok()
        : { ok: false, detail: 'The default route would be removed, and the manager reaches this device through the default gateway.' };
    },
  },
];

export interface InvariantStatus {
  id: string;
  title: string;
  before: boolean;
  after: boolean;
  detail: string;
  severity: 'critical' | 'warning';
}

/** Evaluate every invariant against a snapshot for a fixed management path. */
export function evaluate(
  snap: DeviceSnapshot,
  path: ManagementPath,
  device: GuardDevice
): Map<string, InvariantResult> {
  const out = new Map<string, InvariantResult>();
  for (const inv of INVARIANTS) {
    try {
      out.set(inv.id, inv.check(snap, path, device));
    } catch (err) {
      // A broken check must never block a legitimate change.
      out.set(inv.id, { ok: true, detail: `check skipped: ${(err as Error).message}` });
    }
  }
  return out;
}
