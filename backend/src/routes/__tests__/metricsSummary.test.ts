jest.mock('../../config/database');
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), bucket: 'test' }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
import metricsRoutes from '../metrics';
import { query } from '../../config/database';

const mockedQuery = jest.mocked(query);

describe('GET /api/metrics/summary', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("severity='error'")) return [{ critical: '3', warning: '1512' }] as never;
      if (sql.includes('FROM devices')) return [{ total: '4', online: '3', offline: '1', degraded: '0', intermittent_offline: '0' }] as never;
      if (sql.includes('FROM clients')) return [{ total: '10', active: '6' }] as never;
      return [{ total_outage_sec: '0' }] as never;
    });
  });

  it('restricts the 24h alert count to the severities it counts', async () => {
    const app = express();
    app.use('/api/metrics', metricsRoutes);
    const res = await request(app).get('/api/metrics/summary');
    expect(res.status).toBe(200);

    const sql = String(mockedQuery.mock.calls.map(([s]) => s).find((s) => String(s).includes("severity='error'")));
    // Without this the query reads every info event of the last 24 hours.
    expect(sql).toContain("WHERE severity IN ('error','warning')");
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(res.body.alerts).toEqual(expect.objectContaining({ critical: 3, warning: 1512 }));
  });
});
