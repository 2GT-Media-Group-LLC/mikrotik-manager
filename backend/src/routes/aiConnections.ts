import { Router } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin, fleetOnly } from '../middleware/auth';
import { loadAiSettings, maskedAiSettings, oauthSecret, saveAiSettings, isCanonicalHttps, type AiSettings } from '../services/mcp/settings';
import { testOauthProvider } from '../services/mcp/auth';
import { newReviewToken, REVIEW_SCOPE } from '../services/mcp/tokens';

/**
 * Settings → AI Connections. Admins with fleet-wide access only: these open
 * read access to the whole fleet's review data to outside tools.
 */
const router = Router();
router.use(requireAuth, requireAdmin, fleetOnly);

router.get('/config', async (_req, res) => {
  res.json(maskedAiSettings(await loadAiSettings()));
});

router.put('/config', async (req, res) => {
  const body = (req.body ?? {}) as Partial<AiSettings> & { oauth_client_secret?: unknown };
  const secret = body.oauth_client_secret;
  if (secret !== undefined && typeof secret !== 'string') return res.status(400).json({ error: 'oauth_client_secret must be text.' });
  const saved = await saveAiSettings(body, secret === '' ? undefined : secret);
  if ('error' in saved) return res.status(400).json({ error: saved.error });
  return res.json(maskedAiSettings(saved));
});

// Check an OAuth provider before relying on it. Uses the stored secret when none is typed.
router.post('/test', async (req, res) => {
  const { issuer, client_id, client_secret } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof issuer !== 'string' || !isCanonicalHttps(issuer)) return res.status(400).json({ error: 'The issuer must be an https:// address.' });
  if (typeof client_id !== 'string' || !client_id.trim()) return res.status(400).json({ error: 'Enter the client ID.' });
  const secret = typeof client_secret === 'string' && client_secret ? client_secret : oauthSecret(await loadAiSettings());
  if (!secret) return res.status(400).json({ error: 'Enter the client secret.' });
  const problem = await testOauthProvider(issuer, client_id.trim(), secret);
  return res.json(problem ? { ok: false, error: problem } : { ok: true });
});

// ─── AI connection tokens ────────────────────────────────────────────────────

router.get('/tokens', async (_req, res) => {
  const rows = await query(
    `SELECT t.id, t.name, t.prefix, t.created_by, t.last_used_at, t.expires_at, t.created_at, t.site_ids,
            COALESCE((SELECT json_agg(s.name ORDER BY s.name) FROM sites s WHERE s.id = ANY(t.site_ids)), '[]'::json) AS site_names
       FROM api_tokens t WHERE t.scope = $1 ORDER BY t.created_at DESC`, [REVIEW_SCOPE]);
  res.json(rows);
});

router.post('/tokens', async (req, res) => {
  const { name, expires_days, site_ids } = (req.body ?? {}) as { name?: unknown; expires_days?: unknown; site_ids?: unknown };
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Give the token a name.' });
  let days: number | null = null;
  if (expires_days !== undefined && expires_days !== null && expires_days !== '') {
    days = Number(expires_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Expiry must be 1 to 3650 days, or blank for never.' });
  }
  let sites: number[] | null = null;
  if (site_ids !== undefined && site_ids !== null) {
    if (!Array.isArray(site_ids) || site_ids.length === 0 || !site_ids.every((v) => Number.isSafeInteger(v) && v > 0)) {
      return res.status(400).json({ error: 'Choose at least one site, or all sites.' });
    }
    sites = [...new Set(site_ids as number[])];
    const found = await query<{ id: number }>(`SELECT id FROM sites WHERE id = ANY($1::int[])`, [sites]);
    if (found.length !== sites.length) return res.status(400).json({ error: 'A chosen site no longer exists.' });
  }
  const { token, hash, prefix } = newReviewToken();
  const row = await queryOne<{ id: number }>(
    `INSERT INTO api_tokens (name, token_hash, prefix, scope, created_by, expires_at, site_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name.trim().slice(0, 100), hash, prefix, REVIEW_SCOPE, req.user?.username ?? null,
      days ? new Date(Date.now() + days * 86_400_000).toISOString() : null, sites]);
  // Shown once; only the hash is kept.
  return res.status(201).json({ id: row!.id, token });
});

router.delete('/tokens/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Invalid token' });
  await query(`DELETE FROM api_tokens WHERE id = $1 AND scope = $2`, [id, REVIEW_SCOPE]);
  return res.json({ ok: true });
});

export default router;
