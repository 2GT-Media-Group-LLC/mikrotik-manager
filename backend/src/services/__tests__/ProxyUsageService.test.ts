import {
  reconcileProxyUsage, aggregateSql, usageUpsertCtes, rebuildProxyUsage, backfillProxyUsage, useProxyUsageRollup,
  resetProxyUsageSettingsCache, useProxySourcesTable, USAGE_KIND,
} from '../ProxyUsageService';
import { query, pool } from '../../config/database';

jest.mock('../../config/database', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const mockedQuery = query as unknown as jest.Mock;

type Call = [string, unknown[]?];
function fakeClient(handler: (text: string) => { rowCount?: number; rows?: unknown[] } | Error | void = () => undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push([text, params]);
      const r = handler(text);
      if (r instanceof Error) throw r;
      return { rowCount: r?.rowCount ?? 0, rows: r?.rows ?? [] };
    }),
  };
}

describe('aggregateSql', () => {
  it('uses the same tab definitions as the raw ranking', () => {
    expect(aggregateSql('client', 'proxy_connections')).toContain("WHERE status = 'ok'");
    expect(aggregateSql('user', 'proxy_connections')).toContain('auth_user IS NOT NULL');
    expect(aggregateSql('destination', 'proxy_connections')).toContain('COALESCE(hostname, server_ip)');
    expect(aggregateSql('denied', 'proxy_connections')).toContain("status <> 'ok' AND auth_user IS NULL");
  });

  it('buckets by the UTC hour and stores missing ports and peers as 0 and empty', () => {
    const sql = aggregateSql('client', 'proxy_connections');
    expect(sql).toContain("date_trunc('hour', event_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
    expect(sql).toContain('COALESCE(proxy_port, 0)');
    expect(sql).toContain("COALESCE((COALESCE(hostname, server_ip))::text, '')");
  });

  it('orders rows so concurrent writers lock them in the same order', () => {
    expect(aggregateSql('client', 'x')).toContain('ORDER BY 2, 3, 4, 5, 6, 7');
  });
});

describe('usageUpsertCtes', () => {
  it('adds one additive upsert per tab, reading the inserted rows', () => {
    const sql = usageUpsertCtes('inserted');
    for (const by of Object.keys(USAGE_KIND)) expect(sql).toContain(`rollup_${by} AS (INSERT INTO proxy_usage_hourly`);
    expect(sql.match(/FROM inserted/g)).toHaveLength(4);
    expect(sql.match(/proxy_usage_hourly\.requests \+ EXCLUDED\.requests/g)).toHaveLength(4);
  });
});

describe('rebuildProxyUsage', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-10-02T00:00:00Z');

  it('replaces the range in one repeatable-read transaction', async () => {
    const c = fakeClient();
    await rebuildProxyUsage(c as any, from, to);
    const texts = c.calls.map(([t]) => t);
    expect(texts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(texts[1]).toContain('DELETE FROM proxy_usage_hourly');
    expect(texts.filter((t) => t.startsWith('INSERT INTO proxy_usage_hourly'))).toHaveLength(4);
    expect(texts[texts.length - 1]).toBe('COMMIT');
    expect(c.calls[1][1]).toEqual([from.toISOString(), to.toISOString()]);
  });

  it('rolls back and rethrows when a step fails', async () => {
    const c = fakeClient((t) => (t.startsWith('INSERT INTO proxy_usage_hourly') ? new Error('serialization failure') : undefined));
    await expect(rebuildProxyUsage(c as any, from, to)).rejects.toThrow('serialization failure');
    expect(c.calls[c.calls.length - 1][0]).toBe('ROLLBACK');
    expect(c.calls.some(([t]) => t === 'COMMIT')).toBe(false);
  });
});

describe('backfillProxyUsage', () => {
  it('does nothing once marked ready', async () => {
    const c = fakeClient((t) => (t.includes('FROM app_settings') ? { rowCount: 1 } : undefined));
    expect(await backfillProxyUsage(c as any)).toBe(0);
    expect(c.calls).toHaveLength(1);
  });

  it('marks an empty install ready without rebuilding anything', async () => {
    const c = fakeClient((t) => (t.includes('MIN(event_time)') ? { rows: [{ lo: null }] } : undefined));
    expect(await backfillProxyUsage(c as any)).toBe(0);
    expect(c.calls.some(([t]) => t.includes('INSERT INTO app_settings'))).toBe(true);
    expect(c.calls.some(([t]) => t.startsWith('BEGIN'))).toBe(false);
  });

  it('rebuilds day by day and only then marks it ready', async () => {
    const lo = new Date(Date.now() - 2.5 * 86_400_000);
    const c = fakeClient((t) => (t.includes('MIN(event_time)') ? { rows: [{ lo }] } : undefined));
    const chunks = await backfillProxyUsage(c as any);
    expect(chunks).toBeGreaterThanOrEqual(3);
    const texts = c.calls.map(([t]) => t);
    expect(texts.filter((t) => t.startsWith('BEGIN'))).toHaveLength(chunks);
    expect(texts[texts.length - 1]).toContain('INSERT INTO app_settings');
  });

  it('does the busy current hour as its own last chunk', async () => {
    const lo = new Date(Date.now() - 2 * 86_400_000);
    const c = fakeClient((t) => (t.includes('MIN(event_time)') ? { rows: [{ lo }] } : undefined));
    await backfillProxyUsage(c as any);
    const ranges = c.calls.filter(([t]) => t.startsWith('DELETE FROM proxy_usage_hourly')).map(([, p]) => p as string[]);
    const last = ranges[ranges.length - 1];
    expect(new Date(last[1]).getTime() - new Date(last[0]).getTime()).toBe(3_600_000);
    // earlier chunks end where the final hour begins
    expect(ranges[ranges.length - 2][1]).toBe(last[0]);
  });

  it('retries a chunk that collided with live traffic instead of starting over', async () => {
    const lo = new Date(Date.now() - 3_600_000);
    let failed = false;
    const c = fakeClient((t) => {
      if (t.includes('MIN(event_time)')) return { rows: [{ lo }] };
      if (t.startsWith('DELETE FROM proxy_usage_hourly') && !failed) { failed = true; return new Error('could not serialize access'); }
    });
    await expect(backfillProxyUsage(c as any)).resolves.toBeGreaterThan(0);
    expect(c.calls.some(([t]) => t.includes('INSERT INTO app_settings'))).toBe(true);
  });

  it('leaves it unmarked when a chunk fails, so the next boot retries', async () => {
    const lo = new Date(Date.now() - 86_400_000);
    const c = fakeClient((t) => {
      if (t.includes('MIN(event_time)')) return { rows: [{ lo }] };
      if (t.startsWith('DELETE FROM proxy_usage_hourly')) return new Error('boom');
    });
    await expect(backfillProxyUsage(c as any)).rejects.toThrow('boom');
    expect(c.calls.some(([t]) => t.includes('INSERT INTO app_settings'))).toBe(false);
  });
});

describe('useProxyUsageRollup', () => {
  beforeEach(() => { resetProxyUsageSettingsCache(); mockedQuery.mockReset(); });

  it('is off until the backfill has marked the rollup ready', async () => {
    mockedQuery.mockResolvedValue([]);
    expect(await useProxyUsageRollup()).toBe(false);
  });

  it('is on once ready', async () => {
    mockedQuery.mockResolvedValue([{ key: 'proxy_usage_ready', value: true }]);
    expect(await useProxyUsageRollup()).toBe(true);
  });

  it('can be switched off without a deploy', async () => {
    mockedQuery.mockResolvedValue([{ key: 'proxy_usage_ready', value: true }, { key: 'proxy_usage_rollup', value: false }]);
    expect(await useProxyUsageRollup()).toBe(false);
  });

  it('tells the sources list apart from the rollup', async () => {
    mockedQuery.mockResolvedValue([{ key: 'proxy_sources_ready', value: true }]);
    expect(await useProxySourcesTable()).toBe(true);
    expect(await useProxyUsageRollup()).toBe(false);
  });

  it('caches the answer briefly', async () => {
    mockedQuery.mockResolvedValue([{ key: 'proxy_usage_ready', value: true }]);
    await useProxyUsageRollup();
    await useProxyUsageRollup();
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileProxyUsage', () => {
  const connect = pool.connect as unknown as jest.Mock;
  const ready = () => mockedQuery.mockResolvedValue([{ key: 'proxy_usage_ready', value: true }]);
  beforeEach(() => { resetProxyUsageSettingsCache(); mockedQuery.mockReset(); connect.mockReset(); });

  it('does nothing before the rollup is ready', async () => {
    mockedQuery.mockResolvedValue([]);
    await reconcileProxyUsage(12);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rebuilds the window in 6-hour chunks', async () => {
    ready();
    const c = fakeClient();
    connect.mockResolvedValue({ ...c, release: jest.fn() });
    await reconcileProxyUsage(18);
    expect(c.calls.filter(([t]) => t.startsWith('BEGIN'))).toHaveLength(3);
  });

  it('retries a chunk that was aborted and carries on', async () => {
    ready();
    let first = true;
    const c = fakeClient((t) => {
      if (t.startsWith('DELETE FROM proxy_usage_hourly') && first) { first = false; return new Error('could not serialize access'); }
    });
    connect.mockResolvedValue({ ...c, release: jest.fn() });
    await expect(reconcileProxyUsage(12)).resolves.toBeUndefined();
    // 2 chunks, one of them attempted twice.
    expect(c.calls.filter(([t]) => t.startsWith('BEGIN'))).toHaveLength(3);
  });

  it('reports the chunks it could not repair', async () => {
    ready();
    const c = fakeClient((t) => (t.startsWith('DELETE FROM proxy_usage_hourly') ? new Error('could not serialize access') : undefined));
    const release = jest.fn();
    connect.mockResolvedValue({ ...c, release });
    await expect(reconcileProxyUsage(6)).rejects.toThrow(/gave up on 1 chunk/);
    expect(release).toHaveBeenCalled();
  });
});
