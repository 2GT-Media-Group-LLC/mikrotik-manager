import { isOwnApiSession, stripOwnSessionNoise } from '../logNoise';

/**
 * Messages are verbatim from the events table of the reference fleet, where
 * they accounted for 99.8% of all stored events.
 */
const OWN_IN  = { topics: 'system,info,account', message: 'user admin logged in from 172.24.1.7 via api' };
const OWN_OUT = { topics: 'system,info,account', message: 'user admin logged out from 192.168.0.76 via api' };

describe('isOwnApiSession', () => {
  it('matches our own login and logout', () => {
    expect(isOwnApiSession(OWN_IN, 'admin')).toBe(true);
    expect(isOwnApiSession(OWN_OUT, 'admin')).toBe(true);
  });

  it('keeps a human logging in over winbox — that is security-relevant', () => {
    expect(isOwnApiSession(
      { topics: 'system,info,account', message: 'user admin logged in from 10.0.0.5 via winbox' },
      'admin'
    )).toBe(false);
  });

  it('keeps ssh, telnet and web sessions', () => {
    for (const via of ['ssh', 'telnet', 'web']) {
      expect(isOwnApiSession(
        { topics: 'system,info,account', message: `user admin logged in from 10.0.0.5 via ${via}` },
        'admin'
      )).toBe(false);
    }
  });

  it('keeps an API login by a different account', () => {
    // Somebody else's automation is not our noise.
    expect(isOwnApiSession(
      { topics: 'system,info,account', message: 'user ansible logged in from 10.0.0.9 via api' },
      'admin'
    )).toBe(false);
  });

  it('is case-sensitive about the username, as RouterOS is', () => {
    expect(isOwnApiSession(
      { topics: 'system,info,account', message: 'user Admin logged in from 10.0.0.5 via api' },
      'admin'
    )).toBe(false);
  });

  it('keeps a failed login attempt, which is not a session of ours', () => {
    expect(isOwnApiSession(
      { topics: 'system,error,critical', message: 'login failure for user admin from 10.0.0.5 via api' },
      'admin'
    )).toBe(false);
  });

  it('ignores lines outside the account topic', () => {
    expect(isOwnApiSession(
      { topics: 'interface,info', message: 'user admin logged in from 1.2.3.4 via api' },
      'admin'
    )).toBe(false);
  });

  it('does nothing when no username is configured', () => {
    expect(isOwnApiSession(OWN_IN, '')).toBe(false);
    expect(isOwnApiSession(OWN_IN, null)).toBe(false);
  });
});

describe('stripOwnSessionNoise', () => {
  it('drops our sessions, keeps the rest, and reports the count', () => {
    const lines = [
      OWN_IN,
      { topics: 'wireless,info', message: 'client connected' },
      OWN_OUT,
      { topics: 'system,error,critical', message: 'out of memory' },
    ];
    const { kept, dropped } = stripOwnSessionNoise(lines, 'admin');
    expect(dropped).toBe(2);
    expect(kept.map((l) => l.message)).toEqual(['client connected', 'out of memory']);
  });

  it('preserves order', () => {
    const lines = [
      { topics: 'a', message: 'one' }, OWN_IN, { topics: 'b', message: 'two' },
    ];
    expect(stripOwnSessionNoise(lines, 'admin').kept.map((l) => l.message)).toEqual(['one', 'two']);
  });

  it('keeps everything when the filter cannot identify us', () => {
    const lines = [OWN_IN, OWN_OUT];
    expect(stripOwnSessionNoise(lines, undefined).dropped).toBe(0);
  });
});
