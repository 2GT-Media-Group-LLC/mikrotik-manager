import { offlineAction, recoveryAlert, describeDuration } from '../intermittent';

const now = new Date('2026-09-25T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const base = { intermittent: true, alertAfterMin: 1440, wasOffline: true, offlineSince: hoursAgo(1), alreadyAlerted: false, now };

describe('offlineAction', () => {
  it('alerts once for a normal device going offline', () => {
    expect(offlineAction({ ...base, intermittent: false, wasOffline: false })).toBe('alert');
    expect(offlineAction({ ...base, intermittent: false, wasOffline: true })).toBe('none');
  });
  it('stays quiet when an intermittent device drops out', () => {
    expect(offlineAction({ ...base, wasOffline: false, offlineSince: now })).toBe('none');
    expect(offlineAction(base)).toBe('none');
  });
  it('alerts once when it has been gone longer than its limit', () => {
    expect(offlineAction({ ...base, offlineSince: hoursAgo(25) })).toBe('alert-long-offline');
    expect(offlineAction({ ...base, offlineSince: hoursAgo(25), alreadyAlerted: true })).toBe('none');
  });
  it('never alerts with a limit of 0', () => {
    expect(offlineAction({ ...base, alertAfterMin: 0, offlineSince: hoursAgo(500) })).toBe('none');
  });
});

describe('recoveryAlert', () => {
  it('only follows a long-offline alert for intermittent devices', () => {
    expect(recoveryAlert(true, false)).toBe(false);
    expect(recoveryAlert(true, true)).toBe(true);
    expect(recoveryAlert(false, false)).toBe(true);
  });
});

it('describes durations plainly', () => {
  expect(describeDuration(45)).toBe('45 minutes');
  expect(describeDuration(25 * 60)).toBe('25 hours');
  expect(describeDuration(72 * 60)).toBe('3 days');
});
