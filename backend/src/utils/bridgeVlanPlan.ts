/**
 * Deciding how to write a port's membership into the bridge VLAN table.
 *
 * Reported as `failure: can not change dynamic` when assigning VLANs on a port
 * whose PVID is 1 (#151).
 *
 * RouterOS keeps two kinds of row in `/interface/bridge/vlan`. Static rows are
 * configuration. Dynamic rows are created by the bridge itself — most commonly
 * for whatever VLAN a port's PVID names when no static row for it exists — and
 * they **cannot be modified**: `/interface/bridge/vlan/set` on one fails with
 * exactly that message. The previous code found a row and set it, with no
 * regard for which kind it was.
 *
 * The remedy RouterOS expects is to *add* a static row for that VLAN. A static
 * row supersedes the dynamic one, which then disappears.
 *
 * A second and quieter bug sat next to it: where no row existed at all the code
 * did nothing and reported success. Assigning a port to a VLAN the bridge had
 * never heard of silently achieved nothing.
 */

import { expandVlanIds } from './vlan';

export type PortRole = 'tagged' | 'untagged';

export interface BridgeVlanRow {
  '.id'?: string;
  dynamic?: string;
  tagged?: string;
  untagged?: string;
}

export type VlanWrite =
  | { action: 'set'; id: string; tagged: string; untagged: string }
  | { action: 'add'; tagged: string; untagged: string }
  | { action: 'noop' };

const list = (v: string | undefined): string[] =>
  (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * What to do with one VLAN for one port.
 *
 * `existing` is the row already in the table for this VLAN, if any. A dynamic
 * row is read for its membership — it describes what the bridge is currently
 * doing — but written as a new static row rather than modified.
 */
export function planVlanWrite(
  existing: BridgeVlanRow | undefined,
  port: string,
  role: PortRole
): VlanWrite {
  const current = existing ?? {};
  const tagged = list(current.tagged);
  const untagged = list(current.untagged);

  const nextTagged = role === 'tagged'
    ? [...new Set([...tagged, port])]
    : tagged.filter((p) => p !== port);
  const nextUntagged = role === 'untagged'
    ? [...new Set([...untagged, port])]
    : untagged.filter((p) => p !== port);

  const t = nextTagged.join(',');
  const u = nextUntagged.join(',');

  // No row at all: the VLAN has to be created, or the assignment is a no-op
  // that reports success.
  if (!existing || !existing['.id']) return { action: 'add', tagged: t, untagged: u };

  // Dynamic rows are the bridge's own bookkeeping and reject modification. A
  // static row for the same VLAN replaces it.
  if (existing.dynamic === 'true') return { action: 'add', tagged: t, untagged: u };

  // Nothing to do — avoids a write, and avoids Change Guard arming for a change
  // that would not alter anything.
  if (t === list(current.tagged).join(',') && u === list(current.untagged).join(',')) {
    return { action: 'noop' };
  }

  return { action: 'set', id: existing['.id'], tagged: t, untagged: u };
}

export interface FrameTypeConfig {
  'frame-types': string;
  'ingress-filtering': string;
}

/**
 * Frame admission for a port's role.
 *
 * The previous code set only the PVID, so switching a port between access and
 * trunk changed which VLAN untagged traffic joined and nothing about which
 * frames the port would accept. A trunk kept admitting untagged frames and an
 * access port kept admitting tagged ones — the port type was half decorative.
 *
 * Returned as a value rather than applied here so the caller can decide, and so
 * this is testable without a device.
 */
export function frameTypesFor(role: 'access' | 'trunk'): FrameTypeConfig {
  return role === 'access'
    ? {
        'frame-types': 'admit-only-untagged-and-priority-tagged',
        'ingress-filtering': 'yes',
      }
    : {
        'frame-types': 'admit-only-vlan-tagged',
        'ingress-filtering': 'yes',
      };
}

export interface BridgeVlanTableRow extends BridgeVlanRow {
  bridge?: string;
  'vlan-ids'?: string;
}

export interface TaggedRemovalPlan {
  /** Static rows to rewrite with the port taken out of `tagged`. */
  writes: { id: string; tagged: string; untagged: string; vlanIds: number[] }[];
  /**
   * VLANs the port should leave but cannot without splitting a row: the row
   * also covers a VLAN the port is keeping (e.g. `vlan-ids=10-20` with only 15
   * unticked). Left alone and reported rather than silently half-done.
   */
  mixed: number[];
}

/**
 * Which rows to rewrite so a trunk port is tagged *only* on `keep` (#165).
 *
 * Saving used to be add-only: VLANs were added to the port but never taken
 * away, so unticking one in the editor changed nothing on the device. This is
 * the removal half. Only static rows are touched (dynamic ones reject writes),
 * and only the `tagged` list — untagged/PVID membership is left alone.
 */
export function planTaggedRemovals(
  rows: BridgeVlanTableRow[],
  bridge: string,
  port: string,
  keep: number[]
): TaggedRemovalPlan {
  const keepSet = new Set(keep);
  const plan: TaggedRemovalPlan = { writes: [], mixed: [] };
  for (const row of rows) {
    if (row.bridge !== undefined && row.bridge !== bridge) continue;
    if (row.dynamic === 'true' || row.dynamic === 'yes' || !row['.id']) continue;
    const tagged = list(row.tagged);
    if (!tagged.includes(port)) continue;
    const vids = expandVlanIds(row['vlan-ids']);
    const leaving = vids.filter((v) => !keepSet.has(v));
    if (leaving.length === 0) continue;
    if (leaving.length < vids.length) {
      plan.mixed.push(...leaving);
      continue;
    }
    plan.writes.push({
      id: row['.id'],
      tagged: tagged.filter((p) => p !== port).join(','),
      untagged: list(row.untagged).join(','),
      vlanIds: vids,
    });
  }
  plan.mixed.sort((a, b) => a - b);
  return plan;
}
