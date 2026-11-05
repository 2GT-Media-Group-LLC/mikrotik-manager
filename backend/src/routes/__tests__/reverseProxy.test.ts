jest.mock('../../config/database');
jest.mock('../../middleware/site', () => ({ activeSite: () => null }));
jest.mock('../../middleware/auth', () => {
  const role = (ok: (r: string) => boolean) => (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (ok(req.user?.role ?? '') ? next() : res.status(403).json({ error: 'no' }));
  return {
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireWrite: role((r) => r === 'admin' || r === 'operator'),
    requireAdmin: role((r) => r === 'admin'),
  };
});
jest.mock('../../utils/siteAccess', () => ({
  ...jest.requireActual('../../utils/siteAccess'),
  deviceSiteAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/changeGuard/deviceLock', () => ({
  deviceWriteLock: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  deviceIdFromQuery: () => null,
}));

const live = {
  rules: [] as Record<string, string>[], services: [] as Record<string, string>[], certs: [] as Record<string, string>[], vrfs: ['main'],
};
const collector = {
  connect: jest.fn(), disconnect: jest.fn(),
  getReverseProxy: jest.fn(async () => live),
  addReverseProxyRule: jest.fn(), setReverseProxyRule: jest.fn(), removeReverseProxyRule: jest.fn(), setServicePort: jest.fn(),
  collectReverseProxy: jest.fn(), collectCertificates: jest.fn(),
};
jest.mock('../../services/mikrotik/DeviceCollector', () => ({ DeviceCollector: jest.fn(() => collector) }));
const guarded = jest.fn();
jest.mock('../../services/changeGuard/guardedRoute', () => ({
  withGuardedChange: async (_id: number, _req: unknown, res: { json: (b: unknown) => void }, meta: unknown, fn: (c: unknown) => Promise<unknown>) => {
    guarded(meta);
    res.json(await fn(collector));
  },
}));
const issueProxyCert = jest.fn();
jest.mock('../../services/proxyCerts', () => ({ issueProxyCert: (...a: unknown[]) => issueProxyCert(...a), removeProxyCert: jest.fn() }));

import request from 'supertest';
import express from 'express';
import routes from '../reverseProxy';
import { query, queryOne } from '../../config/database';

const app = (role = 'operator') => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = { userId: 1, username: 'u', role } as never; next(); });
  a.use('/', routes);
  return a;
};

const services = (): Record<string, string>[] => [
  { '.id': '*6', name: 'www-ssl', port: '443', certificate: 'mtm-x', disabled: 'false' },
  { '.id': '*A', name: 'reverse-proxy', port: '443', certificate: 'none', disabled: 'false' },
  { '.id': '*1', name: 'api-ssl', port: '8729', disabled: 'false' },
];
const nasCert = { name: 'nas', 'common-name': 'nas.example.com', 'subject-alt-name': 'DNS:nas.example.com', 'private-key': 'true', expired: 'false' };
const rule = { sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: 8080, certificate: 'nas' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(queryOne).mockResolvedValue({ id: 8, name: 'TEST', status: 'online' } as never);
  jest.mocked(query).mockResolvedValue([] as never);
  Object.assign(live, { rules: [], services: services(), certs: [nasCert], vrfs: ['main'] });
});

describe('adding a rule', () => {
  it('stops at the port 443 clash with WebFig and offers the choice', async () => {
    const res = await request(app()).post('/rule?deviceId=8').send(rule);
    expect(res.status).toBe(409);
    expect(res.body.clash).toEqual({ port: 443 });
    expect(guarded).not.toHaveBeenCalled();
  });

  it('moves WebFig HTTPS first when asked, then adds the rule', async () => {
    const res = await request(app()).post('/rule?deviceId=8').send({ ...rule, fix: { service: 'www-ssl', port: 8443 } });
    expect(res.status).toBe(200);
    expect(collector.setServicePort).toHaveBeenCalledWith('*6', 8443);
    expect(collector.addReverseProxyRule).toHaveBeenCalledWith({ sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080', certificate: 'nas' });
    expect(guarded).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/WebFig HTTPS moved to port 8443/) }));
  });

  it('won\'t move onto a port another service holds', async () => {
    const res = await request(app()).post('/rule?deviceId=8').send({ ...rule, fix: { service: 'reverse-proxy', port: 8729 } });
    expect(res.body.errors.fix).toMatch(/api-ssl/);
    expect(collector.addReverseProxyRule).not.toHaveBeenCalled();
  });

  it('needs no fix once WebFig is elsewhere, and refuses a second rule for one name', async () => {
    live.services = services().map((s) => (s.name === 'www-ssl' ? { ...s, port: '8443' } : s));
    expect((await request(app()).post('/rule?deviceId=8').send(rule)).status).toBe(200);
    live.rules = [{ '.id': '*1', sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080' }];
    const dup = await request(app()).post('/rule?deviceId=8').send(rule);
    expect(dup.body.errors.sni).toMatch(/already a rule/);
  });

  it('refuses a certificate that isn\'t for the name, and is refused to a viewer', async () => {
    live.services = services().map((s) => (s.name === 'www-ssl' ? { ...s, disabled: 'true' } : s));
    const res = await request(app()).post('/rule?deviceId=8').send({ ...rule, sni: 'cam.example.com' });
    expect(res.body.errors.certificate).toMatch(/isn't for cam/);
    expect((await request(app('viewer')).post('/rule?deviceId=8').send(rule)).status).toBe(403);
  });
});

describe('changing a rule', () => {
  beforeEach(() => {
    live.services = services().map((s) => (s.name === 'www-ssl' ? { ...s, port: '8443' } : s));
    live.rules = [{ '.id': '*1', sni: 'nas.example.com', 'ip-address': '192.168.88.10', port: '8080', certificate: 'nas' },
      { '.id': '*2', sni: 'app.local', 'ip-address': '172.17.0.2', port: '80', dynamic: 'true' }];
  });

  it('checks the rule is still the one the page showed', async () => {
    const res = await request(app()).put('/rule/*1?deviceId=8&sni=other.example.com').send({ disabled: true });
    expect(res.status).toBe(409);
    await request(app()).put('/rule/*1?deviceId=8&sni=nas.example.com').send({ disabled: true });
    expect(collector.setReverseProxyRule).toHaveBeenCalledWith('*1', { disabled: 'yes' });
  });

  it('leaves container app rules alone', async () => {
    expect((await request(app()).delete('/rule/*2?deviceId=8&sni=app.local')).body.error).toMatch(/container app/);
  });

  it('keeps the certificate valid for a renamed rule', async () => {
    const res = await request(app()).put('/rule/*1?deviceId=8&sni=nas.example.com').send({ sni: 'files.example.com' });
    expect(res.body.errors.certificate).toMatch(/isn't for files/);
  });
});

describe('certificates from the CA', () => {
  it('are for admins', async () => {
    expect((await request(app()).post('/cert?deviceId=8').send({ sni: 'nas.example.com' })).status).toBe(403);
    issueProxyCert.mockResolvedValueOnce({ ok: true, steps: [], message: 'ok', cert_name: 'mtm-proxy-nas.example.com-abcdef' });
    const res = await request(app('admin')).post('/cert?deviceId=8').send({ sni: 'nas.example.com', days: 365 });
    expect(res.body.ok).toBe(true);
    expect(issueProxyCert).toHaveBeenCalledWith(8, 'nas.example.com', { days: 365 });
  });
});
