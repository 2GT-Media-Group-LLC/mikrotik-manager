import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { siteScopeByDevice } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { certExpiryState, describeCert, needsAttention, type CertState } from '../utils/certExpiry';
import { alertService } from '../services/AlertService';

const router = Router();
router.use(requireAuth);

interface CertRow {
  device_id: number;
  device_name: string;
  name: string;
  common_name: string | null;
  serial_number: string | null;
  fingerprint: string | null;
  key_type: string | null;
  key_size: number | null;
  invalid_before: string | null;
  invalid_after: string | null;
  is_authority: boolean;
  has_private_key: boolean;
  trusted: boolean;
  revoked: boolean;
  revoked_at: string | null;
  updated_at: string;
}

/**
 * GET /api/certificates — every collected certificate, with its verdict.
 *
 * The expiry state is decided here rather than in the browser, deliberately.
 * The same function and the same threshold produce the alert, the dashboard
 * item and this list, so a page cannot quietly disagree with the email that was
 * sent about the same certificate. A second implementation in the frontend
 * would drift the first time the rule changed.
 *
 * `?deviceId=` narrows it to one device, which is how the device page uses it.
 */
router.get('/', async (req: Request, res: Response) => {
  const { deviceId } = req.query as { deviceId?: string };

  const filters: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (deviceId) filters.push(`c.device_id = ${bind(parseInt(deviceId, 10))}`);
  const siteFilter = siteScopeByDevice(activeSite(req), 'c.device_id');
  if (siteFilter) filters.push(siteFilter);

  const rows = await query<CertRow>(
    `SELECT c.device_id, d.name AS device_name, c.name, c.common_name,
            c.serial_number, c.fingerprint, c.key_type, c.key_size,
            c.invalid_before, c.invalid_after, c.is_authority,
            c.has_private_key, c.trusted, c.revoked, c.revoked_at, c.updated_at
       FROM device_certificates c
       JOIN devices d ON d.id = c.device_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY c.invalid_after ASC NULLS LAST, d.name, c.name`,
    params
  );

  // The operator's own warning window, so the list agrees with what they set.
  const rule = await alertService.getRule('cert_expiry').catch(() => null);
  const warnDays = rule?.threshold ?? 14;
  const now = new Date();

  const certificates = rows.map((c) => {
    const verdict = certExpiryState(c.invalid_after, now, warnDays, c.invalid_before, {
      revoked: c.revoked,
    });
    return {
      ...c,
      state: verdict.state,
      days_left: verdict.daysLeft,
      summary: describeCert(c, verdict),
    };
  });

  const counts = certificates.reduce<Record<CertState, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {} as Record<CertState, number>);

  res.json({
    certificates,
    warnDays,
    // Counted here rather than in the browser for the same reason the state is:
    // the page's "N need attention" and the alerting rule must not be able to
    // disagree about which certificates count. A filter that re-derived it would
    // drift the moment revocation was added — which is precisely what happened.
    attentionCount: certificates.filter((c) =>
      needsAttention({ state: c.state, daysLeft: c.days_left })
    ).length,
    // Whether the rule is on decides whether anyone is actually told; the UI
    // says so rather than implying these are being watched when they are not.
    alertingEnabled: rule?.enabled ?? false,
    counts,
  });
});

export default router;
