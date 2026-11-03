import { describe, it, expect } from 'vitest';
import { placeNew } from './topologyPlace';
import type { GraphNode } from './topologyGraph';

const node = (id: string, x: number, y: number, parent?: string): GraphNode =>
  ({ id, kind: 'external', x, y, data: {}, ...(parent ? { parent } : {}) });

describe('placeNew (#367)', () => {
  it('keeps what is on screen where it is', () => {
    const at = placeNew([node('sw', 0, 0), node('chip', 300, 200, 'sw')], new Map([['sw', { x: 50, y: 50 }], ['chip', { x: 900, y: 260 }]]));
    expect(at('chip')).toEqual({ x: 900, y: 260 });
  });

  it('puts a new card under its parent where the parent is now, not where the layout moved it', () => {
    // Opening the chip moved it in the layout from x 900 to 300; on screen it is still at 900.
    const at = placeNew(
      [node('sw', 0, 0), node('chip', 300, 200, 'sw'), node('h1', 180, 360, 'chip'), node('h2', 420, 360, 'chip')],
      new Map([['sw', { x: 0, y: 0 }], ['chip', { x: 900, y: 200 }]]));
    expect(at('h1')).toEqual({ x: 780, y: 360 });
    expect(at('h2')).toEqual({ x: 1020, y: 360 });
  });

  it('leaves a card placed by hand where it was saved', () => {
    const at = placeNew([node('chip', 300, 200), { ...node('c', 50, 900, 'chip'), pinned: true }], new Map([['chip', { x: 900, y: 200 }]]));
    expect(at('c')).toEqual({ x: 50, y: 900 });
  });

  it('follows a chain of new cards, and takes the layout where nothing is on screen', () => {
    const nodes = [node('sw', 0, 0), node('chip', 300, 200, 'sw'), node('vlan', 300, 360, 'chip'), node('c', 300, 500, 'vlan')];
    expect(placeNew(nodes, new Map([['sw', { x: 100, y: 0 }]]))('c')).toEqual({ x: 400, y: 500 });
    expect(placeNew(nodes, new Map())('c')).toEqual({ x: 300, y: 500 });
  });
});
