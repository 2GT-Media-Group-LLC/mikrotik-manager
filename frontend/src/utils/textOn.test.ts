import { describe, it, expect } from 'vitest';
import { contrast, textOn } from './textOn';

describe('textOn', () => {
  it('puts dark text on the bright status colours and white on dark ones', () => {
    for (const bg of ['#22c55e', '#84cc16', '#f59e0b', '#eab308', '#ef4444']) {
      expect(textOn(bg)).toBe('#111827');
      expect(contrast(bg, textOn(bg))).toBeGreaterThanOrEqual(4.5);
    }
    expect(textOn('#1d4ed8')).toBe('#ffffff');
    expect(textOn('#111827')).toBe('#ffffff');
  });
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
