import { describe, it, expect } from 'vitest';
import { barGeometry } from './spectrumGeometry';

// The 2.4 GHz band as drawn, wide enough to contain a 40 MHz channel 1.
const B24 = [2390, 2500] as const;

describe('barGeometry', () => {
  it('places an ordinary carrier proportionally', () => {
    // Channel 6 at 20 MHz: 2427–2447 within 2390–2500.
    const g = barGeometry(2427, 2447, ...B24);
    expect(g.leftPct).toBeCloseTo(33.6, 1);
    expect(g.widthPct).toBeCloseTo(18.2, 1);
  });

  it('keeps a 40 MHz channel 1 inside the band', () => {
    // The regression: 2392 sits below a 2400 start and produced left: -8%,
    // which painted the bar outside the card.
    const g = barGeometry(2392, 2432, ...B24);
    expect(g.leftPct).toBeGreaterThanOrEqual(0);
    expect(g.leftPct).toBeCloseTo(1.8, 1);
    expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100);
  });

  it('never returns a negative offset, whatever the band', () => {
    // Even against the old, too-narrow band the bar stays inside the card.
    const g = barGeometry(2392, 2432, 2400, 2500);
    expect(g.leftPct).toBe(0);
    expect(g.widthPct).toBeCloseTo(32, 1);
  });

  it('never overhangs the right edge', () => {
    const g = barGeometry(2480, 2540, ...B24);
    expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100);
  });

  it('keeps a hairline carrier visible', () => {
    const g = barGeometry(2410, 2410, ...B24);
    expect(g.widthPct).toBeGreaterThan(0);
  });

  it('keeps a carrier at the extreme right edge on the card', () => {
    const g = barGeometry(2500, 2500, ...B24);
    expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100);
    expect(g.leftPct).toBeGreaterThanOrEqual(0);
  });

  it('survives a degenerate band range', () => {
    const g = barGeometry(2400, 2420, 2400, 2400);
    expect(g.leftPct).toBe(0);
    expect(g.widthPct).toBeGreaterThan(0);
  });

  it('handles a 160 MHz 5 GHz carrier', () => {
    // wifi2 on channel 100: 5420–5580 within 5150–5895.
    const g = barGeometry(5420, 5580, 5150, 5895);
    expect(g.leftPct).toBeCloseTo(36.2, 1);
    expect(g.widthPct).toBeCloseTo(21.5, 1);
  });
});
