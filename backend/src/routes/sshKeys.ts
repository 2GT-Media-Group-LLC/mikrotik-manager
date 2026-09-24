import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { siteScopeDevices } from '../utils/siteScope';
import { activeSite } from '../middleware/site';
import { classifyKeyTarget } from '../utils/sshKeyCredentials';
import { SSH_TARGET_COLS, type SshTarget } from '../services/SshKeyService';
import {
  enqueueFleetKeyJob, getFleetKeyJob, cancelFleetKeyJob, initFleetKeyJob, HALT_AFTER,
} from '../services/SshKeyFleetWorker';

/**
 * Fleet-wide SSH key deployment: preview, then run as a background job.
 *
 * Admin only. Installing a key turns off password SSH for that user on the
 * device, and this does it across a whole site in one go.
 */
const router = Router();
router.use(requireAuth, requireAdmin);

const MAX_DEVICES = 2000;

function parseIds(v: unknown): number[] | null {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const ids = list.map((x) => Number(x));
  return ids.every((n) => Number.isInteger(n) && n > 0) ? [...new Set(ids)] : null;
}

// GET /api/ssh-keys/fleet/preview?tag_ids=1,2 — what a run would do, in the active site
router.get('/fleet/preview', async (req: Request, res: Response) => {
  const tagIds = parseIds(req.query.tag_ids);
  if (!tagIds) return res.status(400).json({ error: 'tag_ids must be a list of tag ids' });

  const siteFilter = siteScopeDevices(activeSite(req));
  const params: unknown[] = [];
  let tagFilter = '';
  if (tagIds.length) {
    params.push(tagIds);
    tagFilter = `AND EXISTS (SELECT 1 FROM device_tags dt WHERE dt.device_id = devices.id AND dt.tag_id = ANY($1::int[]))`;
  }
  const rows = await query<SshTarget & { status: string; has_verified_key: boolean }>(
    `SELECT ${SSH_TARGET_COLS}, status,
            EXISTS (SELECT 1 FROM device_ssh_keys k WHERE k.device_id = devices.id AND k.status = 'verified')
              AS has_verified_key
       FROM devices
      WHERE status != 'disabled' ${siteFilter ? `AND ${siteFilter}` : ''} ${tagFilter}
      ORDER BY name`,
    params
  );

  const eligible: { id: number; name: string; ip_address: string; username: string; source: 'ssh' | 'api' }[] = [];
  const keyed: { id: number; name: string }[] = [];
  const skipped: { id: number; name: string; reason: string }[] = [];
  for (const r of rows) {
    const c = classifyKeyTarget(r);
    if (c.kind === 'eligible') eligible.push({ id: r.id, name: r.name, ip_address: r.ip_address, username: c.username, source: c.source });
    else if (c.kind === 'keyed') keyed.push({ id: r.id, name: r.name });
    else skipped.push({ id: r.id, name: r.name, reason: c.reason });
  }

  // Which accounts lose password SSH, and how many devices each. This is the
  // number the confirmation is really about.
  const accounts = new Map<string, { username: string; devices: number; via_api_login: number }>();
  for (const e of eligible) {
    const a = accounts.get(e.username) ?? { username: e.username, devices: 0, via_api_login: 0 };
    a.devices++;
    if (e.source === 'api') a.via_api_login++;
    accounts.set(e.username, a);
  }

  return res.json({ eligible, keyed, skipped, accounts: [...accounts.values()], halt_after: HALT_AFTER });
});

// POST /api/ssh-keys/fleet/jobs { device_ids, confirm: true }
router.post('/fleet/jobs', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { device_ids?: unknown; confirm?: unknown };
  if (body.confirm !== true) {
    return res.status(400).json({
      error: 'Confirmation required. Installing a key turns off password SSH for that user on each ' +
             'device; the API and WinBox are unaffected. Repeat with "confirm": true.',
    });
  }
  const ids = parseIds(body.device_ids);
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'device_ids must be a non-empty list of device ids' });
  if (ids.length > MAX_DEVICES) return res.status(400).json({ error: `At most ${MAX_DEVICES} devices per run` });

  // Only devices in the site being viewed, in name order. Eligibility is
  // re-checked per device when the job reaches it.
  const siteFilter = siteScopeDevices(activeSite(req));
  const scoped = await query<{ id: number }>(
    `SELECT id FROM devices WHERE id = ANY($1::int[]) ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`,
    [ids]
  );
  if (!scoped.length) return res.status(400).json({ error: 'None of those devices are in the current site' });

  const jobId = randomUUID();
  const user = req.user!;
  await initFleetKeyJob(jobId, scoped.length, user.userId);
  await enqueueFleetKeyJob({
    jobId, deviceIds: scoped.map((r) => r.id), userId: user.userId, username: user.username ?? null,
  });
  return res.status(202).json({ job_id: jobId, total: scoped.length });
});

// GET /api/ssh-keys/fleet/jobs/:jobId
router.get('/fleet/jobs/:jobId', async (req: Request, res: Response) => {
  const job = await getFleetKeyJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  return res.json({ job_id: req.params.jobId, ...job.meta, results: job.results });
});

// POST /api/ssh-keys/fleet/jobs/:jobId/cancel — stops before the next device
router.post('/fleet/jobs/:jobId/cancel', async (req: Request, res: Response) => {
  const job = await getFleetKeyJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  await cancelFleetKeyJob(req.params.jobId);
  return res.json({ message: 'Cancel requested. The device in progress finishes first.' });
});

export default router;
