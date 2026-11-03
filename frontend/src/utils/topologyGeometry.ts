/**
 * Where a link meets the cards it joins (#147). By default a link runs between
 * the cards' centres and stops at their edges, so it follows the cards wherever
 * they're dragged. A side chosen by hand (top, bottom, left, right) pins that
 * end to the middle of that side.
 */
export type Side = 't' | 'b' | 'l' | 'r';
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const SIDES: { side: Side | null; label: string }[] = [
  { side: null, label: 'Automatic' }, { side: 't', label: 'Top' }, { side: 'b', label: 'Bottom' },
  { side: 'l', label: 'Left' }, { side: 'r', label: 'Right' },
];

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function sidePoint(r: Rect, side: Side): Pt {
  const c = center(r);
  if (side === 't') return { x: c.x, y: r.y };
  if (side === 'b') return { x: c.x, y: r.y + r.h };
  if (side === 'l') return { x: r.x, y: c.y };
  return { x: r.x + r.w, y: c.y };
}

/** Where the line from the card's centre towards `to` leaves the card. */
export function borderToward(r: Rect, to: Pt): Pt {
  const c = center(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : (r.w / 2) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (r.h / 2) / Math.abs(dy);
  const k = Math.min(sx, sy);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

/**
 * Both ends of a link. A second or third cable between the same two cards is
 * shifted sideways so the lines don't sit on top of each other.
 */
export function linkEnds(src: Rect, dst: Rect, srcSide?: Side | null, dstSide?: Side | null, parallel = 0): { s: Pt; t: Pt } {
  const pinnedT = dstSide ? sidePoint(dst, dstSide) : null;
  const s = srcSide ? sidePoint(src, srcSide) : borderToward(src, pinnedT ?? center(dst));
  const t = pinnedT ?? borderToward(dst, s);
  if (!parallel) return { s, t };
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = parallel * 14;
  const ox = (-dy / len) * off;
  const oy = (dx / len) * off;
  return { s: { x: s.x + ox, y: s.y + oy }, t: { x: t.x + ox, y: t.y + oy } };
}

/** Which side of the card a point on its edge lies on, for routing the line out of it. */
export function sideOf(r: Rect, p: Pt): Side {
  const d = { t: Math.abs(p.y - r.y), b: Math.abs(p.y - (r.y + r.h)), l: Math.abs(p.x - r.x), r: Math.abs(p.x - (r.x + r.w)) };
  return (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]) as Side;
}

/** Vertical space two cards need between them for a link to run top to bottom. */
const CURVE_GAP = 16;

/** How far the second, third... cable between the same cards is moved along the side: +16, -16, +32... */
export function parallelOffset(parallel: number): number {
  if (!parallel) return 0;
  return (parallel % 2 ? 1 : -1) * Math.ceil(parallel / 2) * 16;
}

/**
 * Both ends of a curved link (#367), and the sides they sit on. Between cards
 * on different rows it leaves the bottom of the upper card and enters the top
 * of the lower one, so the map reads top-down; between cards side by side it
 * runs from one's facing side to the other's. Parallel cables fan out along
 * the side, kept on the card.
 */
export function curveEnds(src: Rect, dst: Rect, parallel = 0): { s: Pt; t: Pt; sSide: Side; tSide: Side } {
  const srcAbove = src.y + src.h + CURVE_GAP <= dst.y;
  const dstAbove = dst.y + dst.h + CURVE_GAP <= src.y;
  const off = parallelOffset(parallel);
  const along = (p: Pt, r: Rect, vertical: boolean): Pt => {
    if (vertical) {
      const room = Math.max(0, r.w / 2 - 8);
      return { x: p.x + Math.max(-room, Math.min(room, off)), y: p.y };
    }
    const room = Math.max(0, r.h / 2 - 6);
    return { x: p.x, y: p.y + Math.max(-room, Math.min(room, off)) };
  };
  if (srcAbove || dstAbove) {
    const sSide: Side = srcAbove ? 'b' : 't';
    const tSide: Side = srcAbove ? 't' : 'b';
    return { s: along(sidePoint(src, sSide), src, true), t: along(sidePoint(dst, tSide), dst, true), sSide, tSide };
  }
  const srcLeft = center(src).x <= center(dst).x;
  const sSide: Side = srcLeft ? 'r' : 'l';
  const tSide: Side = srcLeft ? 'l' : 'r';
  return { s: along(sidePoint(src, sSide), src, false), t: along(sidePoint(dst, tSide), dst, false), sSide, tSide };
}
