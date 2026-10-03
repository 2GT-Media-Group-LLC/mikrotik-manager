import { describe, it, expect } from 'vitest';
import { rosDurationSeconds } from './rosDuration';

describe('rosDurationSeconds (#206)', () => {
  it('reads RouterOS 7 durations', () => {
    expect(rosDurationSeconds('25s')).toBe(25);
    expect(rosDurationSeconds('1m30s')).toBe(90);
    expect(rosDurationSeconds('1d2h')).toBe(93600);
    expect(rosDurationSeconds('1w')).toBe(604800);
  });
  it('reads RouterOS 6 clock form and bare seconds', () => {
    expect(rosDurationSeconds('00:00:25')).toBe(25);
    expect(rosDurationSeconds('1d 01:00:00')).toBe(90000);
    expect(rosDurationSeconds('25')).toBe(25);
  });
  it('returns null for nothing or nonsense', () => {
    expect(rosDurationSeconds('')).toBeNull();
    expect(rosDurationSeconds(undefined)).toBeNull();
    expect(rosDurationSeconds('soon')).toBeNull();
  });
});
