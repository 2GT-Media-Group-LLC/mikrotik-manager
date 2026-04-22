jest.mock('../../config/database');
jest.mock('../../config/redis', () => ({
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
  },
}));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (
    req: { user?: { role: string } },
    res: { status: (c: number) => { json: (b: unknown) => void } },
    next: () => void
  ) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  },
}));

jest.mock('../../utils/crypto', () => ({
  encrypt: (s: string) => `enc:${s}`,
}));

import request from 'supertest';
import express from 'express';
import credentialPresetsRoutes from '../credentialPresets';
import { query, queryOne } from '../../config/database';

const mockedQuery = jest.mocked(query);
const mockedQueryOne = jest.mocked(queryOne);

function makeApp(role: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { userId: number; username: string; role: string } }).user = {
      userId: 1,
      username: 'test',
      role,
    };
    next();
  });
  app.use('/', credentialPresetsRoutes);
  return app;
}

describe('credentialPresets routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET / returns public list', async () => {
    mockedQuery.mockResolvedValueOnce([
      {
        id: 1,
        name: 'Default',
        api_username: 'admin',
        api_password_encrypted: 'x',
        api_port: 8728,
        ssh_username: null,
        ssh_password_encrypted: null,
        ssh_port: null,
        notes: null,
        allow_operator_use: true,
        created_at: 't',
        updated_at: 't',
      },
    ]);
    const app = makeApp('viewer');
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: 1,
      name: 'Default',
      has_api_password: true,
      has_ssh_password: false,
    });
    expect(res.body[0].api_password_encrypted).toBeUndefined();
  });

  it('POST / rejects non-admin', async () => {
    const app = makeApp('operator');
    const res = await request(app).post('/').send({
      name: 'x',
      api_username: 'a',
      api_password: 'p',
    });
    expect(res.status).toBe(403);
  });

  it('POST / requires name, api_username, api_password', async () => {
    const app = makeApp('admin');
    const res = await request(app).post('/').send({ name: 'only' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/required/);
  });

  it('POST / creates preset when admin', async () => {
    mockedQueryOne.mockResolvedValueOnce(null);
    mockedQuery.mockResolvedValueOnce([
      {
        id: 2,
        name: 'Lab',
        api_username: 'admin',
        api_password_encrypted: 'enc:p',
        api_port: 8728,
        ssh_username: null,
        ssh_password_encrypted: null,
        ssh_port: null,
        notes: null,
        allow_operator_use: true,
        created_at: 't',
        updated_at: 't',
      },
    ]);
    const app = makeApp('admin');
    const res = await request(app).post('/').send({
      name: 'Lab',
      api_username: 'admin',
      api_password: 'secret',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 2, name: 'Lab', has_api_password: true });
  });
});
