import { describe, it, expect } from 'vitest';
import { sitesInView, inView, newEntrySite } from './siteView';

const sites = [
  { id: 1, group_id: null },
  { id: 2, group_id: 10 },
  { id: 3, group_id: 10 },
  { id: 4, group_id: 20 },
];

describe('sitesInView', () => {
  it('is the chosen site', () => {
    expect(sitesInView(3, null, sites)).toEqual([3]);
  });

  it("is a group's sites", () => {
    expect(sitesInView(null, 10, sites)).toEqual([2, 3]);
    expect(sitesInView(null, 99, sites)).toEqual([]);
  });

  it('is every site with nothing chosen', () => {
    expect(sitesInView(null, null, sites)).toBeNull();
  });
});

describe('inView', () => {
  it("keeps the view's own entries and fleet-wide ones", () => {
    expect(inView(2, [2, 3])).toBe(true);
    expect(inView(null, [2, 3])).toBe(true);
    expect(inView(undefined, [])).toBe(true);
  });

  it("hides other sites' entries", () => {
    expect(inView(4, [2, 3])).toBe(false);
    expect(inView(4, [])).toBe(false);
  });

  it('keeps everything in the all-sites view', () => {
    expect(inView(4, null)).toBe(true);
  });
});

describe('newEntrySite', () => {
  it('starts in the site in view', () => {
    expect(newEntrySite([3], sites, true)).toBe('3');
    expect(newEntrySite([3], [{ id: 2 }, { id: 3 }], false)).toBe('3');
  });

  it('is fleet-wide for a fleet admin otherwise', () => {
    expect(newEntrySite(null, sites, true)).toBe('');
    expect(newEntrySite([2, 3], sites, true)).toBe('');
  });

  it('stays fleet-wide on a single-site install', () => {
    expect(newEntrySite([1], [{ id: 1 }], true)).toBe('');
  });

  it("is a site admin's first site, preferring one in view", () => {
    expect(newEntrySite(null, [{ id: 2 }, { id: 4 }], false)).toBe('2');
    expect(newEntrySite([3, 4], [{ id: 2 }, { id: 4 }], false)).toBe('4');
    // In view but not theirs to manage: their first site instead.
    expect(newEntrySite([1], [{ id: 2 }, { id: 4 }], false)).toBe('2');
    expect(newEntrySite(null, [], false)).toBe('');
  });
});
