import { describe, it, expect } from 'vitest';
import { parsePort } from './parsePort';

describe('parsePort', () => {
  it('uses fallback for empty', () => {
    expect(parsePort('', 8728)).toBe(8728);
    expect(parsePort(null, 22)).toBe(22);
  });
  it('parses valid', () => {
    expect(parsePort('8729', 8728)).toBe(8729);
    expect(parsePort(22, 8728)).toBe(22);
  });
  it('rejects invalid', () => {
    expect(parsePort('x', 8728)).toBe(8728);
  });
});
