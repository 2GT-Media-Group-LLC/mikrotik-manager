jest.mock('../../config/database');
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), bucket: 'test' }));
jest.mock('../../services/PollerService', () => ({ PollerService: class {} }));
jest.mock('../../services/mikrotik/DeviceCollector', () => ({ DeviceCollector: class {} }));
jest.mock('../../middleware/auth', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { requireAuth: pass, requireAdmin: pass, requireWrite: pass };
});

import request from 'supertest';
import express from 'express';
import clientsRoutes from '../clients';
import { query } from '../../config/database';

const mockedQuery = jest.mocked(query);

describe('GET /api/clients', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (sql: string) =>
      (/SELECT COUNT\(\*\) as total/.test(sql) ? [{ total: '42' }] : []) as never);
  });
  const app = express();
  app.use('/api/clients', clientsRoutes);

  // The page of rows and the VLAN choices, by their SQL rather than by how many
  // queries the route makes in all, which other changes to the route can alter.
  const ran = (re: RegExp) => mockedQuery.mock.calls.some(([sql]) => re.test(String(sql)));
  const ROWS = /LIMIT \$\d+ OFFSET \$\d+/;
  const VLANS = /SELECT DISTINCT deduped\.vlan_id/;

  it('answers limit=0 with the total, without the page or the VLAN choices', async () => {
    const res = await request(app).get('/api/clients?active=true&client_type=wireless&limit=0');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clients: [], total: 42, vlans: [] });
    expect(ran(ROWS)).toBe(false);
    expect(ran(VLANS)).toBe(false);
  });

  it('still reads the page, the total and the VLAN choices otherwise', async () => {
    const res = await request(app).get('/api/clients?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(42);
    expect(ran(ROWS)).toBe(true);
    expect(ran(VLANS)).toBe(true);
  });
});
