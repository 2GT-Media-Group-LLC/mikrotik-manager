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
      // The server's own lookups, not a client's.
      q({ time: '2026-11-16T10:31:00Z', client: '127.0.0.1' }), q({ time: '2026-11-16T10:31:00Z', client: '::1' }),
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

describe('Pi-hole query log (#366)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fromPihole } = require('../piholeLog') as typeof import('../piholeLog');
  it('counts Pi-hole lookups, with its block statuses, and no answers', () => {
    const items = fromPihole([
      { time: 1794855573.430748, domain: 'www.youtube.com', type: 'AAAA', status: 'FORWARDED', client: { ip: '172.18.0.7' } },
      { time: 1794855573.4779859, domain: 'ads.mtm-test.example', type: 'A', status: 'DENYLIST', client: { ip: '172.18.0.7' } },
      { time: 1794855574, domain: 'cdn.example', type: 'A', status: 'GRAVITY_CNAME', client: { ip: '172.18.0.7' } },
      { time: 1794855575, domain: 'x.example', type: 'A', status: 'CACHE', client: { ip: '172.18.0.7' } },
    ]);
    const r = summarise(items, null);
    expect(r.used).toBe(4);
    expect(r.answers).toEqual([]);
    const byName = Object.fromEntries(r.counts.map((c) => [c.name, [c.allowed, c.blocked]]));
    expect(byName).toEqual({ 'www.youtube.com': [1, 0], 'ads.mtm-test.example': [0, 1], 'cdn.example': [0, 1], 'x.example': [1, 0] });
  });
});
