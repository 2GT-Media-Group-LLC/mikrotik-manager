import { Router } from 'express';
import { query } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { alertService } from '../services/AlertService';

const router = Router();

// All alert routes require authentication
router.use(requireAuth);

// ── Default rules seed ─────────────────────────────────────────────────────

const DEFAULT_RULES = [
  { event_type: 'device_offline',    enabled: true,  threshold: null, cooldown_min: 5  },
  { event_type: 'device_online',     enabled: true,  threshold: null, cooldown_min: 5  },
  { event_type: 'log_error',         enabled: false, threshold: null, cooldown_min: 15 },
  { event_type: 'log_warning',       enabled: false, threshold: null, cooldown_min: 30 },
  { event_type: 'high_cpu',          enabled: false, threshold: 90,   cooldown_min: 30 },
  { event_type: 'high_memory',       enabled: false, threshold: 90,   cooldown_min: 30 },
  { event_type: 'cert_expiry',       enabled: false, threshold: 14,   cooldown_min: 1440 },
  { event_type: 'device_discovered',        enabled: false, threshold: null, cooldown_min: 60   },
  { event_type: 'firmware_update_available', enabled: true,  threshold: null, cooldown_min: 1440 },
  { event_type: 'config_drift',      enabled: false, threshold: null, cooldown_min: 15   },
];

async function ensureDefaultRules(): Promise<void> {
  for (const rule of DEFAULT_RULES) {
    await query(
      `INSERT INTO alert_rules (event_type, enabled, threshold, cooldown_min)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_type) DO NOTHING`,
      [rule.event_type, rule.enabled, rule.threshold, rule.cooldown_min]
    );
  }
}

// ── Alert Rules ────────────────────────────────────────────────────────────

/** GET /api/alerts/rules — list all rules (seeds defaults on first call) */
router.get('/rules', async (_req, res) => {
  await ensureDefaultRules();
  const rules = await query(
    `SELECT event_type, enabled, threshold, cooldown_min, updated_at
     FROM alert_rules ORDER BY event_type`
  );
  res.json(rules);
});

/** PUT /api/alerts/rules/:type — update a single rule */
router.put('/rules/:type', requireWrite, async (req, res) => {
  const { type } = req.params;
  const { enabled, threshold, cooldown_min } = req.body;

  const row = await alertService.upsertRule(type, {
    enabled:     enabled     !== undefined ? Boolean(enabled)         : undefined,
    threshold:   threshold   !== undefined ? (Number(threshold) || null) : undefined,
    cooldown_min: cooldown_min !== undefined ? Number(cooldown_min)    : undefined,
  });
  res.json(row);
});

// ── Alert Channels ─────────────────────────────────────────────────────────

/** GET /api/alerts/channels */
router.get('/channels', async (_req, res) => {
  const channels = await query(
    `SELECT id, name, type, enabled, config, created_at, updated_at
     FROM alert_channels ORDER BY id`
  );
  // Mask sensitive fields before returning
  const masked = channels.map((ch: Record<string, unknown>) => ({
    ...ch,
    config: maskConfig(ch.type as string, ch.config as Record<string, unknown>),
  }));
  res.json(masked);
});

/** POST /api/alerts/channels */
router.post('/channels', requireWrite, async (req, res) => {
  const { name, type, enabled = true, config = {} } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  const validTypes = ['email', 'slack', 'discord', 'telegram', 'ntfy'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const rows = await query(
    `INSERT INTO alert_channels (name, type, enabled, config)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, type, Boolean(enabled), JSON.stringify(config)]
  );
  const ch = rows[0] as Record<string, unknown>;
  res.status(201).json({
    ...ch,
    config: maskConfig(type, config),
  });
});

/** PUT /api/alerts/channels/:id */
router.put('/channels/:id', requireWrite, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, enabled, config } = req.body;

  // Fetch existing so we can merge config (preserve masked/unchanged fields)
  const existing = await query<{ config: Record<string, unknown>; type: string }>(
    `SELECT config, type FROM alert_channels WHERE id = $1`,
    [id]
  );
  if (!existing[0]) return res.status(404).json({ error: 'Channel not found' });

  const existingConfig = existing[0].config as Record<string, unknown>;
  const type           = existing[0].type;

  // Merge new config over existing, preserving existing passwords when placeholders sent
  const mergedConfig = mergeConfig(type, existingConfig, config ?? {});

  const rows = await query(
    `UPDATE alert_channels
     SET name = COALESCE($2, name),
         enabled = COALESCE($3, enabled),
         config = $4,
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, enabled !== undefined ? Boolean(enabled) : null, JSON.stringify(mergedConfig)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Channel not found' });

  const ch = rows[0] as Record<string, unknown>;
  res.json({ ...ch, config: maskConfig(type, mergedConfig) });
});

/** DELETE /api/alerts/channels/:id */
router.delete('/channels/:id', requireWrite, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query(`DELETE FROM alert_channels WHERE id = $1`, [id]);
  res.status(204).end();
});

/** POST /api/alerts/channels/:id/test */
router.post('/channels/:id/test', requireWrite, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await alertService.testChannel(id);
    res.json({ message: 'Test alert sent successfully' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Alert History ──────────────────────────────────────────────────────────

/** GET /api/alerts/history?limit=50 */
router.get('/history', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? 50), 10), 200);
  const rows = await query(
    `SELECT h.id, h.event_type, h.device_id, h.device_name, h.message,
            h.channels_notified, h.sent_at
     FROM alert_history h
     ORDER BY h.sent_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

// ── Helpers ────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS: Record<string, string[]> = {
  email:    ['smtp_pass'],
  slack:    [],
  discord:  [],
  telegram: ['bot_token'],
  // ntfy accepts either an access token or basic auth; both are secrets.
  ntfy:     ['token', 'password'],
};

function maskConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (masked[key]) masked[key] = '••••••••';
  }
  return masked;
}

/** When updating, if a sensitive field comes back as the mask placeholder, keep the original. */
function mergeConfig(
  type: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existing, ...incoming };
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (incoming[key] === '••••••••') {
      merged[key] = existing[key]; // restore original
    }
  }
  return merged;
}

export default router;
