/**
 * Which device is the spanning-tree root, per connected component.
 *
 * This was previously inferred: find a device with no port whose role is "root".
 * The inference never fired, because RouterOS reports the role as "root-port"
 * and the comparison was against "root" — so no device ever matched and the
 * topology crowned whichever device happened to sort first, consistently and
 * confidently (#131).
 *
 * The device already knows the answer. `/interface/bridge/monitor` reports
 * whether it is the root and names the root it can see, so the job here is
 * reading that rather than deducing it.
 *
 * Two properties of real networks shape the result:
 *
 * **There is a root per spanning tree, not per fleet.** Separate bridge domains
 * each have their own, and on a small mixed fleet several devices legitimately
 * report `root-bridge: true` at once. Roots are therefore resolved within a
 * connected component.
 *
 * **The root may not be ours.** A managed switch can point at a bridge id
 * belonging to equipment nobody has added. Naming a local device in that case
 * would be worse than admitting we cannot see it.
 */

export interface BridgeInfo {
  device_id: number;
  bridge_name: string;
  bridge_id: string | null;
  root_bridge: boolean | null;
  root_bridge_id: string | null;
  root_port: string | null;
  root_path_cost: number | null;
  protocol_mode: string | null;
}

export type RootConfidence =
  /** A device in this component reports itself as root. */
  | 'reported'
  /** No local device claims it, but one owns the bridge id others point at. */
  | 'matched'
  /** Devices agree on a root we do not manage. */
  | 'external'
  /** Nothing usable; the caller should fall back to a connectivity heuristic. */
  | 'unknown';

export interface RootVerdict {
  /** Device id as a string, matching topology node ids. Null when not ours. */
  deviceId: string | null;
  confidence: RootConfidence;
  /** The bridge id of the actual root, when known — shown when it is not ours. */
  rootBridgeId: string | null;
}

/** Bridge ids are compared case-insensitively; RouterOS is inconsistent about MAC case. */
const norm = (id: string | null | undefined): string => (id || '').trim().toLowerCase();

/**
 * Resolve the root for one component.
 *
 * `componentDeviceIds` are the managed devices in this component, as strings.
 */
export function resolveStpRoot(
  componentDeviceIds: string[],
  bridges: BridgeInfo[],
): RootVerdict {
  const inComponent = new Set(componentDeviceIds);
  const local = bridges.filter((b) => inComponent.has(String(b.device_id)));
  if (local.length === 0) return { deviceId: null, confidence: 'unknown', rootBridgeId: null };

  // A device that says it is the root, is the root.
  const claims = local.filter((b) => b.root_bridge === true);
  if (claims.length === 1) {
    return { deviceId: String(claims[0].device_id), confidence: 'reported', rootBridgeId: claims[0].bridge_id };
  }

  // Several claims inside one component means several bridge domains share it —
  // a device bridging two segments, for instance. Prefer the one others actually
  // point at; that is the tree the component is really hanging from.
  const pointedAt = new Set(local.map((b) => norm(b.root_bridge_id)).filter(Boolean));
  if (claims.length > 1) {
    const agreed = claims.find((b) => pointedAt.has(norm(b.bridge_id)));
    const chosen = agreed ?? claims[0];
    return { deviceId: String(chosen.device_id), confidence: agreed ? 'reported' : 'matched', rootBridgeId: chosen.bridge_id };
  }

  // Nobody claims it. Does anyone own the bridge id the others are pointing at?
  for (const target of pointedAt) {
    const owner = local.find((b) => norm(b.bridge_id) === target);
    if (owner) {
      return { deviceId: String(owner.device_id), confidence: 'matched', rootBridgeId: owner.bridge_id };
    }
  }

  // They agree on something we do not manage. Say so rather than nominating one
  // of ours, which is exactly the mistake this replaces.
  const external = [...pointedAt][0];
  if (external) {
    const withId = local.find((b) => norm(b.root_bridge_id) === external);
    return { deviceId: null, confidence: 'external', rootBridgeId: withId?.root_bridge_id ?? null };
  }

  return { deviceId: null, confidence: 'unknown', rootBridgeId: null };
}

/** Priority out of a bridge id like "0x8000.F4:1E:57:51:74:1E", for display. */
export function bridgePriority(bridgeId: string | null): number | null {
  const m = (bridgeId || '').match(/^0x([0-9a-f]+)\./i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}
