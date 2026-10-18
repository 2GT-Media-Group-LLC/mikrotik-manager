import { describe, it, expect } from 'vitest';
import { byAttention } from './deviceCards';

describe('device cards order (#303)', () => {
  it('puts offline, then other trouble, then updates first, by name within each', () => {
    const ds = [
      { name: 'sw-10', status: 'online' },
      { name: 'sw-2', status: 'online', firmware_update_available: true },
      { name: 'rtr-1', status: 'offline' },
      { name: 'ap-1', status: 'unknown' },
      { name: 'sw-1', status: 'online' },
      { name: 'ap-0', status: 'offline' },
    ];
    expect(byAttention(ds).map((d) => d.name)).toEqual(['ap-0', 'rtr-1', 'ap-1', 'sw-2', 'sw-1', 'sw-10']);
  });

  it('does not reorder the caller\'s array', () => {
    const ds = [{ name: 'b', status: 'online' }, { name: 'a', status: 'offline' }];
    byAttention(ds);
    expect(ds[0].name).toBe('b');
  });
});

import { shortList } from './deviceCards';
describe('shortList (#303)', () => {
  it('names a few, counts the rest', () => {
    expect(shortList(['a', 'b'])).toBe('a, b');
    expect(shortList(['a', 'b', 'c', 'd'], 2)).toBe('a, b and 2 more');
  });
});
