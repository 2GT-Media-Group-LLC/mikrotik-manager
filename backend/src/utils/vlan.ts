/**
 * RouterOS VLAN-ID parsing.
 *
 * A single `/interface/bridge/vlan` row can carry a list and/or ranges in its
 * `vlan-ids` field — "10", "10,20", "10-12", "1,10-12,20". Anything that reduces
 * that to one integer (a bare `parseInt`) silently loses VLANs, so both the safety
 * analysis and the collector share this expansion.
 */

/** Split a RouterOS comma-separated field into trimmed, non-empty parts. */
export function rosList(val: string | undefined): string[] {
  if (!val) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Every VLAN ID a `vlan-ids` spec covers, in the order RouterOS lists them. */
export function expandVlanIds(spec: string | undefined): number[] {
  const out: number[] = [];
  for (const part of rosList(spec)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (!isNaN(from) && !isNaN(to) && to >= from) {
        for (let v = from; v <= to; v++) out.push(v);
      }
      continue;
    }
    const n = parseInt(part, 10);
    if (!isNaN(n)) out.push(n);
  }
  return out;
}

/** True when the spec names more than one VLAN (a range or a list). */
export function isMultiVlanSpec(spec: string | undefined): boolean {
  return expandVlanIds(spec).length > 1;
}

export interface AggregatedVlan {
  bridge: string;
  vlanId: number;
  /** Raw RouterOS specs this VLAN was found in, e.g. "10" or "10-20". */
  spec: string;
  tagged: string[];
  untagged: string[];
  /** Operator's comment, taken from a static row only. */
  name: string | null;
  /** The source rows, kept for the cached config_json. */
  rows: Record<string, string>[];
}

/**
 * Collapse the bridge VLAN table into one entry per (bridge, VLAN ID).
 *
 * Two things make this non-obvious:
 *
 *  - A row's `vlan-ids` may be a range or list, so one row expands into several.
 *  - RouterOS can hold several rows for the same (bridge, VID) — typically the
 *    operator's row plus a dynamic one that a port PVID created.
 *
 * Membership comes from the STATIC `tagged`/`untagged` fields and dynamic rows
 * contribute none. This is deliberate and load-bearing: the result backs the VLAN
 * editor, and `updateBridgeVlan` is remove-then-add, so whatever is shown is written
 * back. Using the effective `current-*` view here would bake RouterOS's dynamic
 * entries into the saved configuration on every save. A dynamic row still registers
 * the VLAN's existence so it appears in the list.
 */
export function aggregateBridgeVlans(rows: Record<string, string>[]): AggregatedVlan[] {
  const out = new Map<string, AggregatedVlan & { specs: Set<string>; t: Set<string>; u: Set<string> }>();

  for (const row of rows) {
    const bridge = row['bridge'] || '';
    const spec = row['vlan-ids'] || '';
    const dynamic = row['dynamic'] === 'true';

    for (const vlanId of expandVlanIds(spec)) {
      const key = `${bridge}:${vlanId}`;
      const entry = out.get(key) ?? {
        bridge, vlanId, spec: '', tagged: [], untagged: [], name: null, rows: [],
        specs: new Set<string>(), t: new Set<string>(), u: new Set<string>(),
      };
      entry.rows.push(row);
      if (!dynamic) {
        if (spec) entry.specs.add(spec);
        for (const p of rosList(row['tagged'])) entry.t.add(p);
        for (const p of rosList(row['untagged'])) entry.u.add(p);
        if (!entry.name && row['comment']) entry.name = row['comment'];
      }
      out.set(key, entry);
    }
  }

  return [...out.values()].map((e) => ({
    bridge: e.bridge,
    vlanId: e.vlanId,
    spec: [...e.specs].join(','),
    tagged: [...e.t],
    untagged: [...e.u],
    name: e.name,
    rows: e.rows,
  }));
}

/**
 * Per-port VLAN membership derived from the same table. Static-only for the same
 * round-trip reason as above: these lists prefill the port editor, and
 * `setPortVlanConfig` rewrites whatever it is handed.
 */
export function portVlanMembership(rows: Record<string, string>[]): Map<string, { tagged: number[]; untagged: number[] }> {
  const out = new Map<string, { tagged: Set<number>; untagged: Set<number> }>();
  const slot = (port: string) => {
    const existing = out.get(port) ?? { tagged: new Set<number>(), untagged: new Set<number>() };
    out.set(port, existing);
    return existing;
  };

  for (const row of rows) {
    if (row['dynamic'] === 'true') continue;
    const vids = expandVlanIds(row['vlan-ids']);
    for (const p of rosList(row['tagged'])) for (const v of vids) slot(p).tagged.add(v);
    for (const p of rosList(row['untagged'])) for (const v of vids) slot(p).untagged.add(v);
  }

  const asc = (a: number, b: number) => a - b;
  return new Map(
    [...out.entries()].map(([port, m]) => [port, {
      tagged: [...m.tagged].sort(asc),
      untagged: [...m.untagged].sort(asc),
    }])
  );
}
