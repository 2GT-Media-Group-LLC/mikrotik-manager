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
  certCovers, type ProxyRule, acmeCertName, acmeNameError, acmeCertsFrom, isAcmeName, LE_PRODUCTION, LE_STAGING, type AcmeCert,
} from '../utils/reverseProxy';
import { promises as dns } from 'dns';
import { previewContext } from '../utils/previewContext';

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
    query<{ device_id: number; name: string; invalid_after: string | null; acme_managed: boolean; acme_status: string | null; acme_directory: string | null }>(
      `SELECT device_id, name, invalid_after, acme_managed, acme_status, acme_directory FROM device_certificates WHERE device_id = ANY($1::int[])`, [ids]),
    query<ProxyCertRow>(`SELECT * FROM proxy_certs WHERE device_id = ANY($1::int[])`, [ids]),
  ]) : [[], [], [], []];
  const expiry = new Map(certs.map((c) => [`${c.device_id}\u0000${c.name}`, c.invalid_after]));
  const acmeOf = new Map(certs.filter((c) => c.acme_managed).map((c) => [`${c.device_id}\u0000${c.name}`, c]));
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
            acme: (() => {
              const a = cert ? acmeOf.get(`${d.id}\u0000${cert}`) : undefined;
              if (!a) return null;
              const issued = !!a.invalid_after;
              const failed = !issued && /fail|error|invalid|denied|unauthori[sz]ed|rejected/i.test(a.acme_status ?? '');
              return { staging: /staging/i.test(a.acme_directory ?? ''), phase: issued ? 'issued' : failed ? 'failed' : 'pending', status: a.acme_status };
            })(),
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
    acme: acmeCertsFrom(r.live.certs),
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

/**
 * A Let's Encrypt choice on a rule (`acme: { staging }` instead of a
 * certificate): the certificate's name, or the errors to show. Its request is
 * made by ensureAcme inside the same guarded change.
 */
function acmeChoice(body: Record<string, unknown>, sni: string): { name: string; staging: boolean } | { errors: Record<string, string> } | null {
  const a = body.acme as { staging?: unknown } | undefined;
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || typeof a.staging !== 'boolean') return { errors: { certificate: 'acme must be { staging: true | false }.' } };
  if ('certificate' in body && body.certificate !== undefined && body.certificate !== '') {
    return { errors: { certificate: 'Choose a certificate or Let\'s Encrypt, not both.' } };
  }
  const bad = acmeNameError(sni);
  if (bad) return { errors: { sni: bad } };
  return { name: acmeCertName(sni, a.staging), staging: a.staging };
}

/** How long a new ACME certificate takes to appear: RouterOS creates the entry after add-acme returns. */
const ACME_APPEAR_MS = 20_000;

/**
 * Request the certificate unless the device has it. One that failed is
 * removed and requested again: RouterOS doesn't retry a failed first request.
 * Returns whether a request was made, so a later failure can take it back.
 *
 * RouterOS creates the certificate entry a moment after add-acme returns, and
 * a rule naming it before then is refused ("input does not match any value of
 * certificate"), so this waits for it to appear. Not in a preview: nothing is
 * sent there.
 */
async function ensureAcme(c: DeviceCollector, existing: AcmeCert[], choice: { name: string; staging: boolean }, sni: string): Promise<boolean> {
  const have = existing.find((x) => x.name === choice.name);
  if (have && have.phase !== 'failed') return false;
  if (have) await c.removeCertificateById(have.id);
  await c.addAcmeCertificate(choice.name, sni, choice.staging ? LE_STAGING : LE_PRODUCTION);
  if (previewContext()) return true;
  const until = Date.now() + ACME_APPEAR_MS;
  for (;;) {
    const live = await c.getReverseProxy();
    if (acmeCertsFrom(live.certs).some((x) => x.name === choice.name)) return true;
    if (Date.now() > until) throw new Error(`RouterOS didn't create the certificate ${choice.name} within ${ACME_APPEAR_MS / 1000} seconds.`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Take back a request made in a change that then failed. Best effort: one mid-request can't be removed yet. */
async function dropNewAcme(c: DeviceCollector, name: string): Promise<void> {
  try {
    const cert = acmeCertsFrom((await c.getReverseProxy()).certs).find((x) => x.name === name);
    if (cert) await c.removeCertificateById(cert.id);
  } catch { /* RouterOS keeps it until the request ends; the page lists it */ }
}

/** After a rule moves off an ACME certificate, or is deleted: remove it when nothing else uses it. */
async function dropUnusedAcme(c: DeviceCollector, name: string | null): Promise<string | null> {
  if (!name || !isAcmeName(name)) return null;
  try {
    const live = await c.getReverseProxy();
    if (rulesFrom(live.rules).some((r) => r.certificate === name)) return null;
    if (serviceFrom(live.services).certificate === name || live.services.some((s) => s.certificate === name)) return null;
    const cert = acmeCertsFrom(live.certs).find((x) => x.name === name);
    if (cert) await c.removeCertificateById(cert.id);
    return null;
  } catch (e) {
    // RouterOS won't remove one mid-request ("acme update is in progress"); it stays until a reboot.
    return `The old certificate ${name} couldn't be removed (${(e as Error).message}). Remove it later, under System → Certificates on the device.`;
  }
}

// POST /reverse-proxy/rule?deviceId=
router.post('/rule', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const rules = rulesFrom(r.live.rules);
  const raw = { ...(req.body ?? {}) } as Record<string, unknown>;
  const acme = acmeChoice(raw, String(raw.sni ?? ''));
  if (acme && 'errors' in acme) return sendErrors(res, acme.errors);
  const body: Record<string, unknown> = acme ? { ...raw } : { certificate: 'none', ...raw };
  delete body.acme;
  if (acme) delete body.certificate;
  const chk = checkRule(body, { certs: certsFrom(r.live.certs), vrfs: r.live.vrfs });
  if (Object.keys(chk.errors).length) return sendErrors(res, chk.errors);
  if (acme) chk.params.certificate = acme.name;
  const enabled = chk.params.disabled !== 'yes';
  const dup = enabled ? duplicateSni(rules, chk.params.sni) : undefined;
  if (dup) return sendErrors(res, { sni: `There's already a rule for ${dup.sni}${dup.dynamic ? ' (a container app\'s)' : ''}.` });
  const clash = clashCheck(res, r.live, [...rules, { id: 'new', sni: chk.params.sni, ipAddress: null, port: null, certificate: null, vrf: null, comment: null, disabled: !enabled, dynamic: false }], req.body?.fix);
  if (!clash.ok) return;
  await withGuardedChange(id, req, res,
    { kind: 'reverse-proxy.add', summary: `Add reverse proxy rule for ${chk.params.sni}${acme ? ` with a Let's Encrypt${acme.staging ? ' staging' : ''} certificate` : ''}${fixSummary(clash.fix)}` },
    async (c) => {
      // The certificate first: if RouterOS refuses it, nothing else has changed.
      const requested = acme ? await ensureAcme(c, acmeCertsFrom(r.live.certs), acme, chk.params.sni) : false;
      try {
        await applyFix(c, r.live, clash.fix);
        await c.addReverseProxyRule(chk.params);
      } catch (e) {
        if (requested && acme) await dropNewAcme(c, acme.name);
        throw e;
      }
      return { success: true };
    },
    async (c) => { await c.collectReverseProxy(); if (acme) await c.collectCertificates(); });
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
  const raw = { ...(req.body ?? {}) } as Record<string, unknown>;
  const acme = acmeChoice(raw, String(raw.sni ?? existing.sni));
  if (acme && 'errors' in acme) return sendErrors(res, acme.errors);
  delete raw.acme;
  const chk = checkRule(raw, { certs: certsFrom(r.live.certs), vrfs: r.live.vrfs, existing });
  if (Object.keys(chk.errors).length) return sendErrors(res, chk.errors);
  // Choosing Let's Encrypt again for the same name: a failed request is retried.
  const acmeCerts = acmeCertsFrom(r.live.certs);
  const retry = !!acme && acme.name === existing.certificate && acmeCerts.some((x) => x.name === acme.name && x.phase === 'failed');
  if (acme && (acme.name !== existing.certificate || retry)) chk.params.certificate = acme.name;
  // A new name with the certificate kept: it has to cover the new name too.
  if (chk.params.sni && !('certificate' in chk.params) && existing.certificate && isAcmeName(existing.certificate) && !acme) {
    return sendErrors(res, { certificate: `The Let's Encrypt certificate is for ${existing.sni}. Choose Let's Encrypt again to request one for ${chk.params.sni}.` });
  }
  if (chk.params.sni && !('certificate' in chk.params) && existing.certificate) {
    const cert = certsFrom(r.live.certs).find((x) => x.name === existing.certificate);
    if (cert && !certCovers(chk.params.sni, cert.commonName, cert.subjectAltName)) {
      return sendErrors(res, { certificate: `${cert.name} isn't for ${chk.params.sni}. Choose another certificate.` });
    }
  }
  if (!Object.keys(chk.params).length && !retry) return res.json({ success: true, unchanged: true });
  const after: ProxyRule = { ...existing, sni: chk.params.sni ?? existing.sni,
    disabled: chk.params.disabled ? chk.params.disabled === 'yes' : existing.disabled };
  if (!after.disabled) {
    const dup = duplicateSni(rules, after.sni, existing.id);
    if (dup) return sendErrors(res, { sni: `There's already a rule for ${dup.sni}.` });
  }
  const clash = clashCheck(res, r.live, rules.map((x) => (x.id === existing.id ? after : x)), req.body?.fix);
  if (!clash.ok) return;
  await withGuardedChange(id, req, res,
    { kind: 'reverse-proxy.set', summary: `${retry ? 'Retry the Let\'s Encrypt certificate for' : 'Edit reverse proxy rule for'} ${existing.sni}${fixSummary(clash.fix)}` },
    async (c) => {
      let requested = false;
      if (acme) {
        // The failed certificate is removed and requested again; the rule lets go of it first.
        if (retry) await c.setReverseProxyRule(existing.id, { certificate: 'none' });
        requested = await ensureAcme(c, acmeCerts, acme, chk.params.sni ?? existing.sni);
      }
      try {
        await applyFix(c, r.live, clash.fix);
        if (Object.keys(chk.params).length) await c.setReverseProxyRule(existing.id, chk.params);
      } catch (e) {
        // A new certificate the rule never took: take it back (not a retried one, the rule still names it).
        if (requested && acme && !retry) await dropNewAcme(c, acme.name);
        throw e;
      }
      // The certificate it used before, when it was a Let's Encrypt one nothing else uses.
      const warning = chk.params.certificate && chk.params.certificate !== existing.certificate
        ? await dropUnusedAcme(c, existing.certificate) : null;
      return { success: true, ...(warning ? { warning } : {}) };
    },
    async (c) => { await c.collectReverseProxy(); if (acme) await c.collectCertificates(); });
});

// DELETE /reverse-proxy/rule/:id?deviceId=&sni=
router.delete('/rule/:id', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const existing = ruleFor(res, rulesFrom(r.live.rules), req.params.id, req.query.sni); if (!existing) return;
  await withGuardedChange(id, req, res, { kind: 'reverse-proxy.remove', summary: `Delete reverse proxy rule for ${existing.sni}` },
    async (c) => {
      await c.removeReverseProxyRule(existing.id);
      const warning = await dropUnusedAcme(c, existing.certificate);
      return { success: true, ...(warning ? { warning } : {}) };
    },
    async (c) => { await c.collectReverseProxy(); });
});

// POST /reverse-proxy/acme/renew?deviceId= { name }: ask RouterOS to renew a Let's Encrypt certificate now.
router.post('/acme/renew', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const r = await readLive(id);
  if ('status' in r) return res.status(r.status).json({ error: r.error });
  const cert = acmeCertsFrom(r.live.certs).find((x) => x.name === String(req.body?.name ?? ''));
  if (!cert) return res.status(404).json({ error: 'That Let\'s Encrypt certificate isn\'t on the device any more. Refresh the page.' });
  if (cert.phase !== 'issued') return res.status(409).json({ error: 'It hasn\'t been issued yet. To retry a failed request, choose Let\'s Encrypt on the rule again.' });
  const c = new DeviceCollector(r.device);
  try {
    await c.connect();
    await c.renewAcmeCertificate(cert.id);
    return res.json({ success: true, message: `RouterOS is renewing ${cert.name}. Its status shows here within a minute.` });
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  } finally {
    c.disconnect();
  }
});

/**
 * GET /reverse-proxy/dns?name=: what the name resolves to from the manager,
 * so the form can warn before Let's Encrypt fails on it. Public resolution
 * is what counts; this is only a hint.
 */
router.get('/dns', requireWrite, async (req, res) => {
  const name = String(req.query.name ?? '');
  if (acmeNameError(name)) return res.json({ name, addresses: [], error: 'not a public name' });
  try {
    const r = await dns.lookup(name, { all: true });
    return res.json({ name, addresses: [...new Set(r.map((a) => a.address))].slice(0, 8) });
  } catch (e) {
    return res.json({ name, addresses: [], error: (e as { code?: string }).code === 'ENOTFOUND' ? 'not found' : (e as Error).message });
  }
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
