import 'express-async-errors';
jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req: import('express').Request, res: import('express').Response, next: () => void) => {
    if (!req.headers['x-test-auth']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { userId: 7, username: 'viewer', role: String(req.headers['x-test-role'] ?? 'viewer') as 'admin' | 'viewer',
      ...(req.headers['x-test-sites'] ? { siteRoles: { 1: 'viewer' } } : {}) };
    next();
  },
  requireAdmin: (req: import('express').Request, res: import('express').Response, next: () => void) => {
    if (req.user?.role !== 'admin' || req.user.siteRoles) { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
  },
}));
jest.mock('../../services/netflow/NetflowCollector', () => ({ netflowCollector: { reconcile: jest.fn() } }));
jest.mock('../../services/encryptedData', () => ({ encryptionStatus: jest.fn(), reencryptAll: jest.fn() }));
jest.mock('../../utils/secrets', () => ({ encryptionKeyInfo: jest.fn(), encryptionKeyMissing: jest.fn(), rotateEncryptionKey: jest.fn(), retireOldEncryptionKeys: jest.fn() }));

import express from 'express';
import request from 'supertest';
import routes from '../timeFormat';
import settings from '../settings';
import { query, queryOne } from '../../config/database';

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/auth/time-format', routes);
  server.use('/api/settings', settings);
  return server;
}

describe('account and system time formats', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(queryOne).mockResolvedValue({ time_format: null, system_default: '24h' } as never);
    jest.mocked(query).mockResolvedValue([]);
  });
  it('requires authentication before reading or updating account preferences', async () => {
    expect((await request(app()).get('/api/auth/time-format')).status).toBe(401);
    expect((await request(app()).put('/api/auth/time-format').send({ preference: '12h' })).status).toBe(401);
    expect(queryOne).not.toHaveBeenCalled();
  });
  it('lets a site viewer inherit the system default without exposing other accounts', async () => {
    const res = await request(app()).get('/api/auth/time-format').set('x-test-auth', '1').set('x-test-sites', '1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ preference: 'system', system_default: '24h' });
    expect(jest.mocked(queryOne).mock.calls[0][1]).toEqual([7]);
  });
  it.each(['browser', '12h', '24h'])('persists %s to the authenticated account across browsers', async preference => {
    jest.mocked(queryOne).mockResolvedValue({ time_format: preference, system_default: '24h' } as never);
    const res = await request(app()).put('/api/auth/time-format').set('x-test-auth', '1').send({ preference, user_id: 999 });
    expect(res.status).toBe(200);
    expect(res.body.preference).toBe(preference);
    expect(jest.mocked(queryOne).mock.calls[0][1]).toEqual([preference, 7]);
  });
  it('clears the personal override when choosing the system default', async () => {
    const res = await request(app()).put('/api/auth/time-format').set('x-test-auth', '1').send({ preference: 'system' });
    expect(res.status).toBe(200);
    expect(jest.mocked(queryOne).mock.calls[0][1]).toEqual([null, 7]);
  });
  it.each(['25h', '', null, 24, {}, undefined])('rejects invalid preferences before writing: %p', async preference => {
    expect((await request(app()).put('/api/auth/time-format').set('x-test-auth', '1').send({ preference })).status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });
  it('uses browser defaults for unset or invalid historical data', async () => {
    jest.mocked(queryOne).mockResolvedValue({ time_format: 'invalid', system_default: null } as never);
    expect((await request(app()).get('/api/auth/time-format').set('x-test-auth', '1')).body)
      .toEqual({ preference: 'system', system_default: 'browser' });
  });
  it('returns 404 for an account that has been deleted', async () => {
    jest.mocked(queryOne).mockResolvedValue(null);
    expect((await request(app()).get('/api/auth/time-format').set('x-test-auth', '1')).status).toBe(404);
  });
  it('prevents ordinary and site-scoped users from changing the fleet default', async () => {
    expect((await request(app()).put('/api/settings').set('x-test-auth', '1').send({ time_format_default: '12h' })).status).toBe(403);
    expect((await request(app()).put('/api/settings').set('x-test-auth', '1').set('x-test-role', 'admin').set('x-test-sites', '1').send({ time_format_default: '12h' })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('allows a fleet admin to change the default without changing personal choices', async () => {
    expect((await request(app()).put('/api/settings').set('x-test-auth', '1').set('x-test-role', 'admin').send({ time_format_default: '12h' })).status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_settings'), ['time_format_default', '"12h"']);
    expect(queryOne).not.toHaveBeenCalled();
  });
  it.each(['system', null, false, '25h'])('rejects invalid system defaults: %p', async time_format_default => {
    expect((await request(app()).put('/api/settings').set('x-test-auth', '1').set('x-test-role', 'admin').send({ time_format_default })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
