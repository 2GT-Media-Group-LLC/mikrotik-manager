import {
  parseDeviceLogTime, parseWallClock, wallClockToUtc, parseGmtOffsetMs,
} from '../deviceTime';

const NOW = new Date('2026-09-03T15:37:45Z');
const LA = { timeZoneName: 'America/Los_Angeles' };   // UTC-7 in September
const JAKARTA = { timeZoneName: 'Asia/Jakarta' };     // UTC+7, no DST

describe('parseWallClock', () => {
  it('reads the space-separated form current RouterOS returns', () => {
    // This one was not handled at all, so every such timestamp silently became
    // the moment of collection instead of the moment of the event.
    expect(parseWallClock('2026-09-03 08:37:38', NOW))
      .toEqual({ y: 2026, mo: 9, d: 3, h: 8, mi: 37, s: 38 });
  });

  it('reads the month-name forms, with and without a year', () => {
    expect(parseWallClock('sep/03/2026 08:37:38', NOW))
      .toEqual({ y: 2026, mo: 9, d: 3, h: 8, mi: 37, s: 38 });
    expect(parseWallClock('sep/03 08:37:38', NOW))
      .toEqual({ y: 2026, mo: 9, d: 3, h: 8, mi: 37, s: 38 });
  });

  it('reads a bare time as today', () => {
    expect(parseWallClock('08:37:38', NOW))
      .toEqual({ y: 2026, mo: 9, d: 3, h: 8, mi: 37, s: 38 });
  });

  it('returns null rather than guessing at nonsense', () => {
    expect(parseWallClock('', NOW)).toBeNull();
    expect(parseWallClock('yesterday', NOW)).toBeNull();
    expect(parseWallClock('xyz/03 08:37:38', NOW)).toBeNull();
  });
});

describe('wallClockToUtc', () => {
  it('converts device-local wall clock to the instant it names', () => {
    // 08:37 in Los Angeles during September is 15:37 UTC.
    expect(wallClockToUtc(2026, 9, 3, 8, 37, 38, 'America/Los_Angeles').toISOString())
      .toBe('2026-09-03T15:37:38.000Z');
  });

  it('handles a zone ahead of UTC', () => {
    expect(wallClockToUtc(2026, 9, 3, 15, 0, 0, 'Asia/Jakarta').toISOString())
      .toBe('2026-09-03T08:00:00.000Z');
  });

  it('respects daylight saving rather than a fixed offset', () => {
    // Same wall clock, six months apart: PDT (-7) then PST (-8).
    expect(wallClockToUtc(2026, 7, 1, 12, 0, 0, 'America/Los_Angeles').toISOString())
      .toBe('2026-07-01T19:00:00.000Z');
    expect(wallClockToUtc(2026, 1, 1, 12, 0, 0, 'America/Los_Angeles').toISOString())
      .toBe('2026-01-01T20:00:00.000Z');
  });
});

describe('parseGmtOffsetMs', () => {
  it('reads the forms RouterOS uses', () => {
    expect(parseGmtOffsetMs('-07:00')).toBe(-7 * 3600_000);
    expect(parseGmtOffsetMs('+05:30')).toBe(5.5 * 3600_000);
    expect(parseGmtOffsetMs('+0700')).toBe(7 * 3600_000);
    expect(parseGmtOffsetMs('25200')).toBe(7 * 3600_000);
  });
  it('returns null for nothing usable', () => {
    expect(parseGmtOffsetMs(null)).toBeNull();
    expect(parseGmtOffsetMs('')).toBeNull();
    expect(parseGmtOffsetMs('somewhere')).toBeNull();
  });
});

describe('parseDeviceLogTime — the reported bug', () => {
  it('does not shift an event by the device offset', () => {
    // Reported as the event log reading seven hours later than the device page.
    // A device in UTC+7 logging 15:00 means 08:00 UTC, not 15:00 UTC.
    expect(parseDeviceLogTime('sep/03 15:00:00', JAKARTA, NOW)!.toISOString())
      .toBe('2026-09-03T08:00:00.000Z');
  });

  it('places the space-separated form correctly too', () => {
    expect(parseDeviceLogTime('2026-09-03 08:37:38', LA, NOW)!.toISOString())
      .toBe('2026-09-03T15:37:38.000Z');
  });

  it('falls back to the numeric offset when the zone name is unusable', () => {
    expect(parseDeviceLogTime('2026-09-03 08:37:38', { gmtOffset: '-07:00' }, NOW)!.toISOString())
      .toBe('2026-09-03T15:37:38.000Z');
    expect(parseDeviceLogTime('2026-09-03 08:37:38', { timeZoneName: 'Nowhere/Real', gmtOffset: '-07:00' }, NOW)!.toISOString())
      .toBe('2026-09-03T15:37:38.000Z');
  });

  it('returns null when the device timezone is unknown', () => {
    // Deliberately: the caller decides what to do. A confidently wrong
    // timestamp is worse than an openly approximate one.
    expect(parseDeviceLogTime('2026-09-03 08:37:38', {}, NOW)).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(parseDeviceLogTime('not a time', LA, NOW)).toBeNull();
  });
});
