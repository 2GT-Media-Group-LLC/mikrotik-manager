import { describe, it, expect } from 'vitest';
import { borderToward, sidePoint, linkEnds, sideOf } from './topologyGeometry';

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
