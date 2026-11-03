import { describe, it, expect } from 'vitest';
import { commonPrefix, shortName, pressure, sortCapacity, loadColor, loadText, memText } from './capacityCard';

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
