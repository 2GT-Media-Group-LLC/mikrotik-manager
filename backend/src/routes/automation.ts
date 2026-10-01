import { seal } from '../utils/sealed';
import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin, requireWrite } from '../middleware/auth';
import { webhookService, WEBHOOK_EVENTS } from '../services/WebhookService';
import { reportService, computeNextRun } from '../services/ReportService';

const router = Router();
router.use(requireAuth);

// Linear email check — no backtracking regex (avoids ReDoS on user-supplied lists).
function isValidEmail(addr: string): boolean {
  if (/\s/.test(addr)) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@')) return false;
  const domain = addr.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

// ─── API tokens (admin only — a token can never mint more tokens) ─────────────

router.get('/tokens', requireAdmin, async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, prefix, scope, created_by, last_used_at, expires_at, created_at
     FROM api_tokens ORDER BY created_at DESC`);
  res.json(rows);
});

router.post('/tokens', requireAdmin, async (req: Request, res: Response) => {
  const { name, scope, expires_days } = req.body as { name?: string; scope?: string; expires_days?: number };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (scope !== 'read' && scope !== 'write') return res.status(400).json({ error: 'scope must be read or write' });

  const token = `mtm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const expiresAt = expires_days && expires_days > 0
    ? new Date(Date.now() + expires_days * 86_400_000).toISOString()
    : null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO api_tokens (name, token_hash, prefix, scope, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name.trim().slice(0, 100), hash, token.slice(0, 12), scope, req.user?.username ?? null, expiresAt]);

  // The full token is returned exactly once — only the hash is stored.
  res.status(201).json({ id: row!.id, token });
});

router.delete('/tokens/:id', requireAdmin, async (req: Request, res: Response) => {
  await query(`DELETE FROM api_tokens WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ─── Webhooks ──────────────────────────────────────────────────────────────────

router.get('/webhooks', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, url, (secret IS NOT NULL AND secret != '') AS has_secret,
            events, enabled, last_status, last_fired_at, created_at
     FROM webhooks ORDER BY created_at DESC`);
  res.json({ webhooks: rows, availableEvents: WEBHOOK_EVENTS });
});

router.post('/webhooks', requireWrite, async (req: Request, res: Response) => {
  const { name, url, secret, events } = req.body as { name?: string; url?: string; secret?: string; events?: string[] };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must be http(s)' });
  const evts = (Array.isArray(events) ? events : []).filter(e => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (evts.length === 0) return res.status(400).json({ error: 'subscribe to at least one event' });

  const row = await queryOne<{ id: number }>(
    `INSERT INTO webhooks (name, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING id`,
    // The signing secret is stored encrypted (S7).
    [name.trim().slice(0, 100), url.trim(), secret?.trim() ? seal(secret.trim()) : null, evts]);
  res.status(201).json({ id: row!.id });
});

router.put('/webhooks/:id', requireWrite, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { name, url, secret, events, enabled } = req.body as {
    name?: string; url?: string; secret?: string | null; events?: string[]; enabled?: boolean;
  };
  const existing = await queryOne<{ id: number }>(`SELECT id FROM webhooks WHERE id = $1`, [id]);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });

  if (url !== undefined && !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must be http(s)' });
  const evts = events !== undefined
    ? (Array.isArray(events) ? events : []).filter(e => (WEBHOOK_EVENTS as readonly string[]).includes(e))
    : undefined;
  if (evts !== undefined && evts.length === 0) return res.status(400).json({ error: 'subscribe to at least one event' });

  await query(
    `UPDATE webhooks SET
       name    = COALESCE($2, name),
       url     = COALESCE($3, url),
       secret  = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4, '') ELSE secret END,
       events  = COALESCE($5, events),
       enabled = COALESCE($6, enabled)
     WHERE id = $1`,
    [id, name?.trim().slice(0, 100) ?? null, url?.trim() ?? null,
     secret == null ? null : (secret.trim() ? seal(secret.trim()) : ''), evts ?? null, enabled ?? null]);
  res.json({ ok: true });
});

router.delete('/webhooks/:id', requireWrite, async (req: Request, res: Response) => {
  await query(`DELETE FROM webhooks WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', requireWrite, async (req: Request, res: Response) => {
  try {
    const result = await webhookService.sendTest(parseInt(req.params.id, 10));
    res.json({ ok: result.status >= 200 && result.status < 300, status: result.status });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ─── Scheduled reports ─────────────────────────────────────────────────────────

router.get('/reports', async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM report_schedules ORDER BY created_at DESC`);
  res.json(rows);
});

router.post('/reports', requireWrite, async (req: Request, res: Response) => {
  const { name, frequency, recipients } = req.body as { name?: string; frequency?: string; recipients?: string };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!['daily', 'weekly', 'monthly'].includes(frequency ?? '')) return res.status(400).json({ error: 'frequency must be daily, weekly or monthly' });
  const rcpts = (recipients ?? '').split(',').map(r => r.trim()).filter(Boolean);
  if (rcpts.length === 0 || rcpts.some(r => !isValidEmail(r))) {
    return res.status(400).json({ error: 'recipients must be comma-separated email addresses' });
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO report_schedules (name, frequency, recipients, next_run_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [name.trim().slice(0, 100), frequency, rcpts.join(', '), computeNextRun(frequency!, new Date())]);
  res.status(201).json({ id: row!.id });
});

router.put('/reports/:id', requireWrite, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { enabled } = req.body as { enabled?: boolean };
  const result = await query(
    `UPDATE report_schedules SET enabled = COALESCE($2, enabled) WHERE id = $1 RETURNING id`,
    [id, enabled ?? null]);
  if (!result.length) return res.status(404).json({ error: 'Report schedule not found' });
  res.json({ ok: true });
});

router.delete('/reports/:id', requireWrite, async (req: Request, res: Response) => {
  await query(`DELETE FROM report_schedules WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// POST /api/automation/reports/:id/send-now — immediate delivery (also validates SMTP)
router.post('/reports/:id/send-now', requireWrite, async (req: Request, res: Response) => {
  const row = await queryOne<{ name: string; frequency: 'daily' | 'weekly' | 'monthly'; recipients: string }>(
    `SELECT name, frequency, recipients FROM report_schedules WHERE id = $1`, [parseInt(req.params.id, 10)]);
  if (!row) return res.status(404).json({ error: 'Report schedule not found' });
  try {
    await reportService.send(row);
    await query(`UPDATE report_schedules SET last_sent_at = NOW() WHERE id = $1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
