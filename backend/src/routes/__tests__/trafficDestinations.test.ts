jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/site', () => ({ activeSite: () => null }));
jest.mock('../../services/netflow/NetflowCollector', () => ({ netflowCollector: { getStats: () => ({}) } }));
jest.mock('../../config/influxdb', () => ({ bucket: 'metrics', getQueryApi: () => ({}) }));
jest.mock('../../utils/reverseNames', () => ({ reverseNames: async () => new Map() }));
jest.mock('../../utils/addressNames', () => ({ namesForAddresses: async () => new Map() }));

import request from 'supertest';
import express from 'express';
import trafficRoutes from '../trafficAnalytics';
import { query } from '../../config/database';

const app = express();
app.use('/api/traffic', trafficRoutes);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The destinations route against a table whose first row is `first`, with `retention` days kept. */
function table(first: Date | null, retention = 7) {
  jest.mocked(query).mockImplementation((async (sql: string) => {
    if (sql.includes('MIN(hour)')) return [{ first }];
    if (sql.includes('retention_destinations_days')) return [{ value: retention }];
    if (sql.includes('GROUP BY remote')) return [];
    return [{ total: '0', other: null }];
  }) as never);
}

describe('GET /api/traffic/destinations recorded_since (#366)', () => {
  it('says when recording began inside the range', async () => {
    const began = new Date(Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR);
    table(began);
    const res = await request(app).get('/api/traffic/destinations?range=24h');
    expect(res.status).toBe(200);
    expect(res.body.recorded_since).toBe(began.toISOString());
  });

  it('says nothing when recording began before the range', async () => {
    table(new Date(Date.now() - 3 * DAY));
    expect((await request(app).get('/api/traffic/destinations?range=24h')).body.recorded_since).toBeNull();
  });

  it('says nothing when retention, not a late start, is why the first hours are gone', async () => {
    // Recording began weeks ago; pruning to 7 days left the cutoff as the first hour.
    table(new Date(Date.now() - 7 * DAY + 30 * 60_000));
    expect((await request(app).get('/api/traffic/destinations?range=30d')).body.recorded_since).toBeNull();
  });

  it('still says so on a long range when recording began after the retention cutoff', async () => {
    const began = new Date(Date.now() - 2 * DAY);
    table(began);
    expect((await request(app).get('/api/traffic/destinations?range=30d')).body.recorded_since).toBe(began.toISOString());
  });

  it('says nothing when nothing is recorded', async () => {
    table(null);
    expect((await request(app).get('/api/traffic/destinations?range=24h')).body.recorded_since).toBeNull();
  });
});

describe('Traffic windows picked on the chart (#463)', () => {
  const calls = () => jest.mocked(query).mock.calls as unknown as [string, unknown[]][];
  beforeEach(() => jest.mocked(query).mockClear());

  it('counts the hours a picked window touches', async () => {
    table(new Date(Date.now() - 3 * DAY));
    const from = new Date(Date.now() - 5 * HOUR - 15 * 60_000).toISOString();
    const to = new Date(Date.now() - 4 * HOUR).toISOString();
    const res = await request(app).get(`/api/traffic/destinations?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const [sql, params] = calls().find(([s]) => s.includes('GROUP BY remote'))!;
    expect(sql).toContain("hour >= date_trunc('hour', $1::timestamptz)");
    expect(sql).toContain('hour < $2::timestamptz');
    expect((params[0] as Date).toISOString()).toBe(from);
    expect((params[1] as Date).toISOString()).toBe(to);
  });

  it('keeps a preset range counted back from now', async () => {
    table(new Date(Date.now() - 3 * DAY));
    await request(app).get('/api/traffic/destinations?range=24h');
    const [sql, params] = calls().find(([s]) => s.includes('GROUP BY remote'))!;
    expect(sql).toContain('make_interval(hours => $1::int)');
    expect(params[0]).toBe(24);
  });

  it('bounds the DNS names by the picked window', async () => {
    jest.mocked(query).mockImplementation((async () => [{ n: 0, allowed: 0, blocked: 0 }]) as never);
    const from = new Date(Date.now() - 3 * HOUR).toISOString();
    const to = new Date(Date.now() - 2 * HOUR).toISOString();
    expect((await request(app).get(`/api/traffic/dns?from=${from}&to=${to}`)).status).toBe(200);
    const [sql] = calls().find(([s]) => s.includes('FROM dns_name_counts'))!;
    expect(sql).toContain('hour >= $1 AND hour < $2');
  });

  it('refuses a window that is not one', async () => {
    const now = Date.now();
    for (const q of [
      `from=${new Date(now - HOUR).toISOString()}&to=${new Date(now - 2 * HOUR).toISOString()}`,
      `from=${new Date(now - 40 * DAY).toISOString()}&to=${new Date(now).toISOString()}`,
      `from=yesterday&to=${new Date(now).toISOString()}`,
      `from=${new Date(now - HOUR).toISOString()}`,
    ]) {
      const res = await request(app).get(`/api/traffic/destinations?${q}`);
      expect(res.status).toBe(400);
    }
  });
});
