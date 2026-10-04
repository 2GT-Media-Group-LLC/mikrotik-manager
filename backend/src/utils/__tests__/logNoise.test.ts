import { isOwnApiSession, isOwnSshSession, stripOwnSessionNoise, managerAddressFromActive } from '../logNoise';

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

// Outside review S9: same account, someone else's address.
describe('own session by address', () => {
  const mine = new Set(['172.24.1.7']);

  it("drops the manager's own login from its address", () => {
    expect(isOwnApiSession(OWN_IN, 'admin', mine)).toBe(true);
  });

  it('keeps an API login with the same account from another address', () => {
    expect(isOwnApiSession(
      { topics: 'system,info,account', message: 'user admin logged in from 203.0.113.50 via api' }, 'admin', mine,
    )).toBe(false);
  });

  it('keeps everything while the manager address is unknown', () => {
    expect(isOwnApiSession(OWN_IN, 'admin', new Set())).toBe(false);
  });

  it('learns the address only when all the account\'s API sessions share it', () => {
    const row = (name: string, address: string, via = 'api') => ({ name, address, via });
    expect(managerAddressFromActive([row('admin', '172.24.1.7'), row('admin', '172.24.1.7'), row('rich', '10.0.0.5', 'winbox')], 'admin')).toBe('172.24.1.7');
    expect(managerAddressFromActive([row('admin', '172.24.1.7'), row('admin', '203.0.113.50')], 'admin')).toBeNull();
    expect(managerAddressFromActive([row('admin', '172.24.1.7', 'winbox')], 'admin')).toBeNull();
  });
});

describe('own SSH sessions (#238)', () => {
  const mgr = new Set(['192.168.0.76']);
  const fp = 'SHA256:AbCdEf0123456789xyz';
  const ssh = { username: 'admin', keyFingerprint: fp };
  const line = (message: string, topics = 'system,info,account') => ({ topics, message });

  it('drops the publickey line for the manager’s own key only', () => {
    expect(isOwnSshSession(line('publickey accepted for user: admin, fingerprint: SHA256:AbCdEf0123456789xyz'), ssh, mgr)).toBe(true);
    // RouterOS sometimes prints padding or a space after the prefix.
    expect(isOwnSshSession(line('publickey accepted for user: admin, fingerprint: SHA256: AbCdEf0123456789xyz='), ssh, mgr)).toBe(true);
    expect(isOwnSshSession(line('publickey accepted for user: admin, fingerprint: SHA256:SomebodyElsesKey'), ssh, mgr)).toBe(false);
    expect(isOwnSshSession(line('publickey accepted for user: tech, fingerprint: SHA256:AbCdEf0123456789xyz'), ssh, mgr)).toBe(false);
    expect(isOwnSshSession(line('publickey accepted for user: admin, fingerprint: SHA256:AbCdEf0123456789xyz'), { username: 'admin', keyFingerprint: null }, mgr)).toBe(false);
  });

  it('drops SSH logins only for the manager account from the manager address', () => {
    expect(isOwnSshSession(line('user admin logged in from 192.168.0.76 via ssh'), ssh, mgr)).toBe(true);
    expect(isOwnSshSession(line('user admin logged out from 192.168.0.76 via ssh'), ssh, mgr)).toBe(true);
    expect(isOwnSshSession(line('user admin logged in from 10.9.9.9 via ssh'), ssh, mgr)).toBe(false);
    expect(isOwnSshSession(line('user tech logged in from 192.168.0.76 via ssh'), ssh, mgr)).toBe(false);
    expect(isOwnSshSession(line('user admin logged in from 192.168.0.76 via winbox'), ssh, mgr)).toBe(false);
    expect(isOwnSshSession(line('login failure for user admin from 192.168.0.76 via ssh', 'system,error,critical'), ssh, mgr)).toBe(false);
  });

  it('keeps SSH logins while the manager address is unknown', () => {
    expect(isOwnSshSession(line('user admin logged in from 192.168.0.76 via ssh'), ssh, new Set())).toBe(false);
    expect(isOwnSshSession(line('user admin logged in from 192.168.0.76 via ssh'), ssh, undefined)).toBe(false);
  });

  it('strips both kinds in one pass', () => {
    const { kept, dropped } = stripOwnSessionNoise([
      line('user admin logged in from 192.168.0.76 via api'),
      line('user admin logged in from 192.168.0.76 via ssh'),
      line('publickey accepted for user: admin, fingerprint: SHA256:AbCdEf0123456789xyz'),
      line('user admin logged in from 10.1.1.1 via ssh'),
    ], 'admin', mgr, ssh);
    expect(dropped).toBe(3);
    expect(kept.map((l) => l.message)).toEqual(['user admin logged in from 10.1.1.1 via ssh']);
  });
});
