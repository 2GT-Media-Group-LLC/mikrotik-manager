import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite, requireAdmin } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeDevices } from '../utils/siteScope';
import { deviceSiteAccess, deviceIdQuery, strictId } from '../utils/siteAccess';
import { deviceWriteLock, deviceIdFromQuery } from '../services/changeGuard/deviceLock';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import { DeviceCollector, type DeviceRow } from '../services/mikrotik/DeviceCollector';
import { PkiError } from '../utils/pki';
import { issueProxyCert, removeProxyCert, type ProxyCertRow } from '../services/proxyCerts';
import {
  REVERSE_PROXY_MIN_VERSION, reverseProxySupport, rulesFrom, serviceFrom, portClash, movePortError, certsFrom, checkRule,
  certCovers, type ProxyRule,
} from '../utils/reverseProxy';

/**
 * Reverse proxy (#358), on the Certificates page. Rules are read with the
 * slow poll for the fleet list and live for editing; writes run under Change
 * Guard and are previewable. Certificates for a rule's host name come from a
 * certificate already on the device, or from the manager's CA (admins).
 */
const router = Router();
router.use(requireAuth);
router.use(deviceSiteAccess(deviceIdQuery));
router.use(deviceWriteLock(deviceIdFromQuery));

function deviceIdParam(req: Request, res: Response): number | null {
  const id = strictId(req.query.deviceId);
  if (!id) { res.status(400).json({ error: 'deviceId query param is required' }); return null; }
  return id;
}

const sendErrors = (res: Response, errors: Record<string, string>, extra: Record<string, unknown> = {}) =>
  res.status(400).json({ error: Object.values(errors)[0], errors, ...extra });

type Live = Awaited<ReturnType<DeviceCollector['getReverseProxy']>>;

async function readLive(id: number): Promise<{ device: DeviceRow; live: Live } | { status: number; error: string }> {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return { status: 404, error: 'Device not found' };
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    return { device, live: await c.getReverseProxy() };
  } catch (err) {
    const msg = (err as Error).message;
    return /no such command/i.test(msg)
      ? { status: 409, error: `This device has no reverse proxy. It needs RouterOS ${REVERSE_PROXY_MIN_VERSION} or later, and isn't available on SMIPS.` }
      : { status: 502, error: `Couldn't read the device: ${msg}` };
  } finally {
    c.disconnect();
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** GET /reverse-proxy: every device in the site, its rules and services from the slow poll. */
router.get('/', async (req, res) => {
  const scope = siteScopeDevices(activeSite(req), 'd');
  const devices = await query<{
    id: number; name: string; status: string; device_type: string; model: string | null; ros_version: string | null; architecture: string | null;
  }>(`SELECT d.id, d.name, d.status, d.device_type, d.model, d.ros_version, d.architecture FROM devices d
       ${scope ? `WHERE ${scope}` : ''} ORDER BY d.name`);
  const ids = devices.map((d) => d.id);
  const [services, rules, certs, managed] = ids.length ? await Promise.all([
    query<{ device_id: number; port: number | null; certificate: string | null; disabled: boolean; invalid: boolean; www_ssl_port: number | null; www_ssl_disabled: boolean; updated_at: string }>(
      `SELECT * FROM reverse_proxy_service WHERE device_id = ANY($1::int[])`, [ids]),
    query<{ device_id: number; rule_id: string; sni: string; ip_address: string | null; port: number | null; certificate: string | null; vrf: string | null; comment: string | null; disabled: boolean; dynamic: boolean }>(
      `SELECT * FROM reverse_proxy_rules WHERE device_id = ANY($1::int[]) ORDER BY sni`, [ids]),
    query<{ device_id: number; name: string; invalid_after: string | null }>(
      `SELECT device_id, name, invalid_after FROM device_certificates WHERE device_id = ANY($1::int[])`, [ids]),
    query<ProxyCertRow>(`SELECT * FROM proxy_certs WHERE device_id = ANY($1::int[])`, [ids]),
  ]) : [[], [], [], []];
  const expiry = new Map(certs.map((c) => [`${c.device_id}\u0000${c.name}`, c.invalid_after]));
  res.json({
    min_version: REVERSE_PROXY_MIN_VERSION,
    devices: devices.map((d) => {
      const svc = services.find((s) => s.device_id === d.id) ?? null;
      const clash = !!svc && portClash({ port: svc.port, certificate: svc.certificate, disabled: svc.disabled, invalid: svc.invalid,
        wwwSslPort: svc.www_ssl_port, wwwSslDisabled: svc.www_ssl_disabled });
      const mine = managed.filter((m) => m.device_id === d.id);
      return {
        ...d,
        support: reverseProxySupport(d.ros_version, d.architecture),
        service: svc,
        clash,
        rules: rules.filter((r) => r.device_id === d.id).map((r) => {
          const cert = r.certificate ?? svc?.certificate ?? null;
          return {
            ...r,
            effective_certificate: cert,
            certificate_expires: cert ? expiry.get(`${d.id}\u0000${cert}`) ?? null : null,
            managed: mine.some((m) => m.sni === r.sni && m.cert_name === r.certificate),
          };
        }),
        managed_certs: mine.map((m) => ({ sni: m.sni, cert_name: m.cert_name, not_after: m.not_after, last_error: m.last_error })),
      };
    }),
  });
});

/** GET /reverse-proxy/device?deviceId=: read live, for editing. */
router.get('/device', async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const svc = serviceFrom(r.live.services);
  const managed = await query<ProxyCertRow>(`SELECT * FROM proxy_certs WHERE device_id = $1`, [id]);
  const ca = await queryOne<{ id: number }>(`SELECT id FROM device_ca WHERE id = 1`).catch(() => null);
  return res.json({
    device: { id: r.device.id, name: r.device.name, status: r.device.status },
    rules: rulesFrom(r.live.rules),
    service: svc,
    clash: portClash(svc),
    services: r.live.services.filter((s) => s.name).map((s) => ({ id: s['.id'], name: s.name, port: Number(s.port) || null, disabled: s.disabled === 'true' })),
    certificates: certsFrom(r.live.certs).filter((c) => c.privateKey),
    vrfs: r.live.vrfs,
    managed_certs: managed.map((m) => ({ sni: m.sni, cert_name: m.cert_name, not_after: m.not_after, last_error: m.last_error })),
    ca_ready: !!ca,
  });
});

// ─── Rules ───────────────────────────────────────────────────────────────────

interface Fix { service: 'www-ssl' | 'reverse-proxy'; port: number }

/**
 * After this write the proxy has an enabled rule, so its port opens. When
 * WebFig's HTTPS is on the same port one of them can't listen: the user
 * chooses which moves (`fix`), or the write is refused with the choice.
 */
function clashCheck(res: Response, live: Live, rulesAfter: ProxyRule[], fix: unknown): { ok: true; fix: Fix | null } | { ok: false } {
  const svc = serviceFrom(live.services);
  const active = rulesAfter.some((r) => !r.disabled);
  if (!active || !portClash(svc)) return { ok: true, fix: null };
  const f = fix as Partial<Fix> | undefined;
  if (!f || (f.service !== 'www-ssl' && f.service !== 'reverse-proxy')) {
    res.status(409).json({
      error: `WebFig over HTTPS (www-ssl) and the reverse proxy both use port ${svc.port}, so one of them couldn't listen. Move one of them to another port.`,
      clash: { port: svc.port },
    });
    return { ok: false };
  }
  const e = movePortError(live.services, f.service, f.port);
  if (e) { sendErrors(res, { fix: e }, { clash: { port: svc.port } }); return { ok: false }; }
  return { ok: true, fix: { service: f.service, port: Number(f.port) } };
}

const serviceId = (live: Live, name: string) =>
  (live.services.filter((s) => s.name === name).find((s) => s.disabled !== 'true') ?? live.services.find((s) => s.name === name))?.['.id'];

async function applyFix(c: DeviceCollector, live: Live, fix: Fix | null): Promise<void> {
  if (!fix) return;
  const sid = serviceId(live, fix.service);
  if (!sid) throw new Error(`The device has no ${fix.service} service.`);
  await c.setServicePort(sid, fix.port);
}

const fixSummary = (fix: Fix | null) => (fix ? `; ${fix.service === 'www-ssl' ? 'WebFig HTTPS' : 'reverse proxy'} moved to port ${fix.port}` : '');

/** One enabled rule per host name: RouterOS would use the first, silently. */
function duplicateSni(rules: ProxyRule[], sni: string, exceptId?: string): ProxyRule | undefined {
  return rules.find((r) => r.sni === sni && r.id !== exceptId && !r.disabled);
}

// POST /reverse-proxy/rule?deviceId=
router.post('/rule', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const rules = rulesFrom(r.live.rules);
  const body = { certificate: 'none', ...(req.body ?? {}) };
  const chk = checkRule(body, { certs: certsFrom(r.live.certs), vrfs: r.live.vrfs });
  if (Object.keys(chk.errors).length) return sendErrors(res, chk.errors);
  const enabled = chk.params.disabled !== 'yes';
  const dup = enabled ? duplicateSni(rules, chk.params.sni) : undefined;
  if (dup) return sendErrors(res, { sni: `There's already a rule for ${dup.sni}${dup.dynamic ? ' (a container app\'s)' : ''}.` });
  const clash = clashCheck(res, r.live, [...rules, { id: 'new', sni: chk.params.sni, ipAddress: null, port: null, certificate: null, vrf: null, comment: null, disabled: !enabled, dynamic: false }], req.body?.fix);
  if (!clash.ok) return;
  await withGuardedChange(id, req, res,
    { kind: 'reverse-proxy.add', summary: `Add reverse proxy rule for ${chk.params.sni}${fixSummary(clash.fix)}` },
    async (c) => { await applyFix(c, r.live, clash.fix); await c.addReverseProxyRule(chk.params); return { success: true }; },
    async (c) => { await c.collectReverseProxy(); });
});

/** The rule a request names, checked against the host name the page showed: ids can be reused. */
function ruleFor(res: Response, rules: ProxyRule[], id: string, sni: unknown): ProxyRule | null {
  const rule = rules.find((r) => r.id === id);
  if (!rule || (typeof sni === 'string' && sni && rule.sni !== sni)) {
    res.status(409).json({ error: 'That rule has changed on the device since the page was loaded. Refresh and try again.' });
    return null;
  }
  if (rule.dynamic) {
    res.status(409).json({ error: `The rule for ${rule.sni} belongs to a container app. Change it in the app's settings.` });
    return null;
  }
  return rule;
}

// PUT /reverse-proxy/rule/:id?deviceId=&sni=
router.put('/rule/:id', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const rules = rulesFrom(r.live.rules);
  const existing = ruleFor(res, rules, req.params.id, req.query.sni); if (!existing) return;
  const chk = checkRule(req.body ?? {}, { certs: certsFrom(r.live.certs), vrfs: r.live.vrfs, existing });
  if (Object.keys(chk.errors).length) return sendErrors(res, chk.errors);
  // A new name with the certificate kept: it has to cover the new name too.
  if (chk.params.sni && !('certificate' in chk.params) && existing.certificate) {
    const cert = certsFrom(r.live.certs).find((x) => x.name === existing.certificate);
    if (cert && !certCovers(chk.params.sni, cert.commonName, cert.subjectAltName)) {
      return sendErrors(res, { certificate: `${cert.name} isn't for ${chk.params.sni}. Choose another certificate.` });
    }
  }
  if (!Object.keys(chk.params).length) return res.json({ success: true, unchanged: true });
  const after: ProxyRule = { ...existing, sni: chk.params.sni ?? existing.sni,
    disabled: chk.params.disabled ? chk.params.disabled === 'yes' : existing.disabled };
  if (!after.disabled) {
    const dup = duplicateSni(rules, after.sni, existing.id);
    if (dup) return sendErrors(res, { sni: `There's already a rule for ${dup.sni}.` });
  }
  const clash = clashCheck(res, r.live, rules.map((x) => (x.id === existing.id ? after : x)), req.body?.fix);
  if (!clash.ok) return;
  await withGuardedChange(id, req, res,
    { kind: 'reverse-proxy.set', summary: `Edit reverse proxy rule for ${existing.sni}${fixSummary(clash.fix)}` },
    async (c) => { await applyFix(c, r.live, clash.fix); await c.setReverseProxyRule(existing.id, chk.params); return { success: true }; },
    async (c) => { await c.collectReverseProxy(); });
});

// DELETE /reverse-proxy/rule/:id?deviceId=&sni=
router.delete('/rule/:id', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const existing = ruleFor(res, rulesFrom(r.live.rules), req.params.id, req.query.sni); if (!existing) return;
  await withGuardedChange(id, req, res, { kind: 'reverse-proxy.remove', summary: `Delete reverse proxy rule for ${existing.sni}` },
    async (c) => { await c.removeReverseProxyRule(existing.id); return { success: true }; },
    async (c) => { await c.collectReverseProxy(); });
});

// PUT /reverse-proxy/service?deviceId= { service: 'www-ssl' | 'reverse-proxy', port }
router.put('/service', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const service = req.body?.service;
  if (service !== 'www-ssl' && service !== 'reverse-proxy') return sendErrors(res, { service: 'Choose www-ssl or reverse-proxy.' });
  const e = movePortError(r.live.services, service, req.body?.port, rulesFrom(r.live.rules).some((x) => !x.disabled));
  if (e) return sendErrors(res, { port: e });
  const fix: Fix = { service, port: Number(req.body.port) };
  await withGuardedChange(id, req, res, { kind: 'service.port', summary: `Move ${service === 'www-ssl' ? 'WebFig HTTPS' : 'the reverse proxy'} to port ${fix.port}` },
    async (c) => { await applyFix(c, r.live, fix); return { success: true }; },
    async (c) => { await c.collectReverseProxy(); });
});

// ─── Certificates from the manager's CA ──────────────────────────────────────

async function refresh(id: number): Promise<void> {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
  if (!device) return;
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    await c.collectReverseProxy();
    await c.collectCertificates();
  } catch { /* the next poll catches up */ } finally {
    c.disconnect();
  }
}

// POST /reverse-proxy/cert?deviceId= { sni, days? }
router.post('/cert', requireAdmin, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const days = req.body?.days === undefined || req.body?.days === '' ? undefined : Number(req.body.days);
  try {
    const out = await issueProxyCert(id, String(req.body?.sni ?? ''), { days });
    await refresh(id);
    return res.json(out);
  } catch (e) {
    if (e instanceof PkiError) return res.status(400).json({ error: e.message });
    return res.status(502).json({ error: (e as Error).message });
  }
});

// DELETE /reverse-proxy/cert?deviceId=&sni=[&forget=1]
router.delete('/cert', requireAdmin, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  try {
    const out = await removeProxyCert(id, String(req.query.sni ?? ''), req.query.forget === '1');
    await refresh(id);
    return res.json(out);
  } catch (e) {
    if (e instanceof PkiError) return res.status(400).json({ error: e.message });
    return res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
