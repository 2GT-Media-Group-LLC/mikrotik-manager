jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
import eventsRoutes from '../events';
import { query } from '../../config/database';

const mockedQuery = jest.mocked(query);

function makeApp() {
  const app = express();
  app.use('/api/events', eventsRoutes);
  return app;
}

const row = { id: 1, message: 'hello', severity: 'info' };

describe('GET /api/events', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [{ count: '7' }] as never;
      return [row] as never;
    });
  });

  it('returns the rows with the totals by default', async () => {
    const res = await request(makeApp()).get('/api/events?limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [row], total: 7, criticalCount: 7 });
    expect(mockedQuery).toHaveBeenCalledTimes(3);
  });

  it('skips both counts with counts=0', async () => {
    const res = await request(makeApp()).get('/api/events?limit=5&counts=0');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [row] });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(String(mockedQuery.mock.calls[0][0])).not.toContain('COUNT(*)');
  });

  it('still applies the filters to the rows when counts=0', async () => {
    await request(makeApp()).get('/api/events?limit=5&counts=0&severity=error');
    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('e.severity IN');
    expect(params).toEqual(expect.arrayContaining(['error', 'critical', 5]));
  });

  it('only treats counts=0 as the opt-out', async () => {
    await request(makeApp()).get('/api/events?counts=1');
    expect(mockedQuery).toHaveBeenCalledTimes(3);
  });
});
