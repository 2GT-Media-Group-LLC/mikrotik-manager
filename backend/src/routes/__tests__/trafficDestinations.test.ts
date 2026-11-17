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
