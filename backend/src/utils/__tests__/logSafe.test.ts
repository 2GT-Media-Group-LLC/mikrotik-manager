import { logSafe } from '../logSafe';

describe('logSafe', () => {
  it('leaves ordinary values alone', () => {
    expect(logSafe('ether1')).toBe('ether1');
    expect(logSafe(42)).toBe('42');
    expect(logSafe('2GT-NW-100G')).toBe('2GT-NW-100G');
  });

  it('stops a value forging a second log entry', () => {
    // The whole point: a log that its subject can write lines into is worse
    // than no log, because it is believed.
    const forged = logSafe('7\n[preflight] device 999 verified OK');
    expect(forged).not.toContain('\n');
    expect(forged).toContain('[preflight] device 999 verified OK');
  });

  it('handles carriage returns and other control characters', () => {
    expect(logSafe('a\r\nb')).not.toMatch(/[\r\n]/);
    expect(logSafe('a\u0007b\u001bc')).toBe('a\u2423b\u2423c');
  });

  it('marks what it replaced rather than hiding it', () => {
    expect(logSafe('a\nb')).toBe('a\u2423b');
  });

  it('truncates absurd input so one value cannot flood the log', () => {
    const out = logSafe('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles null and undefined without printing them', () => {
    expect(logSafe(null)).toBe('');
    expect(logSafe(undefined)).toBe('');
  });
});
