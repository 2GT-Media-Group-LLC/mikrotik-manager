import { describe, it, expect } from 'vitest';
import { commonPrefix, shortName, pressure, sortCapacity, loadColor, loadText, memText, memoryCounts, memHint, capacityGrid } from './capacityCard';

describe('commonPrefix', () => {
  it('finds the shared start, cut back to a separator', () => {
    expect(commonPrefix(['01-NIKITINA-ASW01-2F', '01-NIKITINA-ASW05-POE--1F', '01-NIKITINA-CSW02'])).toBe('01-NIKITINA-');
    expect(commonPrefix(['site.core1', 'site.core2'])).toBe('site.');
    expect(commonPrefix(['hq_sw1', 'hq_sw2'])).toBe('hq_');
  });

  it('is empty when nothing useful is shared', () => {
    expect(commonPrefix(['only-one'])).toBe('');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['core1', 'core2'])).toBe('');
    expect(commonPrefix(['TEST', 'BigSwitch'])).toBe('');
    expect(commonPrefix(['a-b', 'c-d'])).toBe('');
  });

  it('is empty when hiding it would leave a name blank', () => {
    expect(commonPrefix(['lab-', 'lab-sw1'])).toBe('');
  });
});

describe('shortName', () => {
  it('drops the prefix only when there is one and something is left', () => {
    expect(shortName('01-NIKITINA-ASW01', '01-NIKITINA-')).toBe('ASW01');
    expect(shortName('other', '01-NIKITINA-')).toBe('other');
    expect(shortName('core1', '')).toBe('core1');
  });
});

describe('pressure and sortCapacity', () => {
  it('orders by CPU and lets memory count only when high', () => {
    const rows = [
      { name: 'a', cpu: 12, mem_pct: 44 },
      { name: 'b', cpu: 43, mem_pct: 44 },
      { name: 'c', cpu: 5, mem_pct: 60 },
      { name: 'd', cpu: 10, mem_pct: 81 },
    ];
    expect(pressure(rows[2])).toBe(5);
    expect(pressure(rows[3])).toBe(81);
    expect(sortCapacity(rows).map((r) => r.name)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('memory that sits high all week does not count; memory that grew does (#368)', () => {
    const ap = { name: 'wap-ax', cpu: 4, mem_pct: 89, mem_low_7d: 87 };
    const leak = { name: 'crs317', cpu: 6, mem_pct: 86, mem_low_7d: 60 };
    const router = { name: 'ccr2004', cpu: 27, mem_pct: 14, mem_low_7d: 13 };
    const sw = { name: 'crs328', cpu: 39, mem_pct: 14, mem_low_7d: 12 };
    expect(memoryCounts(ap)).toBe(false);
    expect(memoryCounts(leak)).toBe(true);
    expect(pressure(ap)).toBe(4);
    expect(sortCapacity([ap, router, leak, sw]).map((r) => r.name)).toEqual(['crs317', 'crs328', 'ccr2004', 'wap-ax']);
    // Exactly 10 points up counts; without a 7-day low, high memory counts as before.
    expect(memoryCounts({ name: 'x', cpu: 0, mem_pct: 85, mem_low_7d: 75 })).toBe(true);
    expect(memoryCounts({ name: 'x', cpu: 0, mem_pct: 85, mem_low_7d: 76 })).toBe(false);
    expect(memoryCounts({ name: 'x', cpu: 0, mem_pct: 80 })).toBe(true);
    expect(memoryCounts({ name: 'x', cpu: 0, mem_pct: 70, mem_low_7d: 10 })).toBe(false);
  });

  it('explains high memory in the hover', () => {
    expect(memHint({ name: 'x', cpu: 0, mem_pct: 60, mem_low_7d: 20 })).toBeUndefined();
    expect(memHint({ name: 'x', cpu: 0, mem_pct: 89, mem_low_7d: 87 })).toMatch(/steady \(7-day low 87 %\)/);
    expect(memHint({ name: 'x', cpu: 0, mem_pct: 86, mem_low_7d: 60 })).toMatch(/up 26 points/);
  });

  it('breaks ties by CPU before memory', () => {
    const rows = [
      { name: 'a', cpu: 5, mem_pct: 85, mem_low_7d: 84 },
      { name: 'b', cpu: 5, mem_pct: 20 },
      { name: 'c', cpu: 6, mem_pct: 10 },
    ];
    expect(sortCapacity(rows).map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });

  it('breaks ties by memory, then name', () => {
    const rows = [
      { name: 'z', cpu: 5, mem_pct: 30 },
      { name: 'y', cpu: 5, mem_pct: 40 },
      { name: 'x', cpu: 5, mem_pct: 30 },
    ];
    expect(sortCapacity(rows).map((r) => r.name)).toEqual(['y', 'x', 'z']);
  });
});

describe('colours', () => {
  it('greys normal load and colours from 50, 75 and 90', () => {
    expect(loadColor(12)).toBe('var(--ink-4)');
    expect(loadColor(50)).toBe('var(--accent)');
    expect(loadColor(75)).toBe('var(--warn)');
    expect(loadColor(90)).toBe('var(--bad)');
    expect(loadText(30)).toBe('var(--ink-3)');
    expect(loadText(62)).toBe('var(--accent)');
    expect(memText(60)).toBe('var(--ink-3)');
    expect(memText(80)).toBe('var(--warn)');
  });
});

describe('capacityGrid (#368)', () => {
  it('keeps the name column at 90 px or more, and drops the graph when narrow', () => {
    expect(capacityGrid(false)).toBe('minmax(90px,1fr) 96px 92px 38px');
    expect(capacityGrid(true)).toBe('minmax(90px,1fr) 92px 38px');
  });
});
