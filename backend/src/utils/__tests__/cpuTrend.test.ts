import { trendStart, trendSlots, trendPeak, TREND_SLOT_MS, TREND_SLOTS } from '../cpuTrend';

const now = Date.parse('2026-11-02T18:47:00Z');
const first = Date.parse('2026-11-01T19:00:00Z');

describe('trendStart', () => {
  it('starts 47 half hours before the current one', () => {
    expect(trendStart(now)).toBe(first);
    expect(trendStart(Date.parse('2026-11-02T18:30:00Z'))).toBe(first);
  });
});

describe('trendSlots', () => {
  it('puts each half-hour maximum in its slot and leaves gaps as null', () => {
    const s = trendSlots([
      { id: '7', start: first, value: 12.4 },
      { id: '7', start: first + 10 * TREND_SLOT_MS, value: 55.6 },
      { id: '7', start: first + 47 * TREND_SLOT_MS, value: 5 },
    ], now).get('7')!;
    expect(s).toHaveLength(TREND_SLOTS);
    expect(s[0]).toBe(12);
    expect(s[10]).toBe(56);
    expect(s[47]).toBe(5);
    expect(s[1]).toBeNull();
  });

  it('keeps the higher value when two series land in one slot', () => {
    const s = trendSlots([
      { id: '7', start: first, value: 30 },
      { id: '7', start: first, value: 20 },
    ], now).get('7')!;
    expect(s[0]).toBe(30);
  });

  it('drops points outside the 24 hours, without an id, or not a number', () => {
    const m = trendSlots([
      { id: '7', start: first - TREND_SLOT_MS, value: 99 },
      { id: '7', start: first + 48 * TREND_SLOT_MS, value: 99 },
      { id: '', start: first, value: 10 },
      { id: '8', start: first, value: NaN },
    ], now);
    expect(m.get('7')).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it('clamps to 0-100', () => {
    expect(trendSlots([{ id: '7', start: first, value: 140 }], now).get('7')![0]).toBe(100);
  });
});

describe('trendPeak', () => {
  it('is the highest value, or null for an empty trend', () => {
    expect(trendPeak([null, 4, 62, null, 9])).toBe(62);
    expect(trendPeak([null, null])).toBeNull();
    expect(trendPeak([])).toBeNull();
  });
});
