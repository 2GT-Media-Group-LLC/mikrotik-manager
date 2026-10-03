import { backfillProxyConnections, backfillProxySources, collectProxySources, storeProxyConnections } from '../ProxyLogService';
import { query } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn() }));

const T = 'container,info,debug';
const line = (name: string, type: string, port: number, unix: number) =>
  `${name}: {"time_unix":${unix}, "proxy":{"type":"${type}", "port":${port}}, "error":{"code":"00000"}, "auth":{"user":"u"}, "client":{"ip":"10.0.0.1", "port":1}, "server":{"ip":"1.2.3.4", "port":443}, "bytes":{"sent":1, "received":2}, "request":{"hostname":"a.example"}, "message":"CONNECT a.example:443 HTTP/1.1"}`;

type Call = [string, unknown[]?];

/** Minimal PoolClient: `flag` is whether the app_settings row exists. */
function fakeClient(flag: boolean, eventRows: unknown[] = []) {
  const calls: Call[] = [];
  const client = {
    calls,
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push([text, params]);
      if (text.includes('FROM app_settings')) return { rowCount: flag ? 1 : 0, rows: [] };
      if (text.includes('FROM proxy_connections')) return { rowCount: 0, rows: [] };
      if (text.includes('FROM events')) return { rowCount: eventRows.length, rows: eventRows };
      return { rowCount: 1, rows: [] };
    }),
  };
  return client;
}

describe('backfillProxyConnections', () => {
  it('does nothing once the flag is set', async () => {
    const c = fakeClient(true);
    expect(await backfillProxyConnections(c as any)).toBe(0);
    expect(c.calls.some(([t]) => t.includes('FROM events'))).toBe(false);
  });

  it('records completion even when nothing was found', async () => {
    const c = fakeClient(false, []);
    expect(await backfillProxyConnections(c as any)).toBe(0);
    expect(c.calls.some(([t]) => t.includes('FROM events'))).toBe(true);
    const write = c.calls.find(([t]) => t.includes('INSERT INTO app_settings'));
    expect(write?.[1]).toEqual(['proxy_backfill_done', 'true']);
  });

  it('leaves the flag unset when the scan fails so it retries next boot', async () => {
    const c = fakeClient(false);
    c.query.mockImplementation(async (text: string) => {
      if (text.includes('FROM app_settings')) return { rowCount: 0, rows: [] };
      if (text.includes('FROM proxy_connections')) return { rowCount: 0, rows: [] };
      throw new Error('boom');
    });
    await expect(backfillProxyConnections(c as any)).rejects.toThrow('boom');
    expect(c.query.mock.calls.some(([t]) => String(t).includes('INSERT INTO app_settings'))).toBe(false);
  });
});

describe('collectProxySources', () => {
  const conn = (source: string, proxyType: string, proxyPort: number | null, ms: number) =>
    ({ c: { source, proxyType, proxyPort, eventTime: new Date(ms) } as any });

  it('keeps one entry per instance with its latest event time', () => {
    const out = collectProxySources([conn('3proxy', 'PROXY', 3128, 1000), conn('3proxy', 'PROXY', 3128, 5000), conn('3proxy', 'SOCKS', 1080, 2000)]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.proxyType === 'PROXY')!.lastSeen.getTime()).toBe(5000);
  });

  it('uses port 0 where a line carried none', () => {
    expect(collectProxySources([conn('squid', 'PROXY', null, 1)])[0].proxyPort).toBe(0);
  });
});

describe('storeProxyConnections', () => {
  const run = query as unknown as jest.Mock;
  beforeEach(() => { run.mockReset(); run.mockResolvedValue([]); });

  it('records the instances of a batch alongside the connections', async () => {
    const n = await storeProxyConnections(7, [
      { logId: '1', topics: T, message: line('3proxy-17', 'PROXY', 3128, 100) },
      { logId: '2', topics: T, message: line('3proxy-18', 'PROXY', 3128, 200) },
      { logId: '3', topics: T, message: line('3proxy-20', 'SOCKS', 1080, 150) },
    ]);
    expect(n).toBe(3);
    expect(run).toHaveBeenCalledTimes(2);
    const [sql, params] = run.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO proxy_sources');
    expect(sql).toContain('GREATEST(proxy_sources.last_seen, EXCLUDED.last_seen)');
    // device id, then 4 values for each of the two distinct instances
    expect(params).toHaveLength(1 + 2 * 4);
    expect(params[0]).toBe(7);
  });

  it('writes nothing when no line is a proxy log', async () => {
    expect(await storeProxyConnections(7, [{ logId: '1', topics: 'system,info', message: 'hello' }])).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('still succeeds when recording the instances fails', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    run.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('boom'));
    await expect(storeProxyConnections(7, [{ logId: '1', topics: T, message: line('3proxy-1', 'PROXY', 3128, 100) }])).resolves.toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('backfillProxySources', () => {
  it('does nothing once the list has rows', async () => {
    const c = { query: jest.fn(async () => ({ rowCount: 1, rows: [] })) };
    expect(await backfillProxySources(c as any)).toBe(0);
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it('builds the list from stored connections when it is empty', async () => {
    const c = {
      query: jest.fn(async (text: string) =>
        text.includes('SELECT 1 FROM proxy_sources') ? { rowCount: 0, rows: [] } : { rowCount: 3, rows: [] }),
    };
    expect(await backfillProxySources(c as any)).toBe(3);
    const insert = String(c.query.mock.calls[1][0]);
    expect(insert).toContain('FROM proxy_connections');
    expect(insert).toContain('COALESCE(proxy_port, 0)');
  });
});
