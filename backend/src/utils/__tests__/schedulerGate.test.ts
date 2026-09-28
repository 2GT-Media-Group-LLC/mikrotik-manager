import { gateTtlSeconds } from '../schedulerGate';

describe('gateTtlSeconds', () => {
  it('outlives the interval, so a daily task stays daily', () => {
    expect(gateTtlSeconds(86_400_000)).toBeGreaterThan(86_400);
    expect(gateTtlSeconds(3_600_000)).toBeGreaterThan(3_600);
  });

  it('keeps ten minutes of slack for short intervals', () => {
    expect(gateTtlSeconds(60_000)).toBe(660);
  });

  it('falls back to the slack alone for a bad interval', () => {
    expect(gateTtlSeconds(NaN)).toBe(600);
    expect(gateTtlSeconds(-5)).toBe(600);
  });
});
