/**
 * Which selected devices carry other selected devices' traffic (issue #135).
 *
 * Upgrading devices concurrently means several reboot at the same time. That is
 * fine for independent routers and dangerous for a switch the others are
 * reached *through*: it takes them offline mid-upgrade, and the manager loses
 * the path to devices it is in the middle of changing.
 *
 * Change Guard does not help here. It protects configuration — a device that
 * stops answering after a config change reverts itself — but a device that is
 * unreachable because its uplink rebooted has nothing to revert.
 *
 * ## Why this is deliberately conservative
 *
 * The obvious implementation — "flag any device another selected device links
 * to" — reports the entire fleet. Discovered links are bidirectional (both ends
 * run LLDP), and a single trunk interface frequently resolves to several
 * neighbours at once, which the topology view already surfaces as ambiguity. On
 * a real four-device fleet that approach flagged all four.
 *
 * A warning that fires on everything is worse than no warning: it trains people
 * to dismiss it. So two conditions must both hold:
 *
 *   1. The link is the reporting device's **root port** — its own path toward
 *      the spanning-tree root, i.e. genuinely upstream rather than merely
 *      adjacent.
 *   2. That port resolves to exactly **one** neighbour. An ambiguous port tells
 *      us a device is upstream but not which one, and naming the wrong device is
 *      worse than saying nothing.
 *
 * The result is a warning that stays quiet unless it is reasonably sure, and is
 * advisory even then — the operator may know the topology better than the
 * discovered links do.
 */

import { resolveStpUpstreams, upstreamByDevice, type StpBridge } from './stpUpstream';

export interface TopologyEdge {
  from_device_id: number;
  to_device_id: number | null;
  from_interface?: string | null;
  /** RouterOS STP port role: 'root' faces the root bridge, 'designated' faces away. */
  stp_role?: string | null;
}

/**
 * Returns the selected device ids that other *selected* devices depend on.
 *
 * The upstream relation now comes from resolveStpUpstreams() rather than being
 * re-derived here. The first version of this function read port roles directly
 * and had to abandon any port that resolved to several neighbours — which, on a
 * real fleet, was every one of them, so it never warned about anything. Spanning
 * tree resolves that ambiguity properly: same domain, closer to the root.
 *
 * Only links between two selected devices matter. A switch upstream of something
 * that is not being upgraded is not a risk to this rollout.
 */
export function findUpstreamWithinSelection(
  selectedIds: number[],
  links: TopologyEdge[],
  bridges: StpBridge[] = [],
  bondMembers: Map<string, string[]> = new Map(),
): number[] {
  const selected = new Set(selectedIds);
  if (selected.size < 2) return [];

  const upstreams = upstreamByDevice(resolveStpUpstreams(bridges, links, bondMembers), bridges);

  const flagged = new Set<number>();
  for (const [deviceId, upstreamId] of upstreams) {
    // Both ends must be in this rollout for it to be this rollout's problem.
    if (selected.has(deviceId) && selected.has(upstreamId)) flagged.add(upstreamId);
  }

  // Stable order, so the same selection always reads the same way.
  return [...flagged].sort((a, b) => a - b);
}
