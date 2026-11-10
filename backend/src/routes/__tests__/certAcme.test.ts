jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
  rename: jest.fn(),
}));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req: import('express').Request, res: import('express').Response, next: () => void) => {
    if (!req.headers['x-test-role']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  },
  requireAdmin: (req: import('express').Request, res: import('express').Response, next: () => void) => {
    if (req.headers['x-test-role'] !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { readFile, writeFile, unlink, rename } from 'fs/promises';
import routes from '../cert';

const directory = 'https://acme-v02.api.letsencrypt.org/directory';
const valid = { domain: 'manager.example.com', email: 'admin@example.com', server: directory };
const originalEnv = { ...process.env };

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/cert', routes);
  return server;
}

describe('manager ACME settings', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ACME_DOMAIN;
    delete process.env.ACME_EMAIL;
    delete process.env.ACME_SERVER;
    jest.mocked(readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    jest.mocked(writeFile).mockResolvedValue(undefined);
    jest.mocked(rename).mockResolvedValue(undefined);
    jest.mocked(unlink).mockResolvedValue(undefined);
  });
  afterAll(() => { process.env = originalEnv; });

  it('requires an administrator to read or change the settings', async () => {
    expect((await request(app()).get('/api/cert/acme')).status).toBe(401);
    expect((await request(app()).get('/api/cert/acme').set('x-test-role', 'viewer')).status).toBe(403);
    expect((await request(app()).put('/api/cert/acme').set('x-test-role', 'viewer').send(valid)).status).toBe(403);
  });

  it.each([
    { domain: '', email: '' },
    { domain: '', email: 'admin@example.com' },
    { domain: 'manager.example.com', email: '' },
    { domain: '  ', email: 'admin@example.com' },
    { domain: 'manager.example.com', email: '  ' },
  ])('requires both domain and email: %p', async (values) => {
    const res = await request(app()).put('/api/cert/acme').set('x-test-role', 'admin')
      .send({ ...valid, ...values });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/both domain and contact email are required/i);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('saves valid web settings when the environment is incomplete', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    process.env.ACME_EMAIL = 'env@example.com';
    const res = await request(app()).put('/api/cert/acme').set('x-test-role', 'admin').send(valid);
    expect(res.status).toBe(200);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/certs\/acme-settings\.conf\..*\.tmp$/),
      `ACME_DOMAIN=${valid.domain}\nACME_EMAIL=${valid.email}\nACME_SERVER=${valid.server}\n`,
      { mode: 0o600 },
    );
    expect(rename).toHaveBeenCalled();
  });

  it('uses the default directory without locking when ACME_SERVER is not set', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    process.env.ACME_EMAIL = 'env@example.com';
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.body).toEqual({ domain: 'env.example.com', email: 'env@example.com', server: directory, source: 'environment', readOnly: false });
  });

  it('uses web settings if any environment setting is absent', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    process.env.ACME_EMAIL = 'env@example.com';
    jest.mocked(readFile).mockResolvedValue(`ACME_DOMAIN=${valid.domain}\nACME_EMAIL=${valid.email}\nACME_SERVER=${valid.server}\n` as never);
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.body).toEqual({ ...valid, source: 'web', readOnly: false });
  });

  it('reads named settings in any order and preserves equals signs in values', async () => {
    const server = `${directory}?param=a=b`;
    jest.mocked(readFile).mockResolvedValue(`ACME_SERVER=${server}\nACME_DOMAIN=${valid.domain}\nACME_EMAIL=${valid.email}\n` as never);
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.body).toEqual({ ...valid, server, source: 'web', readOnly: false });
  });

  it('rejects duplicate or missing named settings', async () => {
    jest.mocked(readFile).mockResolvedValue(`ACME_DOMAIN=${valid.domain}\nACME_DOMAIN=other.example.com\nACME_SERVER=${directory}\n` as never);
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.status).toBe(500);
  });

  it('rejects the old positional format', async () => {
    jest.mocked(readFile).mockResolvedValue(`${valid.domain}\n${valid.email}\n${valid.server}\n` as never);
    expect((await request(app()).get('/api/cert/acme').set('x-test-role', 'admin')).status).toBe(500);
  });

  it('locks all settings to the complete environment even if a web override exists', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    process.env.ACME_EMAIL = 'env@example.com';
    process.env.ACME_SERVER = 'https://ca.example.com/directory';
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.body).toEqual({ domain: 'env.example.com', email: 'env@example.com', server: 'https://ca.example.com/directory', source: 'environment', readOnly: true });
    expect(readFile).not.toHaveBeenCalled();
    expect((await request(app()).put('/api/cert/acme').set('x-test-role', 'admin').send(valid)).status).toBe(409);
    expect((await request(app()).delete('/api/cert/acme').set('x-test-role', 'admin')).status).toBe(409);
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('allows the web override to be removed while the environment is incomplete', async () => {
    expect((await request(app()).delete('/api/cert/acme').set('x-test-role', 'admin')).status).toBe(200);
    expect(unlink).toHaveBeenCalledWith('/certs/acme-settings.conf');
  });
});
