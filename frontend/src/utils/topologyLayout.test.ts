import { describe, it, expect } from 'vitest';
import { layoutTree, blockColumns, DEFAULT_LAYOUT } from './topologyLayout';

/** Build children/depth maps from a plain description, as the page does by BFS. */
function tree(spec: Record<string, string[]>, root: string) {
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>([[root, 0]]);
  const walk = [root];
  while (walk.length) {
    const id = walk.shift()!;
    const kids = spec[id] || [];
    children.set(id, kids);
    for (const k of kids) {
      if (!depth.has(k)) { depth.set(k, depth.get(id)! + 1); walk.push(k); }
    }
  }
  return { children, depth };
}

const flatFleet = (n: number) => {
  const kids = Array.from({ length: n }, (_, i) => `sw${i}`);
  return tree({ core: kids }, 'core');
};

describe('blockColumns', () => {
  it('leaves small groups as a single row', () => {
    expect(blockColumns(1)).toBe(1);
    expect(blockColumns(6)).toBe(6);
  });

  it('wraps larger groups, favouring width over height', () => {
    // Screens are landscape; a tall narrow column reads worse than a wide band.
    expect(blockColumns(58)).toBe(10);
    expect(blockColumns(20)).toBe(6);
  });

  it('never exceeds the ceiling', () => {
    expect(blockColumns(10_000)).toBe(DEFAULT_LAYOUT.maxBlockCols);
  });
});

describe('layoutTree — the #115 case', () => {
  it('bounds the width of a shallow, wide network', () => {
    // One core, 58 access switches. The old layout gave every leaf its own
    // column: 58 slots, over ten thousand pixels, one unreadable row.
    const { children, depth } = flatFleet(58);
    const r = layoutTree('core', children, depth);
    expect(r.widthSlots).toBe(10);
    expect(r.widthSlots).toBeLessThan(58);
    expect(r.maxRow).toBe(6); // traded width for a handful of rows
  });

  it('places every node exactly once, with no two on the same spot', () => {
    const { children, depth } = flatFleet(58);
    const r = layoutTree('core', children, depth);
    expect(r.positions.size).toBe(59);
    const seen = new Set([...r.positions.values()].map((p) => `${p.x}:${p.y}`));
    expect(seen.size).toBe(59);
  });

  it('keeps children below their parent', () => {
    const { children, depth } = flatFleet(58);
    const r = layoutTree('core', children, depth);
    const coreY = r.positions.get('core')!.y;
    for (const [id, p] of r.positions) {
      if (id !== 'core') expect(p.y).toBeGreaterThan(coreY);
    }
  });

  it('centres the parent over its children', () => {
    const { children, depth } = flatFleet(58);
    const r = layoutTree('core', children, depth);
    const xs = [...r.positions.entries()].filter(([id]) => id !== 'core').map(([, p]) => p.x);
    const core = r.positions.get('core')!.x;
    expect(core).toBeGreaterThanOrEqual(Math.min(...xs));
    expect(core).toBeLessThanOrEqual(Math.max(...xs));
  });
});

describe('layoutTree — shapes that must not regress', () => {
  it('leaves a small tree as a plain row', () => {
    const { children, depth } = tree({ core: ['a', 'b', 'c'] }, 'core');
    const r = layoutTree('core', children, depth);
    expect(r.widthSlots).toBe(3);
    expect(r.maxRow).toBe(1);
    expect(r.positions.get('a')!.y).toBe(1);
    expect(r.positions.get('c')!.x).toBe(2);
  });

  it('preserves hierarchy where there genuinely is one', () => {
    const { children, depth } = tree({
      core: ['d1', 'd2'],
      d1: ['a1', 'a2'],
      d2: ['b1', 'b2'],
    }, 'core');
    const r = layoutTree('core', children, depth);
    expect(r.positions.get('d1')!.y).toBe(1);
    expect(r.positions.get('a1')!.y).toBe(2);
    expect(r.positions.get('d1')!.x).toBeLessThan(r.positions.get('d2')!.x);
    expect(r.maxRow).toBe(2);
  });

  it('handles a mix of branches and a wide leaf block', () => {
    const leaves = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const { children, depth } = tree({ core: ['dist', ...leaves], dist: ['x', 'y'] }, 'core');
    const r = layoutTree('core', children, depth);
    expect(r.positions.get('dist')!.y).toBe(1);
    expect(r.positions.get('x')!.y).toBe(2);
    expect(r.widthSlots).toBe(2 + blockColumns(20));
    expect(r.positions.get('l0')!.x).toBeGreaterThan(r.positions.get('dist')!.x);
  });

  it('handles a single isolated node', () => {
    const { children, depth } = tree({ only: [] }, 'only');
    const r = layoutTree('only', children, depth);
    expect(r.widthSlots).toBe(1);
    expect(r.maxRow).toBe(0);
    expect(r.positions.get('only')).toEqual({ x: 0, y: 0 });
  });

  it('handles a deep chain without widening', () => {
    const { children, depth } = tree({ a: ['b'], b: ['c'], c: ['d'], d: [] }, 'a');
    const r = layoutTree('a', children, depth);
    expect(r.widthSlots).toBe(1);
    expect(r.maxRow).toBe(3);
  });
});
