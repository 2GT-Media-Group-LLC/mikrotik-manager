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
  // The new certificate appears on the device, as RouterOS creates it.
  addAcmeCertificate: jest.fn(async (name: string, domain: string, dir: string) => {
    live.certs = [...live.certs.filter((c) => c.name !== name), { '.id': `*n${live.certs.length}`, name, 'acme-managed': 'true', issued: 'false',
      'private-key': 'false', 'domain-names': domain, 'directory-url': dir, 'acme-status': 'generating private key' }];
  }),
  removeCertificateById: jest.fn(), renewAcmeCertificate: jest.fn(),
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

describe('Let\'s Encrypt (#358)', () => {
  const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
  const PROD = 'https://acme-v02.api.letsencrypt.org/directory';
  const le = (name: string, over: Record<string, string> = {}) => ({ '.id': `*${name.length}`, name, 'acme-managed': 'true', issued: 'false', 'private-key': 'false',
    'domain-names': 'nas.example.org', 'directory-url': name.includes('staging') ? STAGING : PROD, 'acme-status': 'requesting validation', ...over });
  beforeEach(() => { live.services = services().map((s) => (s.name === 'www-ssl' ? { ...s, port: '8443' } : s)); });

  it('requests the certificate and saves the rule in one change', async () => {
    const res = await request(app()).post('/rule?deviceId=8').send({ sni: 'nas.example.org', 'ip-address': '192.168.88.10', port: 5000, acme: { staging: true } });
    expect(res.status).toBe(200);
    expect(collector.addAcmeCertificate).toHaveBeenCalledWith('mtm-le-staging-nas.example.org', 'nas.example.org', STAGING);
    expect(collector.addReverseProxyRule).toHaveBeenCalledWith(expect.objectContaining({ certificate: 'mtm-le-staging-nas.example.org' }));
    expect(guarded).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/Let's Encrypt staging/) }));
  });

  it('takes the certificate back when the rule can\'t be added', async () => {
    collector.addReverseProxyRule.mockRejectedValueOnce(new Error('input does not match any value of certificate'));
    const res = await request(app()).post('/rule?deviceId=8').send({ sni: 'nas.example.org', 'ip-address': '192.168.88.10', port: 5000, acme: { staging: true } });
    expect(res.status).toBe(500);
    expect(collector.removeCertificateById).toHaveBeenCalled();
  });

  it('refuses internal names, and a certificate as well as Let\'s Encrypt', async () => {
    const lan = await request(app()).post('/rule?deviceId=8').send({ sni: 'nas.lan', 'ip-address': '192.168.88.10', port: 80, acme: { staging: true } });
    expect(lan.body.errors.sni).toMatch(/internal/);
    const both = await request(app()).post('/rule?deviceId=8').send({ ...rule, sni: 'nas.example.org', acme: { staging: false } });
    expect(both.body.errors.certificate).toMatch(/not both/);
    expect(collector.addAcmeCertificate).not.toHaveBeenCalled();
  });

  it('retries a failed request: the rule lets go, the certificate is requested again, the rule takes it back', async () => {
    live.rules = [{ '.id': '*1', sni: 'nas.example.org', 'ip-address': '192.168.88.10', port: '5000', certificate: 'mtm-le-staging-nas.example.org' }];
    live.certs = [le('mtm-le-staging-nas.example.org', { 'acme-status': 'http-01 challenge validation failed, connection refused' })];
    const res = await request(app()).put('/rule/*1?deviceId=8&sni=nas.example.org').send({ acme: { staging: true } });
    expect(res.status).toBe(200);
    expect(collector.setReverseProxyRule.mock.calls).toEqual([['*1', { certificate: 'none' }], ['*1', { certificate: 'mtm-le-staging-nas.example.org' }]]);
    expect(collector.removeCertificateById).toHaveBeenCalledWith(le('mtm-le-staging-nas.example.org')['.id']);
    expect(collector.addAcmeCertificate).toHaveBeenCalledTimes(1);
  });

  it('leaves a request in progress alone', async () => {
    live.rules = [{ '.id': '*1', sni: 'nas.example.org', 'ip-address': '192.168.88.10', port: '5000', certificate: 'mtm-le-staging-nas.example.org' }];
    live.certs = [le('mtm-le-staging-nas.example.org')];
    const res = await request(app()).put('/rule/*1?deviceId=8&sni=nas.example.org').send({ acme: { staging: true } });
    expect(res.body.unchanged).toBe(true);
    expect(collector.addAcmeCertificate).not.toHaveBeenCalled();
  });

  it('switches from staging to production and drops the staging certificate', async () => {
    live.rules = [{ '.id': '*1', sni: 'nas.example.org', 'ip-address': '192.168.88.10', port: '5000', certificate: 'mtm-le-staging-nas.example.org' }];
    live.certs = [le('mtm-le-staging-nas.example.org', { issued: 'true', 'private-key': 'true', 'acme-status': '' })];
    // The rule takes the new certificate on the device, so the staging one is then unused.
    collector.setReverseProxyRule.mockImplementationOnce(async (_id: string, params: Record<string, string>) => {
      live.rules = [{ ...live.rules[0], ...params }];
    });
    const res = await request(app()).put('/rule/*1?deviceId=8&sni=nas.example.org').send({ acme: { staging: false } });
    expect(res.status).toBe(200);
    expect(collector.addAcmeCertificate).toHaveBeenCalledWith('mtm-le-nas.example.org', 'nas.example.org', PROD);
    expect(collector.setReverseProxyRule).toHaveBeenCalledWith('*1', { certificate: 'mtm-le-nas.example.org' });
    expect(collector.removeCertificateById).toHaveBeenCalledWith(le('mtm-le-staging-nas.example.org')['.id']);
  });

  it('renews only an issued certificate', async () => {
    live.certs = [le('mtm-le-nas.example.org')];
    expect((await request(app()).post('/acme/renew?deviceId=8').send({ name: 'mtm-le-nas.example.org' })).status).toBe(409);
    live.certs = [le('mtm-le-nas.example.org', { issued: 'true', 'private-key': 'true' })];
    expect((await request(app()).post('/acme/renew?deviceId=8').send({ name: 'mtm-le-nas.example.org' })).status).toBe(200);
    expect(collector.renewAcmeCertificate).toHaveBeenCalled();
  });
});
