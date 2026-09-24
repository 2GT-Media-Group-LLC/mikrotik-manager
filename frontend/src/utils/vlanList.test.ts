import { describe, it, expect } from 'vitest';
import { parseVlanList, formatVlanList, toggleVlan } from './vlanList';

describe('parseVlanList', () => {
  it('reads commas, spaces and ranges', () => {
    expect(parseVlanList('10, 20-22,30')).toEqual([10, 20, 21, 22, 30]);
  });

  it('pastes a RouterOS-style list', () => {
    expect(parseVlanList('100-102,200')).toEqual([100, 101, 102, 200]);
  });

  it('drops invalid and out-of-range ids', () => {
    expect(parseVlanList('0, 5, 4095, abc, 7')).toEqual([5, 7]);
  });

  it('de-duplicates and sorts', () => {
    expect(parseVlanList('30,10,10')).toEqual([10, 30]);
  });
});

describe('formatVlanList', () => {
  it('collapses runs of three or more', () => {
    expect(formatVlanList([10, 11, 12, 20])).toBe('10-12,20');
  });

  it('keeps pairs as a list', () => {
    expect(formatVlanList([10, 11])).toBe('10,11');
  });

  it('round-trips', () => {
    expect(formatVlanList(parseVlanList('5,6,7,9,100-102'))).toBe('5-7,9,100-102');
  });
});

describe('toggleVlan', () => {
  it('adds and removes', () => {
    expect(toggleVlan('10,20', 30)).toBe('10,20,30');
    expect(toggleVlan('10,20,30', 20)).toBe('10,30');
  });

  it('works on a range', () => {
    expect(toggleVlan('10-12', 11)).toBe('10,12');
  });
});
