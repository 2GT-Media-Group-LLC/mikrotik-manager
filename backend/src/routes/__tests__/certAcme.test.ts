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
import { createCa } from '../../utils/pki';

const directory = 'https://acme-v02.api.letsencrypt.org/directory';
const valid = { domain: 'manager.example.com', email: 'admin@example.com', server: directory };
const originalEnv = { ...process.env };

function app() {
  const server = express();
  server.use(express.json({ limit: '10mb' }));
  server.use('/api/cert', routes);
  return server;
}

describe('manager ACME settings', () => {
  let ca: { certPem: string; keyPem: string };
  beforeAll(async () => { ca = await createCa({ commonName: 'ACME test CA', days: 30 }); });
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

  it('requires an administrator to read the last Certbot attempt', async () => {
    expect((await request(app()).get('/api/cert/acme/status')).status).toBe(401);
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'viewer')).status).toBe(403);
  });

  it('returns no attempt when ACME is disabled or no attempt exists', async () => {
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'admin')).body).toEqual({ lastAttempt: null });
    process.env.ACME_DOMAIN = valid.domain;
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'admin')).body).toEqual({ lastAttempt: null });
  });

  it.each([['issue', 0], ['renew', 1]])('reads the last %s attempt with exit code %i', async (action, code) => {
    process.env.ACME_DOMAIN = valid.domain;
    const time = '2026-11-10T08:30:00Z';
    jest.mocked(readFile).mockImplementation(async (file) => {
      if (file === '/certs/acme-last-attempt') return `${time}\n${action}\n${code}\n${valid.domain}\nCertbot output\nCertbot detailed log:\nDetailed failure\n` as never;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'admin')).body).toEqual({
      lastAttempt: { time, action, exitCode: code, domain: valid.domain, output: 'Certbot output\nCertbot detailed log:\nDetailed failure\n' },
    });
  });

  it('surfaces invalid or unreadable attempt status instead of reporting no attempt', async () => {
    process.env.ACME_DOMAIN = valid.domain;
    jest.mocked(readFile).mockImplementation(async (file) => {
      if (file === '/certs/acme-last-attempt') return 'invalid status' as never;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'admin')).status).toBe(500);
    jest.mocked(readFile).mockImplementation(async (file) => {
      throw Object.assign(new Error('read failed'), { code: file === '/certs/acme-last-attempt' ? 'EACCES' : 'ENOENT' });
    });
    expect((await request(app()).get('/api/cert/acme/status').set('x-test-role', 'admin')).status).toBe(500);
  });

  it.each([
    { domain: '', email: '' },
    { domain: '', email: 'admin@example.com' },
    { domain: '  ', email: 'admin@example.com' },
  ])('requires a domain: %p', async (values) => {
    const res = await request(app()).put('/api/cert/acme').set('x-test-role', 'admin')
      .send({ ...valid, ...values });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/a domain is required/i);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['', '  ', undefined])('accepts an optional email: %p', async (email) => {
    const res = await request(app()).put('/api/cert/acme').set('x-test-role', 'admin')
      .send({ ...valid, email });
    expect(res.status).toBe(200);
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      `ACME_DOMAIN=${valid.domain}\nACME_EMAIL=\nACME_SERVER=${valid.server}\n`,
      { mode: 0o600 },
    );
  });

  it.each(['invalid', 'a@', 'a@b', null, 123])('rejects invalid supplied email: %p', async (email) => {
    const res = await request(app()).put('/api/cert/acme').set('x-test-role', 'admin').send({ ...valid, email });
    expect(res.status).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('reads web settings without an email', async () => {
    jest.mocked(readFile).mockResolvedValue(`ACME_DOMAIN=${valid.domain}\nACME_EMAIL=\nACME_SERVER=${valid.server}\n` as never);
    const res = await request(app()).get('/api/cert/acme').set('x-test-role', 'admin');
    expect(res.body).toEqual({ ...valid, email: '', source: 'web', readOnly: false });
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
    expect(unlink).toHaveBeenCalledWith('/certs/acme-last-attempt');
  });

  it('keeps the last attempt when reverting to an enabled environment configuration', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    expect((await request(app()).delete('/api/cert/acme').set('x-test-role', 'admin')).status).toBe(200);
    expect(unlink).toHaveBeenCalledWith('/certs/acme-settings.conf');
    expect(unlink).not.toHaveBeenCalledWith('/certs/acme-last-attempt');
  });

  it('surfaces errors clearing the last attempt on disable', async () => {
    jest.mocked(unlink).mockImplementation(async (file) => {
      if (file === '/certs/acme-last-attempt') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect((await request(app()).delete('/api/cert/acme').set('x-test-role', 'admin')).status).toBe(500);
  });

  it('requires an administrator for all CA bundle operations', async () => {
    expect((await request(app()).get('/api/cert/acme/ca-bundle')).status).toBe(401);
    expect((await request(app()).get('/api/cert/acme/ca-bundle').set('x-test-role', 'viewer')).status).toBe(403);
    expect((await request(app()).put('/api/cert/acme/ca-bundle').set('x-test-role', 'viewer').send({ certificate: ca.certPem })).status).toBe(403);
    expect((await request(app()).delete('/api/cert/acme/ca-bundle').set('x-test-role', 'viewer')).status).toBe(403);
  });

  it('reports whether the CA bundle exists and surfaces read errors', async () => {
    expect((await request(app()).get('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).body)
      .toEqual({ installed: false, readOnly: false });
    jest.mocked(readFile).mockResolvedValue(ca.certPem as never);
    expect((await request(app()).get('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).body)
      .toEqual({ installed: true, readOnly: false });
    jest.mocked(readFile).mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    expect((await request(app()).get('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).status).toBe(500);
  });

  it('installs an entire PEM bundle atomically at the Certbot trust path', async () => {
    const res = await request(app()).put('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')
      .send({ certificate: `\n${ca.certPem}\n${ca.certPem}\n` });
    expect(res.status).toBe(200);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/certs\/acme-ca-bundle\.crt\..*\.tmp$/),
      expect.stringMatching(/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----/),
      { mode: 0o644 },
    );
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/^\/certs\/acme-ca-bundle\.crt\..*\.tmp$/), '/certs/acme-ca-bundle.crt');
  });

  it('rejects invalid PEM, private keys, and oversized files without replacing the bundle', async () => {
    for (const certificate of ['', 'not a certificate', ca.certPem + ca.keyPem, 'x'.repeat(1024 * 1024 + 1)]) {
      expect((await request(app()).put('/api/cert/acme/ca-bundle').set('x-test-role', 'admin').send({ certificate })).status).toBe(400);
    }
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('allows CA bundle changes while environment settings are locked', async () => {
    process.env.ACME_DOMAIN = 'env.example.com';
    process.env.ACME_EMAIL = 'admin@example.com';
    process.env.ACME_SERVER = 'https://ca.example.com/';
    expect((await request(app()).get('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).body)
      .toEqual({ installed: false, readOnly: false });
    expect((await request(app()).put('/api/cert/acme/ca-bundle').set('x-test-role', 'admin').send({ certificate: ca.certPem })).status).toBe(200);
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/^\/certs\/acme-ca-bundle\.crt\..*\.tmp$/), '/certs/acme-ca-bundle.crt');
    expect((await request(app()).delete('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).status).toBe(200);
    expect(unlink).toHaveBeenCalledWith('/certs/acme-ca-bundle.crt');
  });

  it('removes the CA bundle without touching the HTTPS certificate', async () => {
    expect((await request(app()).delete('/api/cert/acme/ca-bundle').set('x-test-role', 'admin')).status).toBe(200);
    expect(unlink).toHaveBeenCalledWith('/certs/acme-ca-bundle.crt');
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('reports and cleans up a failed atomic bundle write', async () => {
    jest.mocked(rename).mockRejectedValue(new Error('cannot replace bundle'));
    expect((await request(app()).put('/api/cert/acme/ca-bundle').set('x-test-role', 'admin').send({ certificate: ca.certPem })).status).toBe(500);
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/certs\/acme-ca-bundle\.crt\..*\.tmp$/));
  });
});
