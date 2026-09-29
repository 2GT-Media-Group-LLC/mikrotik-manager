import { backfillProxyConnections } from '../ProxyLogService';

jest.mock('../../config/database', () => ({ query: jest.fn() }));

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
