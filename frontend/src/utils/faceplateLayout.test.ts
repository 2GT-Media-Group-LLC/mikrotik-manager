import { describe, it, expect } from 'vitest';
import {
  chunkRows, staggerBlocks, columnsForWidth, resolveColumns,
  TILE_PX, TILE_GAP_PX,
} from './faceplateLayout';

describe('columnsForWidth', () => {
  it('uses the real tile size, not the dead constants', () => {
    // A tile is 46px with a 4px gap. The removed geometry block implied 36px,
    // and reasoning from it produced the wrong answer about wrapping.
    expect(TILE_PX + TILE_GAP_PX).toBe(50);
    // 1200px of card, less 52px padding, is 22 tiles of 50px.
    expect(columnsForWidth(1200)).toBe(22);
  });

  it('never returns zero, however narrow the container', () => {
    expect(columnsForWidth(0)).toBe(4);
    expect(columnsForWidth(10)).toBe(4);
    expect(columnsForWidth(NaN)).toBe(4);
  });

  it('caps very wide screens so a faceplate stays readable', () => {
    expect(columnsForWidth(9000)).toBe(32);
  });
});

describe('chunkRows', () => {
  it('wraps a group that previously could not wrap at all', () => {
    // BOND and BRIDGE had no flexWrap; twelve bonds meant twelve columns.
    expect(chunkRows([1,2,3,4,5,6,7,8,9,10,11,12], 8)).toEqual([
      [1,2,3,4,5,6,7,8], [9,10,11,12],
    ]);
  });

  it('leaves a short group on one row', () => {
    expect(chunkRows([1,2,3], 8)).toEqual([[1,2,3]]);
  });

  it('handles an empty group', () => {
    expect(chunkRows([], 8)).toEqual([]);
  });

  it('survives a nonsense column count rather than looping forever', () => {
    expect(chunkRows([1,2], 0)).toEqual([[1],[2]]);
  });
});

describe('staggerBlocks', () => {
  const ports = Array.from({ length: 24 }, (_, i) => i + 1);

  it('keeps a small switch on a single row', () => {
    expect(staggerBlocks([1,2,3,4], 8)).toEqual([{ top: [1,2,3,4], bottom: [] }]);
  });

  it('staggers odd above even, as the hardware is laid out', () => {
    const [bank] = staggerBlocks([1,2,3,4,5,6,7,8,9,10], 8);
    expect(bank.top).toEqual([1,3,5,7,9]);
    expect(bank.bottom).toEqual([2,4,6,8,10]);
  });

  it('repeats the stagger in banks instead of running on forever', () => {
    // The old layout was hard-capped at two rows, so 24 ports meant 12 columns
    // no matter how little room there was.
    const blocks = staggerBlocks(ports, 6);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].top).toEqual([1,3,5,7,9,11]);
    expect(blocks[0].bottom).toEqual([2,4,6,8,10,12]);
    expect(blocks[1].top).toEqual([13,15,17,19,21,23]);
    expect(blocks[1].bottom).toEqual([14,16,18,20,22,24]);
  });

  it('never exceeds the column budget on any row', () => {
    for (const cols of [4, 6, 8, 12, 16]) {
      for (const blk of staggerBlocks(Array.from({ length: 48 }, (_, i) => i), cols)) {
        expect(blk.top.length).toBeLessThanOrEqual(cols);
        expect(blk.bottom.length).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('loses no ports, including on an odd count', () => {
    const blocks = staggerBlocks(Array.from({ length: 47 }, (_, i) => i), 8);
    const seen = blocks.flatMap((b) => [...b.top, ...b.bottom]).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 47 }, (_, i) => i));
  });

  it('handles an empty list', () => {
    expect(staggerBlocks([], 8)).toEqual([]);
  });
});

describe('resolveColumns', () => {
  it('measures the container on auto', () => {
    expect(resolveColumns('auto', 1200)).toBe(22);
  });

  it('ignores the container for explicit densities', () => {
    expect(resolveColumns('compact', 9000)).toBe(8);
    expect(resolveColumns('wide', 100)).toBe(24);
  });
});

/**
 * Widths for boards that actually exist.
 *
 * Compositions read from the reference fleet, plus the case the request came
 * from: a port-dense switch with several bonds. The old layout put all five
 * groups in one non-wrapping row inside `overflowX: auto`, so the only limit on
 * width was the port count.
 */
describe('real board widths', () => {
  const per = TILE_PX + TILE_GAP_PX;

  /** Widest row the new layout can produce for a given board. */
  function widestRow(b: { copper: number; sfp: number; bridges: number; bonds: number }, cols: number) {
    const groups = [
      Math.max(...staggerBlocks(Array.from({ length: b.copper }, (_, i) => i), cols)
        .flatMap((k) => [k.top.length, k.bottom.length]), 0),
      Math.max(...chunkRows(Array.from({ length: b.sfp }, (_, i) => i), cols).map((r) => r.length), 0),
      Math.max(...chunkRows(Array.from({ length: b.bridges }, (_, i) => i), cols).map((r) => r.length), 0),
      Math.max(...chunkRows(Array.from({ length: b.bonds }, (_, i) => i), cols).map((r) => r.length), 0),
    ];
    return Math.max(...groups) * per;
  }

  /** What the old layout produced: every group on one unbroken row. */
  function oldWidth(b: { copper: number; sfp: number; bridges: number; bonds: number }) {
    const eth = b.copper > 8 ? Math.ceil(b.copper / 2) : b.copper;
    return (eth + b.sfp + b.bridges + b.bonds) * per + 4 * 30;
  }

  const boards = {
    'wAP ax':            { copper: 2,  sfp: 0,  bridges: 1, bonds: 0 },
    'CRS510-8XS-2XQ':    { copper: 1,  sfp: 8,  bridges: 1, bonds: 1 },
    'CCR2216-12XS-2XQ':  { copper: 1,  sfp: 12, bridges: 1, bonds: 0 },
    'CRS310-8G+2S+':     { copper: 8,  sfp: 2,  bridges: 1, bonds: 0 },
    // The shape the request described: many ports *and* bonds.
    'CRS354-48G + bonds': { copper: 48, sfp: 4, bridges: 1, bonds: 8 },
  };

  it('keeps every real board inside a 1200px card', () => {
    const cols = resolveColumns('auto', 1200);
    for (const [name, b] of Object.entries(boards)) {
      expect(`${name}: ${widestRow(b, cols)}`).toBe(`${name}: ${widestRow(b, cols)}`);
      expect(widestRow(b, cols)).toBeLessThanOrEqual(1200);
    }
  });

  it('bounds the dense board that prompted the request', () => {
    const dense = boards['CRS354-48G + bonds'];
    // Old: 48 copper staggered to 24 columns, plus 4 SFP, a bridge and 8 bonds,
    // all on one row — past 1,900px before any card padding.
    expect(oldWidth(dense)).toBeGreaterThan(1900);
    // New, in a modest 900px card.
    expect(widestRow(dense, resolveColumns('auto', 900))).toBeLessThanOrEqual(900);
  });

  it('honours a narrow window, where the old layout simply scrolled', () => {
    const dense = boards['CRS354-48G + bonds'];
    expect(widestRow(dense, resolveColumns('auto', 600))).toBeLessThanOrEqual(600);
  });

  it('compact density is narrower than wide for the same board', () => {
    const dense = boards['CRS354-48G + bonds'];
    expect(widestRow(dense, resolveColumns('compact', 1200)))
      .toBeLessThan(widestRow(dense, resolveColumns('wide', 1200)));
  });
});
