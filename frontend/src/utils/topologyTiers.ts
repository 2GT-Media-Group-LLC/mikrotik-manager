/**
 * The tiered layout's hierarchy (#367): each device hangs under its way up,
 * the uplink the client page's connection path also follows (#363, #365), so
 * the gateway router is on top, then core, access and APs. Before, the
 * spanning-tree root was on top, which put a switch above the router.
 */

/** Each device's way up, as /api/topology returns it. */
export interface WayUp {
  deviceId: number;
  /** The managed device it goes up to, when it is one. */
  upstreamDeviceId: number | null;
  /** The link it goes up over, for finding a neighbour the manager doesn't manage. */
  viaLinkId: number | null;
}

/** Router, then switch, then anything else: the order tops are chosen in, as on the server. */
export function deviceTier(type: string | undefined): number {
  return type === 'router' ? 0 : type === 'switch' ? 1 : 2;
}

/**
 * The map node each device goes up to, by map node id. A way up to something
 * not on the map is dropped. Where ways up form a loop (two switches with no
 * root port, each choosing the other), the one that `before` puts first is
 * taken out of it and has none.
 */
export function wayUpParents(
  waysUp: WayUp[],
  /** Map node id of a link's far end. */
  farEnd: Map<number, string>,
  onMap: (id: string) => boolean,
  /** Negative when `a` should be above `b`. */
  before: (a: string, b: string) => number,
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const w of waysUp) {
    const id = String(w.deviceId);
    const up = w.upstreamDeviceId != null ? String(w.upstreamDeviceId)
      : w.viaLinkId != null ? farEnd.get(w.viaLinkId) : undefined;
    if (up && up !== id && onMap(id) && onMap(up)) parent.set(id, up);
  }
  // Break loops: walk up from each node; meeting the walk's own path again is a loop.
  const done = new Set<string>();
  for (const start of [...parent.keys()]) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && !done.has(cur) && !onPath.has(cur)) {
      path.push(cur); onPath.add(cur);
      cur = parent.get(cur);
    }
    if (cur !== undefined && onPath.has(cur)) {
      const loop = path.slice(path.indexOf(cur));
      const top = [...loop].sort(before)[0];
      parent.delete(top);
    }
    for (const p of path) done.add(p);
  }
  return parent;
}

/**
 * The devices to draw on the top row of one part of the map: those with no way
 * up, of the highest tier among them. Where some of those have devices under
 * them, a lone one with nothing under it (and not a router) isn't a top: it's
 * a device whose uplink discovery didn't find, and goes where it's linked.
 * Empty when no device in the part has a way up to go by.
 */
export function pickTops(
  managed: string[],
  parent: Map<string, string>,
  tierOf: (id: string) => number,
  before: (a: string, b: string) => number,
): string[] {
  if (!managed.some((id) => parent.has(id))) return [];
  const free = managed.filter((id) => !parent.has(id));
  if (!free.length) return [];
  const minTier = Math.min(...free.map(tierOf));
  const level = free.filter((id) => tierOf(id) === minTier);
  const hasChildren = new Set(parent.values());
  const leading = level.filter((id) => hasChildren.has(id) || tierOf(id) === 0);
  return (leading.length ? leading : level).sort(before);
}
