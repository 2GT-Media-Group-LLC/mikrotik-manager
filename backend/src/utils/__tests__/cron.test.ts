import { cronMatches, zonedParts, matchField } from '../cron';

// 2026-09-02T09:30:00Z — a Wednesday.
const AT = new Date('2026-09-02T09:30:00Z');

describe('zonedParts', () => {
  it('reads wall-clock fields in the requested zone', () => {
    expect(zonedParts(AT, 'UTC')).toEqual({ minute: 30, hour: 9, dom: 2, month: 9, dow: 3 });
    // UTC-7 in September.
    expect(zonedParts(AT, 'America/Los_Angeles')).toEqual({ minute: 30, hour: 2, dom: 2, month: 9, dow: 3 });
    // UTC+3 in September.
    expect(zonedParts(AT, 'Europe/Sofia')).toEqual({ minute: 30, hour: 12, dom: 2, month: 9, dow: 3 });
  });

  it('rolls the date backwards across the dateline', () => {
    // 01:00 UTC on the 2nd is still the 1st in Los Angeles.
    const p = zonedParts(new Date('2026-09-02T01:00:00Z'), 'America/Los_Angeles');
    expect(p.dom).toBe(1);
    expect(p.hour).toBe(18);
    expect(p.dow).toBe(2); // Tuesday, not Wednesday
  });

  it('handles midnight as hour 0, never 24', () => {
    expect(zonedParts(new Date('2026-09-02T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  it('respects daylight saving rather than a fixed offset', () => {
    const summer = zonedParts(new Date('2026-07-01T12:00:00Z'), 'America/New_York').hour; // EDT, -4
    const winter = zonedParts(new Date('2026-01-01T12:00:00Z'), 'America/New_York').hour; // EST, -5
    expect(summer).toBe(8);
    expect(winter).toBe(7);
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(zonedParts(AT, 'Mars/Olympus_Mons')).toEqual(zonedParts(AT, 'UTC'));
  });
});

describe('matchField', () => {
  it('handles wildcards, lists, ranges and steps', () => {
    expect(matchField('*', 5)).toBe(true);
    expect(matchField('5', 5)).toBe(true);
    expect(matchField('1,3,5', 3)).toBe(true);
    expect(matchField('1,3,5', 4)).toBe(false);
    expect(matchField('1-5', 4)).toBe(true);
    expect(matchField('1-5', 6)).toBe(false);
    expect(matchField('*/15', 30)).toBe(true);
    expect(matchField('*/15', 31)).toBe(false);
  });

  it('rejects a zero or nonsense step rather than dividing by it', () => {
    expect(matchField('*/0', 5)).toBe(false);
    expect(matchField('*/x', 5)).toBe(false);
  });
});

describe('cronMatches — the #117 bug', () => {
  it('fires a 02:00 job at 02:00 local, not 02:00 UTC', () => {
    // The exact failure: 09:30 UTC is 02:30 in Los Angeles.
    const at0230 = new Date('2026-09-02T09:30:00Z');
    expect(cronMatches('30 2 * * *', at0230, 'America/Los_Angeles')).toBe(true);
    expect(cronMatches('30 2 * * *', at0230, 'UTC')).toBe(false);
  });

  it('does not fire the same job twice in different zones', () => {
    const at = new Date('2026-09-02T09:30:00Z');
    const zones = ['UTC', 'America/Los_Angeles', 'Europe/Sofia'];
    const fired = zones.filter((z) => cronMatches('30 2 * * *', at, z));
    expect(fired).toEqual(['America/Los_Angeles']);
  });

  it('matches day-of-week in the local zone', () => {
    // 01:00 UTC Wednesday is still Tuesday evening in Los Angeles.
    const at = new Date('2026-09-02T01:00:00Z');
    expect(cronMatches('0 18 * * 2', at, 'America/Los_Angeles')).toBe(true); // Tue
    expect(cronMatches('0 18 * * 3', at, 'America/Los_Angeles')).toBe(false); // Wed
  });

  it('runs when either dom or dow matches, per the standard rule', () => {
    const at = new Date('2026-09-02T09:30:00Z'); // 2nd, a Wednesday, 09:30 UTC
    expect(cronMatches('30 9 2 * 0', at, 'UTC')).toBe(true);   // dom matches, dow does not
    expect(cronMatches('30 9 15 * 3', at, 'UTC')).toBe(true);  // dow matches, dom does not
    expect(cronMatches('30 9 15 * 0', at, 'UTC')).toBe(false); // neither
  });

  it('requires all five fields', () => {
    expect(cronMatches('30 9 * *', AT, 'UTC')).toBe(false);
    expect(cronMatches('', AT, 'UTC')).toBe(false);
  });

  it('defaults to UTC when no zone is given', () => {
    expect(cronMatches('30 9 * * *', AT)).toBe(true);
  });
});
