import { summarise, isBlocked, cleanName, type QueryLogItem } from '../adguardLog';

const q = (o: Partial<QueryLogItem> & { name?: string }): QueryLogItem => ({
  time: '2026-11-16T10:15:00.000Z', client: '192.168.88.20', question: { name: o.name ?? 'www.youtube.com', type: 'A' },
  answer: [{ type: 'CNAME', value: 'youtube-ui.l.google.com.' }, { type: 'A', value: '142.250.74.110' }],
  reason: 'NotFilteredNotFound', ...o,
});

describe('AdGuard Home query log (#366 step 3)', () => {
  it('counts lookups per hour, client and name, allowed and blocked', () => {
    const r = summarise([
      q({}), q({ time: '2026-11-16T10:45:00Z' }),
      q({ name: 'ads.example.com', reason: 'FilteredBlackList', answer: [{ type: 'A', value: '0.0.0.0' }] }),
      q({ time: '2026-11-16T11:05:00Z' }),
    ], null);
    expect(r.counts).toEqual(expect.arrayContaining([
      { hour: '2026-11-16T10:00:00.000Z', clientIp: '192.168.88.20', name: 'www.youtube.com', allowed: 2, blocked: 0 },
      { hour: '2026-11-16T10:00:00.000Z', clientIp: '192.168.88.20', name: 'ads.example.com', allowed: 0, blocked: 1 },
      { hour: '2026-11-16T11:00:00.000Z', clientIp: '192.168.88.20', name: 'www.youtube.com', allowed: 1, blocked: 0 },
    ]));
    expect(r.newest).toBe(Date.parse('2026-11-16T11:05:00Z'));
    expect(r.used).toBe(4);
  });

  it('records which addresses a name answered with, not those of blocked lookups', () => {
    const r = summarise([q({}), q({ time: '2026-11-16T10:20:00Z' }), q({ name: 'ads.example.com', reason: 'FilteredBlackList', answer: [{ type: 'A', value: '0.0.0.0' }] })], null);
    expect(r.answers).toEqual([{ clientIp: '192.168.88.20', ip: '142.250.74.110', name: 'www.youtube.com',
      first: '2026-11-16T10:15:00.000Z', last: '2026-11-16T10:20:00.000Z', count: 2 }]);
  });

  it('skips what the last poll already counted, and malformed entries', () => {
    const r = summarise([
      q({ time: '2026-11-16T10:00:00Z' }), q({ time: '2026-11-16T10:30:00Z' }),
      q({ client: 'not-an-ip' }), q({ name: 'bad name!' }), q({ time: 'yesterday' }),
    ], Date.parse('2026-11-16T10:00:00Z'));
    expect(r.used).toBe(1);
  });

  it('reads AdGuard reasons and names', () => {
    expect(isBlocked('FilteredSafeBrowsing')).toBe(true);
    expect(isBlocked('NotFilteredWhiteList')).toBe(false);
    expect(isBlocked('Rewrite')).toBe(false);
    expect(cleanName('WWW.Example.COM.')).toBe('www.example.com');
    expect(cleanName('a b')).toBeNull();
  });
});

describe('DNS poll cursor', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.mock('../../../config/database', () => ({ query: jest.fn() }));
  it('keeps the milliseconds of a cursor pg returns as a Date', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cursorMs } = require('../DnsLogService') as typeof import('../DnsLogService');
    const d = new Date('2026-11-16T17:14:38.574Z');
    expect(cursorMs(d)).toBe(d.getTime());
    expect(cursorMs('2026-11-16T17:14:38.574Z')).toBe(d.getTime());
    expect(cursorMs(null)).toBeNull();
    // An AdGuard time in the same millisecond as the cursor is not newer.
    expect(summarise([q({ time: '2026-11-16T17:14:38.574949583Z' })], cursorMs(d)).used).toBe(0);
  });
});
