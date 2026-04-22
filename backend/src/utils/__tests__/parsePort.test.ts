import { parsePort } from '../parsePort';

describe('parsePort', () => {
  it('returns fallback for null, undefined, empty string', () => {
    expect(parsePort(null, 8728)).toBe(8728);
    expect(parsePort(undefined, 22)).toBe(22);
    expect(parsePort('', 8728)).toBe(8728);
  });

  it('parses numbers and numeric strings', () => {
    expect(parsePort(8729, 8728)).toBe(8729);
    expect(parsePort('8729', 8728)).toBe(8729);
    expect(parsePort('22', 22)).toBe(22);
  });

  it('returns fallback for NaN and non-numeric strings', () => {
    expect(parsePort('abc', 8728)).toBe(8728);
    expect(parsePort(NaN, 22)).toBe(22);
  });
});
