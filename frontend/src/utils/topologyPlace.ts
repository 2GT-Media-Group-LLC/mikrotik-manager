import type { GraphNode } from './topologyGraph';

interface XY { x: number; y: number }

/**
 * Where each card goes on screen. One already on screen stays put. A new one
 * (hosts shown by opening their chip, #367) goes where the layout puts it
 * relative to what it hangs from, measured from where that is on screen now,
 * not where the layout would put it. Opening a chip widens its part of the
 * tree, so the layout moves the chip; the chip stays where it is, and its
 * hosts went under the moved one, across the map. One placed by hand keeps
 * its saved place.
 */
export function placeNew(nodes: GraphNode[], here: Map<string, XY>): (id: string) => XY {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Map<string, XY>();
  const place = (id: string, depth: number): XY => {
    const hit = done.get(id) ?? here.get(id);
    if (hit) return hit;
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const p = n.parent ? byId.get(n.parent) : undefined;
    let out: XY = { x: n.x, y: n.y };
    // One placed by hand keeps its saved place.
    if (p && !n.pinned && depth < 64) {
      const at = place(p.id, depth + 1);
      out = { x: at.x + (n.x - p.x), y: at.y + (n.y - p.y) };
    }
    done.set(id, out);
    return out;
  };
  return (id) => place(id, 0);
}
