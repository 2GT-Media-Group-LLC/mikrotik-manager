/**
 * Who sees and changes the fleet's settings: admins change them, fleet
 * operators read them, viewers and site-limited accounts see only what their
 * own pages need.
 */
let currentUser: Record<string, unknown> = {};
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = JSON.parse(JSON.stringify(currentUser));
      next();
    },
  };
});
jest.mock('../../config/database');
jest.mock('../../config/redis', () => {
  const stub = (): unknown => new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'status' ? 'ready'
      : () => Promise.resolve(prop === 'set' ? 'OK' : null)),
  });
  return { redis: stub(), limiterRedis: () => stub(), createRedisConnection: () => stub() };
});
jest.mock('../../config/influxdb', () => ({ getQueryApi: jest.fn(), getWriteApi: jest.fn(), bucket: 'test' }));

import request from 'supertest';
import express from 'express';
import { query, queryOne } from '../../config/database';

const admin = { userId: 1, username: 'a', role: 'admin' };
const operator = { userId: 2, username: 'o', role: 'operator' };
const viewer = { userId: 3, username: 'v', role: 'viewer' };
const siteOperator = { userId: 4, username: 's', role: 'operator', siteRoles: { 3: 'operator' } };

let app: express.Express;
beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  app = express();
  app.use(express.json());
  app.use('/api/settings', require('../settings').default);
  app.use('/api/alerts', require('../alerts').default);
  app.use('/api/automation', require('../automation').default);
  app.use('/api/audit-log', require('../auditLog').default);
  app.use('/api/dns-sources', require('../dnsSources').default);
});

beforeEach(() => {
  jest.mocked(query).mockReset();
  jest.mocked(queryOne).mockReset();
  jest.mocked(query).mockImplementation((async (sql: string) => {
    if (/FROM app_settings/.test(sql)) {
      return [
        { key: 'maps_enabled', value: true },
        { key: 'netflow_collector_address', value: '192.0.2.10' },
        { key: 'backup_schedule_enabled', value: true },
        { key: 'change_guard_mode', value: 'auto' },
      ];
    }
    if (/COUNT\(\*\)/i.test(sql)) return [{ total: 0, count: 0 }];
    return [];
  }) as never);
  jest.mocked(queryOne).mockResolvedValue({ total: 0, count: 0 } as never);
});

const as = (user: Record<string, unknown>) => { currentUser = user; return request(app); };

describe('GET /api/settings', () => {
  it('gives fleet admins and operators every setting', async () => {
    for (const u of [admin, operator]) {
      const res = await as(u).get('/api/settings');
      expect(Object.keys(res.body).sort()).toEqual(['backup_schedule_enabled', 'change_guard_mode', 'maps_enabled', 'netflow_collector_address']);
    }
  });

  it('gives viewers and site-limited accounts only what their pages need', async () => {
    for (const u of [viewer, siteOperator]) {
      const res = await as(u).get('/api/settings');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['maps_enabled', 'netflow_collector_address']);
    }
  });
});

describe('a fleet operator reads settings but changes none', () => {
  it.each([
    '/api/settings/users', '/api/settings/encryption', '/api/alerts/rules', '/api/alerts/channels',
    '/api/automation/tokens', '/api/automation/webhooks', '/api/automation/reports', '/api/audit-log', '/api/dns-sources',
  ])('reads %s', async (path) => {
    const res = await as(operator).get(path);
    expect(res.status).not.toBe(403);
  });

  it('is refused every change', async () => {
    const calls = [
      as(operator).put('/api/settings').send({ maps_enabled: false }),
      as(operator).put('/api/alerts/rules/device_offline').send({ enabled: false }),
      as(operator).post('/api/alerts/channels').send({ name: 'x', type: 'slack', config: {} }),
      as(operator).put('/api/alerts/channels/1').send({ name: 'x' }),
      as(operator).delete('/api/alerts/channels/1'),
      as(operator).post('/api/alerts/channels/1/test'),
      as(operator).post('/api/automation/webhooks').send({ name: 'x', url: 'https://example.com' }),
      as(operator).put('/api/automation/webhooks/1').send({ name: 'x' }),
      as(operator).delete('/api/automation/webhooks/1'),
      as(operator).post('/api/automation/webhooks/1/test'),
      as(operator).post('/api/automation/reports').send({ name: 'x' }),
      as(operator).put('/api/automation/reports/1').send({ name: 'x' }),
      as(operator).delete('/api/automation/reports/1'),
      as(operator).post('/api/automation/reports/1/send-now'),
      as(operator).post('/api/dns-sources').send({ name: 'x' }),
      as(operator).delete('/api/dns-sources/1'),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
    expect(jest.mocked(query).mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(sql)))).toBe(false);
  });
});

describe('viewers and site-limited accounts see none of it', () => {
  it.each([
    '/api/settings/users', '/api/settings/encryption', '/api/alerts/rules', '/api/alerts/channels',
    '/api/automation/tokens', '/api/automation/webhooks', '/api/automation/reports', '/api/audit-log', '/api/dns-sources',
  ])('refuses %s', async (path) => {
    expect((await as(viewer).get(path)).status).toBe(403);
    expect((await as(siteOperator).get(path)).status).toBe(403);
  });
});
