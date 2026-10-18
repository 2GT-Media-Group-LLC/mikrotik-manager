/**
 * Operations → Certificates: the manager's CA and the device certificates it
 * issues (#200). Fleet admins only; listing follows the site switcher.
 */
import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeDevices } from '../utils/siteScope';
import { caInfo, PkiError } from '../utils/pki';
import {
  loadCa, setUpCa, importExistingCa, deleteCa, updateSettings, issueCertificate, removeCertificate,
  CA_DAY_CHOICES, MIN_DAYS, MAX_DEVICE_DAYS,
} from '../services/deviceCa';
import { logSafe } from '../utils/logSafe';

const router = Router();
router.use(requireAuth, requireAdmin);

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

function handle(res: Response, e: unknown): void {
  if (e instanceof PkiError) { fail(res, 400, e.message); return; }
  console.error('[device-certs]', logSafe((e as Error).message));
  fail(res, 502, (e as Error).message || 'The device couldn\'t be reached.');
}

export type DeviceCertStatus = 'not_issued' | 'valid' | 'renewal_due' | 'expired' | 'renewal_failed';

// GET / — the CA, its settings, and every device in view with its certificate.
router.get('/', async (req: Request, res: Response) => {
  const ca = await loadCa();
  const scope = siteScopeDevices(activeSite(req), 'd');
  const rows = await query<{
    id: number; name: string; ip_address: string; site_name: string | null; ros_version: string | null; status: string;
    api_port: number; api_tls: boolean | null; cert_name: string | null; fingerprint: string | null; sans: string[] | null;
    extra_names: string[] | null; days: number | null; apply_www: boolean | null; not_before: string | null; not_after: string | null;
    last_error: string | null; last_attempt_at: string | null; issued_at: string | null; renewed_at: string | null;
  }>(
    `SELECT d.id, d.name, d.ip_address, s.name AS site_name, d.ros_version, d.status, d.api_port, d.api_tls,
            m.cert_name, m.fingerprint, m.sans, m.extra_names, m.days, m.apply_www, m.not_before, m.not_after,
            m.last_error, m.last_attempt_at, m.issued_at, m.renewed_at
       FROM devices d LEFT JOIN sites s ON s.id = d.site_id LEFT JOIN managed_device_certs m ON m.device_id = d.id
      ${scope ? `WHERE ${scope}` : ''} ORDER BY lower(trim(d.name))`);
  const renewBefore = ca?.renew_before_days ?? 30;
  const now = Date.now();
  const devices = rows.map((r) => {
    let status: DeviceCertStatus = 'not_issued';
    if (r.not_after) {
      const end = new Date(r.not_after).getTime();
      status = end < now ? 'expired' : r.last_error ? 'renewal_failed' : end - renewBefore * 86_400_000 < now ? 'renewal_due' : 'valid';
    }
    return { ...r, api_ssl: r.api_tls ?? r.api_port === 8729, cert_status: status };
  });
  res.json({
    ca: ca ? { ...caInfo(ca.cert_pem), imported: ca.imported, created_by: ca.created_by, created_at: ca.created_at } : null,
    settings: ca ? { default_days: ca.default_days, renew_before_days: ca.renew_before_days, auto_renew: ca.auto_renew, default_www: ca.default_www } : null,
    limits: { min_days: MIN_DAYS, max_days: MAX_DEVICE_DAYS, ca_day_choices: CA_DAY_CHOICES },
    devices,
  });
});

// POST /ca { common_name, organization?, days }
router.post('/ca', async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    await setUpCa({ commonName: String(b.common_name ?? ''), organization: b.organization ? String(b.organization) : undefined, days: Number(b.days) }, req.user?.username ?? null);
    res.status(201).json({ message: 'Certificate authority created' });
  } catch (e) { handle(res, e); }
});

// POST /ca/import { cert_pem, key_pem, passphrase? }
router.post('/ca/import', async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    if (typeof b.cert_pem !== 'string' || typeof b.key_pem !== 'string') return fail(res, 400, 'cert_pem and key_pem are required');
    if (b.cert_pem.length > 64_000 || b.key_pem.length > 64_000) return fail(res, 400, 'That is too large to be a certificate or key.');
    const warnings = await importExistingCa(b.cert_pem, b.key_pem, typeof b.passphrase === 'string' ? b.passphrase : undefined, req.user?.username ?? null);
    res.status(201).json({ message: 'Certificate authority imported', warnings });
  } catch (e) { handle(res, e); }
});

router.delete('/ca', async (_req: Request, res: Response) => {
  try { await deleteCa(); res.json({ message: 'Certificate authority deleted' }); } catch (e) { handle(res, e); }
});

// GET /ca/certificate — the public CA certificate, for browsers and tools.
router.get('/ca/certificate', async (_req: Request, res: Response) => {
  const ca = await loadCa();
  if (!ca) return fail(res, 404, 'No certificate authority is set up.');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="mikrotik-manager-ca.crt"');
  res.send(ca.cert_pem);
});

// PUT /settings { default_days?, renew_before_days?, auto_renew?, default_www? }
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const num = (v: unknown) => (v === undefined ? undefined : Number(v));
    const bool = (v: unknown) => (v === undefined ? undefined : v === true);
    await updateSettings({ default_days: num(b.default_days), renew_before_days: num(b.renew_before_days), auto_renew: bool(b.auto_renew), default_www: bool(b.default_www) });
    res.json({ message: 'Saved' });
  } catch (e) { handle(res, e); }
});

async function inScope(req: Request, id: number): Promise<boolean> {
  const scope = siteScopeDevices(activeSite(req));
  const rows = await query(`SELECT 1 FROM devices WHERE id = $1${scope ? ` AND ${scope}` : ''}`, [id]);
  return rows.length > 0;
}

// POST /devices/:id/issue { days?, extra_names?, apply_www? } — also used to reissue with new settings.
router.post('/devices/:id/issue', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !(await inScope(req, id))) return fail(res, 404, 'Device not found');
  const b = req.body ?? {};
  if (b.extra_names !== undefined && (!Array.isArray(b.extra_names) || b.extra_names.length > 20 || !b.extra_names.every((n: unknown) => typeof n === 'string'))) {
    return fail(res, 400, 'extra_names must be a list of up to 20 names');
  }
  try {
    const r = await issueCertificate(id, {
      days: b.days === undefined ? undefined : Number(b.days),
      extraNames: b.extra_names,
      applyWww: b.apply_www === undefined ? undefined : b.apply_www === true,
    });
    res.status(r.ok ? 200 : 422).json(r);
  } catch (e) { handle(res, e); }
});

router.post('/devices/:id/renew', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !(await inScope(req, id))) return fail(res, 404, 'Device not found');
  try {
    const r = await issueCertificate(id, {}, true);
    res.status(r.ok ? 200 : 422).json(r);
  } catch (e) { handle(res, e); }
});

// DELETE /devices/:id[?forget=1]
router.delete('/devices/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !(await inScope(req, id))) return fail(res, 404, 'Device not found');
  try {
    const r = await removeCertificate(id, req.query.forget === '1');
    res.status(r.ok ? 200 : 422).json(r);
  } catch (e) { handle(res, e); }
});

export default router;
