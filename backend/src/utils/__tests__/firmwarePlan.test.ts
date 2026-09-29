import { upgradeDecision, verifyUpgrade, scheduleDecision } from '../firmwarePlan';

describe('upgradeDecision', () => {
  it('upgrades only to a genuinely newer version', () => {
    expect(upgradeDecision('7.24.3', '7.24.4')).toEqual({ action: 'upgrade' });
    expect(upgradeDecision('7.25beta3', '7.25')).toEqual({ action: 'upgrade' });
  });

  it('never downgrades, e.g. a stable device pointed at the long-term channel', () => {
    const d = upgradeDecision('7.24.4', '7.20.8');
    expect(d.action).toBe('skip');
    expect(d.action === 'skip' && d.reason).toMatch(/older than the installed 7\.24\.4/);
  });

  it('skips when current, and when versions cannot be compared', () => {
    expect(upgradeDecision('7.24.4', '7.24.4')).toEqual({ action: 'skip', reason: 'Already up to date' });
    expect(upgradeDecision('7.24.4', '')).toMatchObject({ action: 'skip' });
    expect(upgradeDecision('', '7.24.4')).toMatchObject({ action: 'skip' });
  });
});

describe('verifyUpgrade', () => {
  it('passes only when the device reports the target version', () => {
    expect(verifyUpgrade('7.24.4', '7.24.4', '7.24.3')).toEqual({ ok: true });
  });

  it('fails when the version did not move, moved elsewhere, or cannot be read', () => {
    expect(verifyUpgrade('7.24.4', '7.24.3', '7.24.3')).toMatchObject({ ok: false, error: expect.stringMatching(/still reports 7\.24\.3/) });
    expect(verifyUpgrade('7.24.4', '7.25', '7.24.3')).toMatchObject({ ok: false, error: expect.stringMatching(/Expected 7\.24\.4/) });
    expect(verifyUpgrade('7.24.4', '', '7.24.3')).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });
  });
});

describe('scheduleDecision', () => {
  const at = new Date('2026-09-28T02:00:00Z');
  it('waits before its time and starts inside its window', () => {
    expect(scheduleDecision(at, null, new Date('2026-09-28T01:59:00Z'))).toBe('wait');
    expect(scheduleDecision(at, null, new Date('2026-09-28T02:30:00Z'))).toBe('start');
  });

  it('is missed, not caught up, once the window has passed', () => {
    expect(scheduleDecision(at, null, new Date('2026-09-28T03:01:00Z'))).toBe('missed');   // default 60 min
    const until = new Date('2026-09-28T05:00:00Z');
    expect(scheduleDecision(at, until, new Date('2026-09-28T04:00:00Z'))).toBe('start');
    expect(scheduleDecision(at, until, new Date('2026-09-28T09:00:00Z'))).toBe('missed');
  });
});
