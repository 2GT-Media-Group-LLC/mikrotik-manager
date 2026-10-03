jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/ProxyUsageService', () => ({
  ...jest.requireActual('../../services/ProxyUsageService'),
  useProxyUsageRollup: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import proxyRoutes from '../proxy';
import { query } from '../../config/database';
import { useProxyUsageRollup } from '../../services/ProxyUsageService';

const mockedQuery = jest.mocked(query);
const mockedUse = jest.mocked(useProxyUsageRollup);

const makeApp = () => {
  const app = express();
  app.use('/api/proxy', proxyRoutes);
  return app;
};
const lastSql = () => String(mockedQuery.mock.calls[mockedQuery.mock.calls.length - 1][0]);
const lastParams = () => mockedQuery.mock.calls[mockedQuery.mock.calls.length - 1][1] as unknown[];

describe('GET /api/proxy/top', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedUse.mockReset();
    mockedQuery.mockResolvedValue([
      { key: '10.1.0.1', requests: '12', bytes_out: '5', bytes_in: '7', distinct_peers: 3, last_seen: '2026-10-03T00:00:00Z' },
    ] as never);
  });

  it('reads the hourly rollup for 24h once it is ready', async () => {
    mockedUse.mockResolvedValue(true);
    const res = await request(makeApp()).get('/api/proxy/top?by=user&range=24h&limit=5');
    expect(res.status).toBe(200);
    expect(lastSql()).toContain('FROM proxy_usage_hourly');
    expect(lastParams()).toEqual([2, '24 hours', 5]);
    // bigint sums come back as strings from pg and are returned as numbers.
    expect(res.body).toEqual([{ key: '10.1.0.1', requests: 12, bytes_in: 7, bytes_out: 5, distinct_peers: 3, last_seen: '2026-10-03T00:00:00Z' }]);
  });

  it('keeps 1h on the raw rows so it is exact to the minute', async () => {
    mockedUse.mockResolvedValue(true);
    await request(makeApp()).get('/api/proxy/top?by=client&range=1h');
    expect(lastSql()).toContain('FROM proxy_connections');
    expect(mockedUse).not.toHaveBeenCalled();
  });

  it('reads the raw rows while the rollup is not ready or is switched off', async () => {
    mockedUse.mockResolvedValue(false);
    await request(makeApp()).get('/api/proxy/top?by=client&range=7d');
    expect(lastSql()).toContain('FROM proxy_connections');
  });

  it('applies the instance and device filters to the rollup', async () => {
    mockedUse.mockResolvedValue(true);
    await request(makeApp()).get('/api/proxy/top?by=destination&range=30d&source=3proxy&port=3128&deviceId=4&limit=10');
    expect(lastSql()).toContain('source = $3');
    expect(lastSql()).toContain('proxy_port = $4');
    expect(lastSql()).toContain('device_id = $5');
    expect(lastParams()).toEqual([3, '30 days', '3proxy', 3128, 4, 10]);
  });

  it('still rejects an unknown tab or range', async () => {
    expect((await request(makeApp()).get('/api/proxy/top?by=nope')).status).toBe(400);
    expect((await request(makeApp()).get('/api/proxy/top?range=9y')).status).toBe(400);
  });
});
