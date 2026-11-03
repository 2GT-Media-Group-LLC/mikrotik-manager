import { describe, it, expect } from 'vitest';
import { borderToward, sidePoint, linkEnds, sideOf, curveEnds, parallelOffset } from './topologyGeometry';

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
