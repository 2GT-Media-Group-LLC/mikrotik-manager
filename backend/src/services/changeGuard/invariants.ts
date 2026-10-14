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
import { evaluateInputChain } from './firewallPath';
import { vlanMembership, routeFor, routeUsable, type DeviceSnapshot, type ManagementPath } from './pathModel';
import type { GuardDevice } from './ChangeGuard';
import { managementService } from '../../utils/apiTls';

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
  /**
   * Satisfied as far as the check can tell, but it depends on something the
   * model can't evaluate. A change that leaves an invariant uncertain is
   * reported as a warning, which makes auto-revert mandatory for it.
   */
  uncertain?: boolean;
  /** The check itself threw, so it says nothing either way (set by `evaluate`). */
  failed?: boolean;
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
    id: 'mgmt-parent-up',
    title: 'The port under the management VLAN interface is enabled',
    check(snap, path) {
      // A VLAN interface on a plain port (not a bridge) rides that port. It was
      // never checked, so disabling ether1 under vlan10 passed as safe (P2-7).
      if (!path.mgmtParent) return ok();
      const row = snap.interfaces.find((i) => i['name'] === path.mgmtParent);
      if (!row) {
        return { ok: false, detail: `${path.mgmtParent}, the port under the management VLAN interface ${path.mgmtInterface}, would no longer exist.` };
      }
      return isTrue(row['disabled'])
        ? { ok: false, detail: `${path.mgmtParent} carries the management VLAN interface ${path.mgmtInterface} and would be disabled.` }
        : ok();
    },
  },

  {
    id: 'mgmt-not-bridge-slave',
    title: 'The port carrying management is not swallowed by a bridge',
    check(snap, path) {
      // Management addressed directly on a port, or on a VLAN interface whose
      // parent is a plain port, only works while that port is NOT a bridge slave:
      // RouterOS hands a slave's frames to the bridge, so the address (or the
      // VLAN interface) on it stops receiving anything.
      const port = path.mgmtParent ?? path.mgmtInterface;
      if (!port || port === path.bridge) return ok();
      const row = snap.interfaces.find((i) => i['name'] === port);
      if (row && !['ether', 'bond', 'sfp', 'wlan', 'wifi'].some((t) => (row['type'] || 'ether').startsWith(t))) return ok();
      const slave = snap.bridgePorts.find((p) => p['interface'] === port && !isTrue(p['disabled']));
      return slave
        ? {
            ok: false,
            severity: 'critical',
            detail: `${port} carries management (${path.mgmtParent ? `under ${path.mgmtInterface}` : path.mgmtIp}) and would become a port of bridge ${slave['bridge']}. A bridge port hands its frames to the bridge, so management on it would stop working.`,
          }
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

      return ok();
    },
  },

  {
    id: 'ingress-port-pvid',
    title: 'The ingress port still stamps the management VLAN',
    check(snap, path) {
      // Whenever management arrives untagged on the port, including an access
      // port feeding a tagged VLAN interface (P2-7).
      if (path.ingressTagged || !path.bridge || !filteringOn(snap, path.bridge)) return ok();
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
    id: 'ingress-port-tagged-member',
    title: 'The ingress port still carries the tagged management VLAN',
    check(snap, path) {
      // The tagged counterpart of ingress-port-pvid. Nothing checked this until
      // #165 made unticking a VLAN in the port editor actually remove it: the
      // bridge could stay a tagged member while the uplink the manager arrives
      // on was dropped from the VLAN, and the frames would be filtered at ingress.
      if (!path.taggedManagement || !path.bridge || !filteringOn(snap, path.bridge)) return ok();
      if (!path.ingressPort || path.mgmtVlanId == null) return ok();
      const m = vlanMembership(snap, path.bridge, path.mgmtVlanId);
      if (!m.found) return ok(); // covered by vlan-iface-tagged
      // An access port carries the VLAN untagged; requiring "tagged" there was
      // false before any change, so it could never flip and real breakage on
      // that port went unreported (P2-7).
      if (!path.ingressTagged) {
        return m.untagged.includes(path.ingressPort) || m.tagged.includes(path.ingressPort)
          ? ok()
          : {
              ok: false,
              severity: 'critical',
              detail: `${path.ingressPort} — the access port management arrives on — would no longer be a member of VLAN ${path.mgmtVlanId}.`,
            };
      }
      return m.tagged.includes(path.ingressPort)
        ? ok()
        : {
            ok: false,
            detail: `${path.ingressPort} would no longer be a tagged member of VLAN ${path.mgmtVlanId}. Management arrives tagged on that VLAN through ${path.ingressPort}, so the bridge would drop it at ingress.`,
          };
    },
  },

  {
    id: 'ingress-port-frame-types',
    title: 'The ingress port still admits the frames management arrives in',
    /**
     * Added with #151, when setPortVlanConfig began writing frame-types.
     *
     * Until then nothing set frame admission, so no invariant modelled it — the
     * other checks here only mention it in passing. It strands a device more
     * directly than the PVID does: admit-only-vlan-tagged on the port carrying
     * untagged management drops those frames at ingress, while every VLAN table
     * row still lists the port and every other invariant stays satisfied.
     */
    check(snap, path) {
      if (!path.ingressPort || !path.bridge || !filteringOn(snap, path.bridge)) return ok();
      const port = snap.bridgePorts.find(
        (p) => p['interface'] === path.ingressPort && p['bridge'] === path.bridge
      );
      if (!port) return ok(); // covered by ingress-port-member
      const frames = (port['frame-types'] || '').trim();
      if (!frames || frames === 'admit-all') return ok();

      if (!path.ingressTagged && frames === 'admit-only-vlan-tagged') {
        return {
          ok: false,
          severity: 'critical',
          detail: `${path.ingressPort} would accept only VLAN-tagged frames, but management arrives untagged on it. Those frames would be dropped at ingress even though the VLAN table still lists the port.`,
        };
      }
      if (path.ingressTagged && frames === 'admit-only-untagged-and-priority-tagged') {
        return {
          ok: false,
          severity: 'critical',
          detail: `${path.ingressPort} would accept only untagged frames, but management arrives tagged on VLAN ${path.mgmtVlanId ?? '?'}. Those frames would be dropped at ingress.`,
        };
      }
      return ok();
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
      const wanted = managementService(device);
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
    title: 'The input chain still lets the manager in',
    check(snap, path, device) {
      const verdict = evaluateInputChain(snap, {
        srcIp: path.managerIp,
        dstIp: device.ip_address,
        dstPort: device.api_port,
        inInterface: path.mgmtInterface,
      });
      if (verdict.outcome === 'dropped') return { ok: false, detail: verdict.reason };
      if (verdict.outcome === 'unknown') return { ok: true, uncertain: true, detail: verdict.reason };
      return ok(verdict.reason);
    },
  },

  {
    id: 'route-to-manager',
    title: 'A route back toward the manager still exists',
    check(snap, path) {
      // Only meaningful when the manager is reached through a gateway rather
      // than being on the same subnet. It used to be checked only when the
      // path had been inferred from the default gateway, so removing a
      // specific route to the manager passed as safe (P2-7).
      if (!path.managerGateway) return ok();
      // The route the device would actually pick (longest prefix, main table, not a
      // blackhole). "Some route covers the manager" was satisfied by a default
      // route pointing somewhere else entirely.
      const target = path.managerIp ?? '0.0.0.0';
      const best = path.managerIp
        ? routeFor(snap, path.managerIp)
        : snap.routes.find((r) => (r['dst-address'] || '') === '0.0.0.0/0' && routeUsable(r)) ?? null;
      if (!best) {
        return path.managerIp
          ? { ok: false, detail: `No route toward the manager (${target}) would remain; it is reached through ${path.managerGateway}.` }
          : { ok: false, detail: 'The default route would be removed, and the manager reaches this device through the default gateway.' };
      }
      const gw = (best['gateway'] || '').split('%')[0].trim();
      const via = [gw, (best['immediate-gw'] || '').split('%')[0].trim()];
      if (!via.includes(path.managerGateway)) {
        return {
          ok: true,
          uncertain: true,
          detail: `The route back toward the manager would go through ${gw || best['dst-address']} instead of ${path.managerGateway}. That may be fine, but the model cannot confirm the manager is reachable that way.`,
        };
      }
      return ok();
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
      // A broken check must not block a legitimate change, but it must not
      // vouch for it either: report it uncertain so protection is mandatory.
      console.warn(`[ChangeGuard] invariant ${inv.id} threw: ${(err as Error).message}`);
      out.set(inv.id, { ok: true, uncertain: true, failed: true, detail: `${inv.title}: this check could not be evaluated (${(err as Error).message}).` });
    }
  }
  return out;
}
