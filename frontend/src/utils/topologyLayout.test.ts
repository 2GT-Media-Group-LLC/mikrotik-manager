import { describe, it, expect } from 'vitest';
import { layoutTree, layoutForest, pack, packInto, DEFAULT_LAYOUT, type LayoutResult } from './topologyLayout';

/** Children map from a plain description, as the page builds it by BFS. */
function tree(spec: Record<string, string[]>) {
  return new Map(Object.entries(spec));
}

/** core → n switches, each with `perSwitch` devices: the shapes measured in #115. */
function coreWith(n: number, perSwitch: number) {
  const spec: Record<string, string[]> = { core: [] };
  for (let i = 0; i < n; i++) {
    spec.core.push(`sw${i}`);
    spec[`sw${i}`] = Array.from({ length: perSwitch }, (_, j) => `sw${i}-d${j}`);
  }
  return tree(spec);
}

/** No two nodes share a cell: positions are at least one slot or one row apart. */
function overlaps(r: LayoutResult): string[] {
  const out: string[] = [];
  const all = [...r.positions.entries()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, pa] = all[i];
      const [b, pb] = all[j];
      if (Math.abs(pa.x - pb.x) < 0.999 && Math.abs(pa.y - pb.y) < 0.999) out.push(`${a}/${b}`);
    }
  }
  return out;
}

describe('the #115 measurements', () => {
  // Before: 10, 58 and 116 slots wide. Width must stop following breadth.
  it.each([[0, 24], [1, 24], [2, 24]])('58 switches with %i devices each stay narrow', (per, maxWidth) => {
    const r = layoutTree('core', coreWith(58, per));
    expect(r.widthSlots).toBeLessThanOrEqual(maxWidth);
    expect(overlaps(r)).toEqual([]);
  });

  it('comes out landscape, like the window it is shown in', () => {
    const r = layoutTree('core', coreWith(58, 2));
    const screen = (r.widthSlots * DEFAULT_LAYOUT.slotToRow) / r.heightRows;
    expect(screen).toBeGreaterThan(1.1);
    expect(screen).toBeLessThan(6);
  });

  it("handles Orhideous's shape: router, 6 switches, 2 each, several APs each", () => {
    const spec: Record<string, string[]> = { router: [] };
    for (let a = 0; a < 6; a++) {
      spec.router.push(`l2-${a}`);
      spec[`l2-${a}`] = [];
      for (let b = 0; b < 2; b++) {
        spec[`l2-${a}`].push(`l3-${a}-${b}`);
        spec[`l3-${a}-${b}`] = Array.from({ length: 5 }, (_, c) => `ap-${a}-${b}-${c}`);
      }
    }
    const r = layoutTree('router', tree(spec));
    // 60 access points: one row would be 60 slots wide.
    expect(r.widthSlots).toBeLessThanOrEqual(24);
    expect(overlaps(r)).toEqual([]);
  });
});

describe('layoutTree', () => {
  it('keeps a small network a classic tree in one row per level', () => {
    const r = layoutTree('r', tree({ r: ['a', 'b', 'c'], a: ['a1', 'a2'] }));
    expect(r.positions.get('a')!.y).toBe(1);
    expect(r.positions.get('b')!.y).toBe(1);
    expect(r.positions.get('a1')!.y).toBe(2);
    expect(r.widthSlots).toBe(4);
  });

  it('puts every child below its parent and centres the parent over its block', () => {
    const children = coreWith(30, 2);
    const r = layoutTree('core', children);
    for (const [parent, kids] of children) {
      const p = r.positions.get(parent)!;
      for (const k of kids) expect(r.positions.get(k)!.y).toBeGreaterThan(p.y);
    }
    expect(r.positions.get('core')!.x).toBeCloseTo((r.widthSlots - 1) / 2);
  });

  it('survives a cycle in the children map', () => {
    const r = layoutTree('a', tree({ a: ['b'], b: ['a', 'c'] }));
    expect([...r.positions.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('never overlaps on a lopsided tree', () => {
    const spec: Record<string, string[]> = { r: ['big', 'x', 'y', 'z'], big: [] };
    for (let i = 0; i < 40; i++) spec.big.push(`b${i}`);
    for (const k of ['x', 'y', 'z']) spec[k] = [`${k}1`];
    expect(overlaps(layoutTree('r', tree(spec)))).toEqual([]);
  });
});

describe('packing', () => {
  it('stays in one row below the wrap width', () => {
    const items = Array.from({ length: 5 }, () => ({ w: 1, h: 1 }));
    const p = pack(items);
    expect(p.shelves).toBe(1);
    expect(p.w).toBe(5);
  });

  it('wraps a wide set into a landscape block', () => {
    const p = pack(Array.from({ length: 100 }, () => ({ w: 1, h: 1 })));
    const screen = (p.w * DEFAULT_LAYOUT.slotToRow) / p.h;
    expect(screen).toBeGreaterThan(1.4);
    expect(screen).toBeLessThan(6);
  });

  it('deals uneven boxes onto even rows', () => {
    // Six core switches, three 12 wide and three 10 wide, on three rows: 12+10 each.
    const p = packInto([12, 12, 12, 10, 10, 10].map((w) => ({ w, h: 3 })), 3, 0, 0);
    expect(p.w).toBe(22);
    expect(p.h).toBe(9);
  });

  it('keeps a family together when there is room', () => {
    // A core switch with two access switches of five APs each: side by side.
    const r = layoutTree('core', tree({ core: ['a', 'b'], a: ['a1', 'a2', 'a3', 'a4', 'a5'], b: ['b1', 'b2', 'b3', 'b4', 'b5'] }));
    expect(r.positions.get('a')!.y).toBe(r.positions.get('b')!.y);
  });
});

describe('wrapping keeps families together', () => {
  it('puts six core sections on even rows of two, not a column', () => {
    const spec: Record<string, string[]> = { router: [] };
    for (let a = 0; a < 6; a++) {
      spec.router.push(`c${a}`);
      spec[`c${a}`] = [`c${a}x`, `c${a}y`];
      spec[`c${a}x`] = Array.from({ length: a % 2 ? 5 : 6 }, (_, i) => `c${a}x${i}`);
      spec[`c${a}y`] = Array.from({ length: 5 }, (_, i) => `c${a}y${i}`);
    }
    const r = layoutTree('router', tree(spec));
    const rows = new Set([0, 1, 2, 3, 4, 5].map((a) => r.positions.get(`c${a}`)!.y));
    expect(rows.size).toBe(3);
    expect(overlaps(r)).toEqual([]);
  });

  it('grows the row limit for hundreds of clients so the block stays landscape', () => {
    const p = pack(Array.from({ length: 600 }, () => ({ w: 1, h: 1 })));
    expect((p.w * DEFAULT_LAYOUT.slotToRow) / p.h).toBeGreaterThan(1.2);
  });
});

describe('layoutForest', () => {
  it('packs separate segments and unconnected devices instead of one long row', () => {
    const trees = Array.from({ length: 12 }, (_, i) => ({ rootId: `r${i}`, children: tree({ [`r${i}`]: [`r${i}a`, `r${i}b`] }) }));
    const loose = Array.from({ length: 20 }, (_, i) => `o${i}`);
    const r = layoutForest(trees, loose);
    expect(r.widthSlots).toBeLessThan(30);
    expect(overlaps(r)).toEqual([]);
    expect(r.positions.size).toBe(12 * 3 + 20);
  });
});
