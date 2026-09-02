/**
 * Tree layout for the topology map, in abstract slot/row units.
 *
 * The previous layout gave every leaf its own column, so a subtree's width was
 * simply its leaf count. That is fine for a deep, branching network and useless
 * for a real one: a core switch with fifty-eight access switches under it
 * produced a single row fifty-eight slots wide — well over ten thousand pixels,
 * which is what made the map unusable at scale (#115).
 *
 * Real networks are shallow and wide, so breadth has to stop translating
 * directly into horizontal distance. Large groups of sibling leaves are laid out
 * as a block instead of a row, which trades width for height and turns a linear
 * growth curve into roughly a square-root one. Children with subtrees of their
 * own keep the classic tidy-tree treatment, because there the hierarchy is the
 * information and flattening it would lose meaning.
 *
 * Coordinates are slots and rows rather than pixels. The renderer owns the
 * conversion, and this stays testable without a DOM.
 */

export interface LayoutOptions {
  /** Sibling leaves beyond this are laid out as a block rather than a row. */
  wrapThreshold: number;
  /** Hard ceiling on block width, so one huge group cannot dominate the canvas. */
  maxBlockCols: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { wrapThreshold: 6, maxBlockCols: 12 };

export interface Placement {
  /** Horizontal position in slots. Fractional for a parent centred over its children. */
  x: number;
  /** Vertical position in rows. */
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Placement>;
  /** Total width in slots, which is what the caller offsets the next component by. */
  widthSlots: number;
  /** Deepest row used, so callers can place anything that follows below it. */
  maxRow: number;
}

/**
 * Columns for a block of `n` sibling leaves.
 *
 * Slightly wider than tall — screens are landscape and a column of forty reads
 * worse than a wide band of four rows.
 */
export function blockColumns(n: number, opts: LayoutOptions = DEFAULT_LAYOUT): number {
  if (n <= opts.wrapThreshold) return Math.max(1, n);
  return Math.max(1, Math.min(opts.maxBlockCols, Math.ceil(Math.sqrt(n * 1.6))));
}

/**
 * Lay out one connected component rooted at `rootId`.
 *
 * `children` must describe a tree — the caller derives it by breadth-first walk,
 * which is what makes cycles safe: a node is reached once and keeps the first
 * parent that finds it.
 */
export function layoutTree(
  rootId: string,
  children: Map<string, string[]>,
  depth: Map<string, number>,
  opts: LayoutOptions = DEFAULT_LAYOUT,
): LayoutResult {
  const positions = new Map<string, Placement>();
  const isLeaf = (id: string) => (children.get(id) || []).length === 0;

  /** Width in slots, and how many rows the node's own leaf block occupies. */
  const width = new Map<string, number>();
  const blockRows = new Map<string, number>();

  const measure = (id: string): number => {
    const kids = children.get(id) || [];
    if (!kids.length) { width.set(id, 1); blockRows.set(id, 0); return 1; }

    const leaves = kids.filter(isLeaf);
    const branches = kids.filter((k) => !isLeaf(k));

    const branchWidth = branches.reduce((sum, k) => sum + measure(k), 0);
    const cols = leaves.length ? blockColumns(leaves.length, opts) : 0;
    const rows = leaves.length ? Math.ceil(leaves.length / cols) : 0;
    blockRows.set(id, rows);

    const total = Math.max(1, branchWidth + cols);
    width.set(id, total);
    return total;
  };
  measure(rootId);

  let maxRow = 0;

  const place = (id: string, left: number): void => {
    const row = depth.get(id) ?? 0;
    maxRow = Math.max(maxRow, row);

    const kids = children.get(id) || [];
    if (!kids.length) {
      positions.set(id, { x: left, y: row });
      return;
    }

    const leaves = kids.filter(isLeaf);
    const branches = kids.filter((k) => !isLeaf(k));

    // Branch subtrees first, left to right, so the block sits beside them.
    let cursor = left;
    for (const b of branches) {
      place(b, cursor);
      cursor += width.get(b)!;
    }

    // Then the block of leaf children, filling left to right, top to bottom.
    const cols = leaves.length ? blockColumns(leaves.length, opts) : 0;
    leaves.forEach((leaf, i) => {
      const r = row + 1 + Math.floor(i / cols);
      positions.set(leaf, { x: cursor + (i % cols), y: r });
      maxRow = Math.max(maxRow, r);
    });

    // Centre the parent over everything beneath it.
    positions.set(id, { x: left + (width.get(id)! - 1) / 2, y: row });
  };
  place(rootId, 0);

  return { positions, widthSlots: width.get(rootId) || 1, maxRow };
}
