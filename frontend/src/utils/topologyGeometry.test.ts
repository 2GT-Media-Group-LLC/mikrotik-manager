import { describe, it, expect } from 'vitest';
import { borderToward, sidePoint, linkEnds, sideOf, curveEnds, parallelOffset, spreadCurveEnds } from './topologyGeometry';

const card = (x: number, y: number) => ({ x, y, w: 160, h: 60 });

describe('topology link geometry', () => {
  it('stops a link at the edge of each card, along the line between them', () => {
    const { s, t } = linkEnds(card(0, 0), card(0, 300));
    expect(s).toEqual({ x: 80, y: 60 });   // bottom middle of the upper card
    expect(t).toEqual({ x: 80, y: 300 });  // top middle of the lower one
  });

  it('leaves through the side for a card off to the right', () => {
    expect(borderToward(card(0, 0), { x: 1000, y: 30 })).toEqual({ x: 160, y: 30 });
  });

  it('pins an end to the chosen side', () => {
    const { s, t } = linkEnds(card(0, 0), card(0, 300), 'r', 'r');
    expect(s).toEqual(sidePoint(card(0, 0), 'r'));
    expect(t).toEqual({ x: 160, y: 330 });
  });

  it('aims the free end at a pinned one', () => {
    const { t } = linkEnds(card(0, 0), card(400, 0), 'b', null);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.x).toBeGreaterThanOrEqual(400);
  });

  it('shifts a parallel cable sideways', () => {
    const a = linkEnds(card(0, 0), card(0, 300));
    const b = linkEnds(card(0, 0), card(0, 300), null, null, 1);
    expect(b.s.y).toBe(a.s.y);
    expect(Math.abs(b.s.x - a.s.x)).toBe(14);
  });
});

describe('sideOf', () => {
  it('names the side a border point is on', () => {
    expect(sideOf(card(0, 0), { x: 80, y: 60 })).toBe('b');
    expect(sideOf(card(0, 0), { x: 160, y: 30 })).toBe('r');
    expect(sideOf(card(0, 0), { x: 0, y: 20 })).toBe('l');
  });
});

describe('curved links (#367)', () => {
  it('runs from the bottom of the upper card to the top of the lower one, whichever end is the source', () => {
    expect(curveEnds(card(0, 0), card(300, 200))).toEqual({ s: { x: 80, y: 60 }, t: { x: 380, y: 200 }, sSide: 'b', tSide: 't' });
    expect(curveEnds(card(300, 200), card(0, 0))).toEqual({ s: { x: 380, y: 200 }, t: { x: 80, y: 60 }, sSide: 't', tSide: 'b' });
  });

  it('runs side to side between cards on the same row', () => {
    expect(curveEnds(card(0, 0), card(300, 20))).toMatchObject({ s: { x: 160, y: 30 }, t: { x: 300, y: 50 }, sSide: 'r', tSide: 'l' });
    expect(curveEnds(card(300, 0), card(0, 0))).toMatchObject({ sSide: 'l', tSide: 'r' });
  });

  it('fans parallel cables out along the side and keeps them on the card', () => {
    expect([0, 1, 2, 3].map(parallelOffset)).toEqual([0, 16, -16, 32]);
    expect(curveEnds(card(0, 0), card(0, 300), 1).s).toEqual({ x: 96, y: 60 });
    expect(curveEnds(card(0, 0), card(0, 300), 2).t).toEqual({ x: 64, y: 300 });
    expect(curveEnds(card(0, 0), card(0, 300), 19).s.x).toBe(152);
    expect(curveEnds(card(0, 0), card(0, 300), 20).s.x).toBe(8);
  });
});

describe('spreadCurveEnds (#367)', () => {
  // A switch with four cards on the row below it, given out of order.
  const sw = { x: 300, y: 0, w: 150, h: 60 };
  const below = (x: number) => ({ x, y: 200, w: 150, h: 60 });
  const rects = new Map([['sw', sw], ['a', below(0)], ['b', below(200)], ['c', below(400)], ['d', below(600)]]);
  const edges = [
    { id: 'e-c', source: 'sw', target: 'c' }, { id: 'e-a', source: 'sw', target: 'a' },
    { id: 'e-d', source: 'sw', target: 'd' }, { id: 'e-b', source: 'b', target: 'sw' },
  ];

  it('gives each link under a card its own point, in the order of where it goes', () => {
    const ends = spreadCurveEnds(rects, edges);
    const under = (id: string, which: 's' | 't') => ends.get(id)![which];
    const xs = [under('e-a', 's').x, under('e-b', 't').x, under('e-c', 's').x, under('e-d', 's').x];
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    expect(new Set(xs).size).toBe(4);
    // Centred on the side, 26 apart, all on the bottom edge.
    expect(xs).toEqual([336, 362, 388, 414]);
    expect(ends.get('e-a')!.s.y).toBe(60);
    expect(ends.get('e-b')).toMatchObject({ sSide: 't', tSide: 'b' });
    // A card with one link takes it at the middle of its side.
    expect(ends.get('e-a')!.t).toEqual({ x: 75, y: 200 });
  });

  it('squeezes the gap to fit a narrow side, clear of the corners', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, source: 'sw', target: `n${i}` }));
    const r = new Map<string, { x: number; y: number; w: number; h: number }>([['sw', sw]]);
    many.forEach((e, i) => r.set(e.target, below(i * 160)));
    const xs = many.map((e) => spreadCurveEnds(r, many).get(e.id)!.s.x);
    expect(Math.min(...xs)).toBeCloseTo(310);
    expect(Math.max(...xs)).toBeCloseTo(440);
  });

  it('keeps two cables between the same cards in the same order at both ends', () => {
    const r = new Map([['x', { x: 0, y: 0, w: 150, h: 60 }], ['y', { x: 0, y: 200, w: 150, h: 60 }]]);
    const ends = spreadCurveEnds(r, [{ id: 'c1', source: 'x', target: 'y' }, { id: 'c2', source: 'y', target: 'x' }]);
    const c1 = ends.get('c1')!;
    const c2 = ends.get('c2')!;
    expect(c1.s.x).toBeLessThan(c2.t.x);
    expect(c1.t.x).toBeLessThan(c2.s.x);
  });

  it('leaves out an edge whose card is not measured yet', () => {
    expect(spreadCurveEnds(new Map([['sw', sw]]), [{ id: 'e', source: 'sw', target: 'zz' }]).size).toBe(0);
  });
});
