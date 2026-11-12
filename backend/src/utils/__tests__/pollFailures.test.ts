import {
  DEFAULT_FAILED_POLLS_BEFORE_OFFLINE,
  failedPollsBeforeOffline,
  isSiteOutage,
  shouldMarkOffline,
  siteOutageMessage,
  recoveryKind,
} from '../pollFailures';

describe('failedPollsBeforeOffline', () => {
  it.each([
    [undefined, DEFAULT_FAILED_POLLS_BEFORE_OFFLINE],
    [null, DEFAULT_FAILED_POLLS_BEFORE_OFFLINE],
    ['', DEFAULT_FAILED_POLLS_BEFORE_OFFLINE],
    ['abc', DEFAULT_FAILED_POLLS_BEFORE_OFFLINE],
    [2.5, DEFAULT_FAILED_POLLS_BEFORE_OFFLINE],
    [1, 1],
    ['3', 3],
    [0, 1],
    [-4, 1],
    [50, 10],
  ])('%p -> %p', (setting, expected) => {
    expect(failedPollsBeforeOffline(setting)).toBe(expected);
  });
});

describe('shouldMarkOffline', () => {
  it('waits for the needed failures in a row on an online device', () => {
    expect(shouldMarkOffline('online', 1, 2)).toBe(false);
    expect(shouldMarkOffline('online', 2, 2)).toBe(true);
    expect(shouldMarkOffline('online', 5, 2)).toBe(true);
  });

  it('keeps the old behaviour at 1', () => {
    expect(shouldMarkOffline('online', 1, 1)).toBe(true);
  });

  it('gives no grace to a device that is not up', () => {
    expect(shouldMarkOffline('offline', 1, 3)).toBe(true);
    expect(shouldMarkOffline('unknown', 1, 3)).toBe(true);
    expect(shouldMarkOffline(undefined, 1, 3)).toBe(true);
  });
});

describe('isSiteOutage', () => {
  it('is most of a site failing together', () => {
    expect(isSiteOutage(17, 17)).toBe(true);
    expect(isSiteOutage(13, 17)).toBe(true);
    expect(isSiteOutage(3, 4)).toBe(true);
  });

  it('is not a few devices, or a small site', () => {
    expect(isSiteOutage(3, 17)).toBe(false);
    expect(isSiteOutage(2, 2)).toBe(false);
    expect(isSiteOutage(0, 0)).toBe(false);
  });
});

describe('siteOutageMessage', () => {
  it('names the site and the count', () => {
    expect(siteOutageMessage('HQ', 15, 17)).toMatch(/^Site HQ: 15 of 17 devices stopped answering within 2 minutes\./);
    expect(siteOutageMessage(null, 4, 4)).toMatch(/^Devices without a site: 4 of 4/);
  });
});

describe('recoveryKind (#442)', () => {
  it('announces a recovery the way the outage was announced', () => {
    expect(recoveryKind('device')).toBe('device');
    expect(recoveryKind('site')).toBe('site');
    expect(recoveryKind('deferred')).toBe('none');
    // Offline before this existed: recovers as it always did.
    expect(recoveryKind(null)).toBe('device');
    expect(recoveryKind(undefined)).toBe('device');
  });
});
