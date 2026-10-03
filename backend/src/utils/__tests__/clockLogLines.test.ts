import { isClockChangeLine } from '../clockLogLines';

// As RouterOS logs them (from the test fleet).
describe('clock-change log lines (#213)', () => {
  it('recognises NTP and IP Cloud adjustments', () => {
    expect(isClockChangeLine('ntp change time Sep/29/2026 22:31:49 => Sep/30/2026 09:37:02')).toBe(true);
    expect(isClockChangeLine('cloud change time Sep/20/2026 04:24:48 => Sep/20/2026 04:24:48')).toBe(true);
  });
  it('leaves everything else alone', () => {
    expect(isClockChangeLine('user admin logged in from 10.0.0.1 via winbox')).toBe(false);
    expect(isClockChangeLine('system time zone changed')).toBe(false);
    expect(isClockChangeLine('ntp server unreachable')).toBe(false);
    expect(isClockChangeLine(null)).toBe(false);
  });
});
