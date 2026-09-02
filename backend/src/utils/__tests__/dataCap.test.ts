import { bytesSince, periodKey, effectiveThreshold, shouldSend } from '../dataCap';

const GB = 1024 ** 3;

describe('bytesSince', () => {
  it('establishes a baseline on first sight rather than counting everything', () => {
    expect(bytesSince(null, { rxBytes: 5_000, txBytes: 1_000 })).toBe(0);
  });

  it('sums both directions, as the carrier does', () => {
    expect(bytesSince({ rxBytes: 100, txBytes: 50 }, { rxBytes: 400, txBytes: 150 })).toBe(400);
  });

  it('treats a counter that went backwards as a reboot, not negative usage', () => {
    // Confirmed on the target hardware: LTE byte counters do not survive a reboot.
    expect(bytesSince({ rxBytes: 9_000, txBytes: 9_000 }, { rxBytes: 10, txBytes: 5 })).toBe(15);
  });

  it('handles one direction resetting while the other does not', () => {
    expect(bytesSince({ rxBytes: 9_000, txBytes: 100 }, { rxBytes: 10, txBytes: 400 })).toBe(310);
  });

  it('ignores nonsense counters instead of poisoning the total', () => {
    expect(bytesSince({ rxBytes: 100, txBytes: 100 }, { rxBytes: NaN, txBytes: -5 })).toBe(0);
  });
});

describe('periodKey', () => {
  const SOFIA = 'Europe/Sofia'; // UTC+3 in September

  it('groups an instant into the local day', () => {
    expect(periodKey(new Date('2026-09-02T09:00:00Z'), 0, 0, SOFIA)).toBe('2026-09-02');
  });

  it('puts the hour before local midnight in the previous period', () => {
    // 21:30 UTC is 00:30 on the 3rd in Sofia — a new period.
    expect(periodKey(new Date('2026-09-02T21:30:00Z'), 0, 0, SOFIA)).toBe('2026-09-03');
    // 20:30 UTC is 23:30 on the 2nd — still the old one.
    expect(periodKey(new Date('2026-09-02T20:30:00Z'), 0, 0, SOFIA)).toBe('2026-09-02');
  });

  it('respects a non-midnight reset time', () => {
    // Reset at 04:00 local: 02:00 local still belongs to the previous day.
    expect(periodKey(new Date('2026-09-02T23:00:00Z'), 4, 0, SOFIA)).toBe('2026-09-02');
    expect(periodKey(new Date('2026-09-03T01:30:00Z'), 4, 0, SOFIA)).toBe('2026-09-03');
  });

  it('rolls the month and year correctly', () => {
    expect(periodKey(new Date('2027-01-01T00:30:00Z'), 4, 0, 'UTC')).toBe('2026-12-31');
  });

  it('falls back to UTC for an unknown zone rather than throwing', () => {
    expect(periodKey(new Date('2026-09-02T09:00:00Z'), 0, 0, 'Mars/Base')).toBe('2026-09-02');
  });
});

describe('effectiveThreshold', () => {
  it('fires below the configured allowance, because our count undercounts', () => {
    expect(effectiveThreshold(10 * GB, 5)).toBe(Math.floor(10 * GB * 0.95));
  });
  it('allows no margin when asked', () => {
    expect(effectiveThreshold(10 * GB, 0)).toBe(10 * GB);
  });
  it('refuses an absurd margin', () => {
    expect(effectiveThreshold(10 * GB, 90)).toBe(effectiveThreshold(10 * GB, 50));
  });
});

describe('shouldSend', () => {
  const base = {
    thresholdBytes: 10 * GB, marginPct: 5, cooldownMinutes: 60,
    lastSentAt: null as Date | null, enabled: true,
  };
  const NOW = new Date('2026-09-02T12:00:00Z');

  it('stays quiet below the threshold', () => {
    expect(shouldSend({ ...base, periodBytes: 5 * GB }, NOW).reason).toBe('below-threshold');
  });

  it('fires at the margin-adjusted threshold, not the raw one', () => {
    expect(shouldSend({ ...base, periodBytes: 9.6 * GB }, NOW).send).toBe(true);
  });

  it('will not fire again inside the cooldown', () => {
    // Usage sits *at* the cap once reached; without this it would text on every poll.
    const justSent = new Date(NOW.getTime() - 10 * 60_000);
    const d = shouldSend({ ...base, periodBytes: 11 * GB, lastSentAt: justSent }, NOW);
    expect(d).toEqual({ send: false, reason: 'cooling-down' });
  });

  it('fires again once the cooldown has passed', () => {
    const old = new Date(NOW.getTime() - 90 * 60_000);
    expect(shouldSend({ ...base, periodBytes: 11 * GB, lastSentAt: old }, NOW).send).toBe(true);
  });

  it('does nothing when disabled, whatever the usage', () => {
    expect(shouldSend({ ...base, periodBytes: 99 * GB, enabled: false }, NOW).reason).toBe('disabled');
  });
});
