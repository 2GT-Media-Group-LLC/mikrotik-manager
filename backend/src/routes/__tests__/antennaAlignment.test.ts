jest.mock('../../config/database');
jest.mock('../../services/AntennaAlignmentService', () => ({
  antennaAlignment: { read: jest.fn(), remove: jest.fn() },
  AlignmentCapacityError: class AlignmentCapacityError extends Error {},
}));
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req: import('express').Request, res: import('express').Response, next: () => void) => {
    if (!req.headers['x-test-auth']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { userId: 1, username: 'test', role: 'viewer',
      ...(req.headers['x-test-sites'] ? { siteRoles: { 1: 'viewer' } } : {}) };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import routes from '../antennaAlignment';
import { query, queryOne } from '../../config/database';
import { antennaAlignment, AlignmentCapacityError } from '../../services/AntennaAlignmentService';

const device = { id: 1, device_type: 'wisp', ssh_only: false, api_password_encrypted: 'server-only-secret' };
const sample = { sampled_at: '2026-10-11T01:00:00Z', radios: [], warnings: [] };
const app = () => { const a = express(); a.use('/api/wireless', routes); return a; };

describe('GET /api/wireless/:id/alignment', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(query).mockResolvedValue([device] as never);
    jest.mocked(queryOne).mockResolvedValue({ site_id: 1 } as never);
    jest.mocked(antennaAlignment.read).mockResolvedValue(sample);
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires authentication before looking up or connecting to a radio', async () => {
    expect((await request(app()).get('/api/wireless/1/alignment')).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(antennaAlignment.read).not.toHaveBeenCalled();
  });
  it('allows a viewer to read WISP telemetry and never returns stored credentials', async () => {
    const res = await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(sample);
    expect(res.text).not.toContain('server-only-secret');
  });
  it.each(['wireless_ap', 'router', 'switch', 'other'])('rejects device type %s before opening a session', async type => {
    jest.mocked(query).mockResolvedValue([{ ...device, device_type: type }] as never);
    expect((await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1')).status).toBe(400);
    expect(antennaAlignment.read).not.toHaveBeenCalled();
    expect(antennaAlignment.remove).toHaveBeenCalledWith(1);
  });
  it('rejects SSH-only WISP radios with an actionable API message', async () => {
    jest.mocked(query).mockResolvedValue([{ ...device, ssh_only: true }] as never);
    const res = await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Enable the RouterOS API');
    expect(antennaAlignment.read).not.toHaveBeenCalled();
  });
  it('checks site membership before using a cached or live sample', async () => {
    jest.mocked(queryOne).mockResolvedValue({ site_id: 2 } as never);
    const res = await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1').set('x-test-sites', '1');
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    expect(antennaAlignment.read).not.toHaveBeenCalled();
  });
  it('allows a site viewer to read a radio in their own site', async () => {
    expect((await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1').set('x-test-sites', '1')).status).toBe(200);
  });
  it.each(['0', '-1', 'NaN', '1.5', '2147483648', '1e0', '0x1', '%2B1'])('rejects invalid device id %s', async id => {
    expect((await request(app()).get(`/api/wireless/${id}/alignment`).set('x-test-auth', '1')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('checks the decoded route parameter for site access even on encoded URLs', async () => {
    jest.mocked(queryOne).mockResolvedValue({ site_id: 2 } as never);
    const res = await request(app()).get('/api/wireless/%31/alignment').set('x-test-auth', '1').set('x-test-sites', '1');
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    expect(antennaAlignment.read).not.toHaveBeenCalled();
  });
  it('returns 404 for a deleted device and closes its session', async () => {
    jest.mocked(query).mockResolvedValue([]);
    expect((await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1')).status).toBe(404);
    expect(antennaAlignment.remove).toHaveBeenCalledWith(1);
  });
  it('does not expose raw device errors in a failed poll', async () => {
    jest.mocked(antennaAlignment.read).mockRejectedValue(new Error('bad secret: server-only-secret'));
    const res = await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1');
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('server-only-secret');
  });
  it('returns a retryable capacity error', async () => {
    jest.mocked(antennaAlignment.read).mockRejectedValue(new AlignmentCapacityError('Pause another aligner.'));
    expect((await request(app()).get('/api/wireless/1/alignment').set('x-test-auth', '1')).status).toBe(503);
  });
});
