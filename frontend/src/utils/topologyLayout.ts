/**
 * Layout for the topology map, in abstract slot/row units (#115, #147).
 *
 * Real networks are shallow and wide. The first fix folded large groups of
 * sibling *leaves* into blocks, but any switch with one device under it counted
 * as a branch, and branches still took a full column each: a core with 58
 * access switches was 58 slots wide once each had a device plugged in, 116 with
 * two. Width followed breadth again.
 *
 * Here every subtree is a box, and a parent's children (leaves and subtrees
 * alike) are packed into shelves of bounded width, wrapping onto the next shelf
 * like text. Small families still sit in one row, so a modest network looks like
 * a classic tree; only a wide one wraps, roughly into a square. Separate
 * components and unconnected devices are packed the same way.
 *
 * Coordinates are slots (one node column) and rows (one node row). The renderer
 * owns the conversion to pixels, and this stays testable without a DOM.
 */

export interface LayoutOptions {
  /**
   * The widest a row of siblings may be before it wraps, in slots. For very
   * large sets the limit grows, so the block stays landscape.
   */
  maxRow: number;
  /** The same for a set of leaves only, which reads better as a compact grid. */
  leafRow: number;
  /** Vertical space between wrapped shelves, in rows, so edges can pass. */
  shelfGap: number;
  /** Target width/height of a wrapped block on screen: a landscape window. */
  aspect: number;
  /** How much wider a slot is than a row is tall on screen. */
  slotToRow: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { maxRow: 24, leafRow: 6, shelfGap: 0.45, aspect: 2, slotToRow: 1.6 };

export interface Placement {
  /** Horizontal position in slots; fractional when centred. */
  x: number;
  /** Vertical position in rows; fractional after a wrapped shelf. */
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Placement>;
  /** Total width in slots. */
  widthSlots: number;
  /** Total height in rows. */
  heightRows: number;
}

interface Box { w: number; h: number; branch?: boolean }

/**
 * Deal boxes onto `shelves` rows so the rows come out as even as possible: each
 * box, widest first, goes on the row that is shortest so far. Within a row the
 * boxes keep their original order, and each row is centred in the block.
 */
export function packInto(items: Box[], shelves: number, hGap: number, vGap: number): {
  offsets: Placement[]; w: number; h: number;
} {
  const k = Math.max(1, Math.min(shelves, items.length));
  const rows: { idx: number[]; w: number; h: number }[] = Array.from({ length: k }, () => ({ idx: [], w: 0, h: 0 }));
  const byWidth = items.map((b, i) => i).sort((a, b) => items[b].w - items[a].w || a - b);
  for (const i of byWidth) {
    let target = rows[0];
    for (const r of rows) if (r.w < target.w - 1e-9) target = r;
    target.w += (target.idx.length ? hGap : 0) + items[i].w;
    target.h = Math.max(target.h, items[i].h);
    target.idx.push(i);
  }
  const used = rows.filter((r) => r.idx.length);
  for (const r of used) r.idx.sort((a, b) => a - b);
  const w = Math.max(0, ...used.map((r) => r.w));
  const offsets: Placement[] = new Array(items.length);
  let y = 0;
  used.forEach((r, ri) => {
    let x = (w - r.w) / 2;
    for (const i of r.idx) { offsets[i] = { x, y }; x += items[i].w + hGap; }
    y += r.h + (ri < used.length - 1 ? vGap : 0);
  });
  return { offsets, w, h: y };
}

/**
 * Pack a set of boxes: in one row when it fits within the row limit, otherwise
 * on the fewest even rows that do. Keeping siblings in one row as long as
 * possible reads best: a tree, not a grid. The limit grows with very large sets
 * (hundreds of clients) so the block stays roughly the screen's shape.
 */
export function pack(items: Box[], opts: LayoutOptions = DEFAULT_LAYOUT, hGap = 0, vGap = opts.shelfGap): {
  offsets: Placement[]; w: number; h: number; shelves: number;
} {
  const total = items.reduce((s, b) => s + b.w, 0) + hGap * Math.max(0, items.length - 1);
  const area = items.reduce((s, b) => s + (b.w + hGap) * b.h, 0);
  const widest = Math.max(0, ...items.map((b) => b.w));
  // Leaves carry no hierarchy, so a set of only leaves (clients, APs) wraps
  // early into a grid; a family with branches stays one row as long as it can.
  const leavesOnly = items.every((b) => b.h <= 1 && !b.branch);
  const limit = Math.max(leavesOnly ? opts.leafRow : opts.maxRow, widest,
    Math.ceil(Math.sqrt((area * opts.aspect) / opts.slotToRow)));
  if (items.length <= 1 || total <= limit) return { ...packInto(items, 1, hGap, vGap), shelves: 1 };
  for (let k = 2; k <= items.length; k++) {
    const p = packInto(items, k, hGap, vGap);
    if (p.w <= limit + 1e-9) return { ...p, shelves: k };
  }
  return { ...packInto(items, items.length, hGap, vGap), shelves: items.length };
}

/**
 * Lay out one tree rooted at `rootId`. `children` must describe a tree; the
 * caller derives it by a breadth-first walk, so a node reached twice keeps the
 * first parent that found it and cycles are safe.
 */
export function layoutTree(
  rootId: string,
  children: Map<string, string[]>,
  opts: LayoutOptions = DEFAULT_LAYOUT,
  /** A node's own size in slots and rows, when it isn't a standard card (a client is smaller). */
  sizeOf: (id: string) => { w: number; h: number } = () => ({ w: 1, h: 1 }),
): LayoutResult {
  const box = new Map<string, Box>();
  /** Children in packing order, with their offsets inside the parent's block. */
  const plan = new Map<string, { order: string[]; offsets: Placement[]; blockW: number }>();

  const measure = (id: string, seen: Set<string>): Box => {
    seen.add(id);
    const kids = (children.get(id) || []).filter((k) => !seen.has(k));
    if (!kids.length) { const b = { ...sizeOf(id) }; box.set(id, b); return b; }
    kids.forEach((k) => measure(k, seen));
    // Tallest first, then widest: shelves fill better, and single devices end
    // up together at the end rather than scattered between subtrees.
    const order = [...kids].sort((a, b) => box.get(b)!.h - box.get(a)!.h || box.get(b)!.w - box.get(a)!.w);
    const items = order.map((k) => box.get(k)!);
    const packed = pack(items, opts);
    plan.set(id, { order, offsets: packed.offsets, blockW: packed.w });
    const own = sizeOf(id);
    const b = { w: Math.max(own.w, packed.w), h: own.h + packed.h, branch: true };
    box.set(id, b);
    return b;
  };
  const root = measure(rootId, new Set());

  const positions = new Map<string, Placement>();
  const place = (id: string, left: number, top: number): void => {
    const b = box.get(id)!;
    const own = sizeOf(id);
    positions.set(id, { x: left + (b.w - own.w) / 2, y: top });
    const p = plan.get(id);
    if (!p) return;
    const inset = (b.w - p.blockW) / 2;
    p.order.forEach((k, i) => place(k, left + inset + p.offsets[i].x, top + own.h + p.offsets[i].y));
  };
  place(rootId, 0, 0);

  return { positions, widthSlots: root.w, heightRows: root.h };
}

/**
 * Lay out several trees and a set of unconnected nodes together, packed into
 * shelves so a fleet of many separate segments doesn't become one long row.
 * The unconnected nodes go last, as one block.
 */
export function layoutForest(
  trees: { rootId: string; children: Map<string, string[]> }[],
  loose: string[],
  opts: LayoutOptions = DEFAULT_LAYOUT,
  /** Space between components, in slots and rows. */
  gap = { h: 0.6, v: 0.8 },
  sizeOf: (id: string) => { w: number; h: number } = () => ({ w: 1, h: 1 }),
): LayoutResult {
  const parts: { result: LayoutResult; box: Box }[] = trees.map((t) => {
    const r = layoutTree(t.rootId, t.children, opts, sizeOf);
    return { result: r, box: { w: r.widthSlots, h: r.heightRows } };
  });
  if (loose.length) {
    const items = loose.map(() => ({ w: 1, h: 1 }));
    const packed = pack(items, opts);
    const positions = new Map<string, Placement>(loose.map((id, i) => [id, packed.offsets[i]]));
    parts.push({ result: { positions, widthSlots: packed.w, heightRows: packed.h }, box: { w: packed.w, h: packed.h } });
  }
  const boxes = parts.map((p) => p.box);
  const packed = pack(boxes, opts, gap.h, gap.v);
  const positions = new Map<string, Placement>();
  parts.forEach((p, i) => {
    const o = packed.offsets[i];
    for (const [id, pos] of p.result.positions) positions.set(id, { x: o.x + pos.x, y: o.y + pos.y });
  });
  return { positions, widthSlots: packed.w, heightRows: packed.h };
}
