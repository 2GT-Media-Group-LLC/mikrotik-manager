jest.mock('../../config/database', () => ({
  pool: { connect: jest.fn() },
}));

import { pool } from '../../config/database';
import { buildEventIndexes } from '../eventIndexes';

type QueryResult = { rows: Array<Record<string, unknown>> };

/**
 * A fake pooled client that answers the three catalog/lock probes and records
 * the DDL. `validity` is consumed once per index, in build order.
 */
function fakeClient(options: {
  locked?: boolean;
  validity?: Array<boolean | null>;
} = {}) {
  const validity = [...(options.validity ?? [null, null, null, null])];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      calls.push({ sql, params });

      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: options.locked ?? true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (sql.includes('indisvalid')) {
        const valid = validity.shift();
        return { rows: valid == null ? [] : [{ valid }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };

  jest.mocked(pool.connect).mockResolvedValue(client as never);
  return { client, calls };
}

const createStatements = (calls: Array<{ sql: string }>) =>
  calls.map((c) => c.sql).filter((sql) => sql.includes('CREATE INDEX'));

describe('buildEventIndexes', () => {
  beforeEach(() => {
    jest.mocked(pool.connect).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds all four indexes concurrently, one statement per query', async () => {
    const { client, calls } = fakeClient();

    await buildEventIndexes();

    const creates = createStatements(calls);
    expect(creates).toHaveLength(4);
    for (const sql of creates) {
      expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
      // CONCURRENTLY cannot run in a transaction or a multi-statement query.
      expect(sql).not.toContain(';');
    }
    expect(creates.map((sql) => sql.match(/idx_events_\w+/)?.[0])).toEqual([
      'idx_events_nonfw_time',
      'idx_events_nonfw_all_time',
      'idx_events_fw_time',
      'idx_events_nonfw_critical_time',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('skips indexes that are already valid', async () => {
    const { calls } = fakeClient({ validity: [true, true, true, true] });

    await buildEventIndexes();

    expect(createStatements(calls)).toHaveLength(0);
  });

  it('drops an invalid index from an interrupted build before recreating it', async () => {
    const { calls } = fakeClient({ validity: [false, true, true, true] });

    await buildEventIndexes();

    const ddl = calls.map((c) => c.sql);
    const drop = ddl.findIndex((sql) => sql.includes('DROP INDEX CONCURRENTLY IF EXISTS idx_events_nonfw_time'));
    const create = ddl.findIndex((sql) => sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_nonfw_time'));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
    expect(createStatements(calls)).toHaveLength(1);
  });

  it('does not build when another instance holds the advisory lock', async () => {
    const { client, calls } = fakeClient({ locked: false });

    await buildEventIndexes();

    expect(createStatements(calls)).toHaveLength(0);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('keeps building the other indexes when one fails', async () => {
    const { client } = fakeClient();
    const original = client.query.getMockImplementation()!;
    let failed = false;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!failed && sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_nonfw_time')) {
        failed = true;
        throw new Error('lock timeout');
      }
      return original(sql, params);
    });

    await buildEventIndexes();

    const creates = client.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('CREATE INDEX'));
    expect(creates.some((sql) => sql.includes('idx_events_fw_time'))).toBe(true);
    expect(creates.some((sql) => sql.includes('idx_events_nonfw_critical_time'))).toBe(true);
  });
});
