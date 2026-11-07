jest.mock('../../config/database');
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/site', () => ({ activeSite: () => null }));
jest.mock('../../services/netflow/NetflowCollector', () => ({ netflowCollector: { getStats: () => ({}) } }));
const rows: Record<string, string | number>[] = [];
const flux: string[] = [];
jest.mock('../../config/influxdb', () => ({
  bucket: 'metrics',
  getQueryApi: () => ({
    collectRows: async (q: string, cb: (row: Record<string, unknown>, meta: { get: (r: Record<string, unknown>, k: string) => unknown }) => void) => {
      flux.push(q);
      for (const r of rows) cb(r, { get: (x, k) => x[k] });
      return [];
    },
  }),
}));

import request from 'supertest';
import express from 'express';
import trafficRoutes from '../trafficAnalytics';
import { query } from '../../config/database';

const app = express();
app.use('/api/traffic', trafficRoutes);

describe('GET /api/traffic/apps/:app/clients (#366)', () => {
  beforeEach(() => {
    rows.length = 0; flux.length = 0;
    jest.mocked(query).mockResolvedValue([{ mac_address: 'AA:BB:CC:00:00:01', hostname: 'laptop', custom_name: null, vendor: null, ip_address: '192.168.1.10' }] as never);
  });

  it('ranks the clients of one application with their share', async () => {
    rows.push(
      { mac: 'aa:bb:cc:00:00:01', direction: 'download', _value: 600 },
      { mac: 'aa:bb:cc:00:00:01', direction: 'upload', _value: 150 },
      { mac: 'aa:bb:cc:00:00:02', direction: 'download', _value: 250 },
    );
    const res = await request(app).get('/api/traffic/apps/HTTP/clients?range=24h');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ app: 'HTTP', total_bytes: 1000, client_count: 2 });
    expect(res.body.clients[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:01', download_bytes: 600, upload_bytes: 150, share: 0.75, hostname: 'laptop', ip_address: '192.168.1.10' });
    expect(res.body.clients[1]).toMatchObject({ mac: 'aa:bb:cc:00:00:02', share: 0.25, hostname: null });
    expect(flux[0]).toContain('r.app == "HTTP"');
  });

  it('quotes the name for Flux and refuses what no classifier produces', async () => {
    await request(app).get(`/api/traffic/apps/${encodeURIComponent('a"b')}/clients`);
    expect(flux[0]).toContain('r.app == "a\\"b"');
    expect((await request(app).get(`/api/traffic/apps/${encodeURIComponent('x\n|> drop()')}/clients`)).status).toBe(400);
  });
});
