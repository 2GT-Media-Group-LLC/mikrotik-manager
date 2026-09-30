import { Router, Request, Response } from 'express';
import { encryptionStatus, reencryptAll } from '../services/encryptedData';
import { encryptionKeyInfo, encryptionKeyMissing, rotateEncryptionKey, retireOldEncryptionKeys } from '../utils/secrets';
import { endAllSessions, forgetSessionAccount } from '../utils/sessionState';
import bcrypt from 'bcryptjs';
import { query, queryOne, transaction } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { netflowCollector } from '../services/netflow/NetflowCollector';
import { validatePassword } from '../utils/passwordPolicy';
import { OIDC_SETTINGS_KEY } from '../services/oidc/oidcConfig';

const router = Router();
router.use(requireAuth);

// Settings keys managed through their own dedicated (admin-only) endpoints and
// never exposed via this generic surface — the OIDC config holds an encrypted
// client secret and must only be read/written through /api/auth/oidc/config.
const PROTECTED_SETTING_KEYS = new Set<string>([OIDC_SETTINGS_KEY]);

// GET /api/settings
router.get('/', async (_req: Request, res: Response) => {
  const settings = await query(`SELECT key, value FROM app_settings ORDER BY key`);
  const map: Record<string, unknown> = {};
  for (const s of settings as { key: string; value: unknown }[]) {
    if (PROTECTED_SETTING_KEYS.has(s.key)) continue;
    map[s.key] = s.value;
  }
  res.json(map);
});

// PUT /api/settings
router.put('/', requireAdmin, async (req: Request, res: Response) => {
  const updates = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (PROTECTED_SETTING_KEYS.has(key)) continue;
    await query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }
  // Apply NetFlow listener changes immediately instead of waiting for the
  // collector's periodic settings reconcile.
  if (Object.keys(updates).some((k) => k.startsWith('netflow_'))) {
    netflowCollector.reconcile().catch(() => {});
  }
  res.json({ message: 'Settings updated' });
});

// GET /api/settings/users
// ─── Per-site access (outside review P1-7) ──────────────────────────────────

type SiteRoleInput = { site_id: number; role: string };

/**
 * Validate `site_roles` from a request: undefined means "unchanged", an empty
 * list means fleet-wide access, otherwise each entry names an existing site
 * and one of the three roles.
 */
async function parseSiteRoles(raw: unknown): Promise<{ ok: true; value: SiteRoleInput[] | undefined } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'site_roles must be a list of { site_id, role }' };
  const out: SiteRoleInput[] = [];
  const seen = new Set<number>();
  for (const e of raw as Array<Record<string, unknown>>) {
    const siteId = Number(e?.['site_id']);
    const role = String(e?.['role'] ?? '');
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return { ok: false, error: 'site_roles: invalid site_id' };
    if (!['admin', 'operator', 'viewer'].includes(role)) return { ok: false, error: 'site_roles: role must be admin, operator or viewer' };
    if (seen.has(siteId)) return { ok: false, error: 'site_roles: a site is listed twice' };
    seen.add(siteId);
    out.push({ site_id: siteId, role });
  }
  if (out.length > 0) {
    const found = await query<{ id: number }>(`SELECT id FROM sites WHERE id = ANY($1::int[])`, [out.map((e) => e.site_id)]);
    if (found.length !== out.length) return { ok: false, error: 'site_roles: a site does not exist' };
  }
  return { ok: true, value: out };
}

/** Replace a user's site roles; an empty list makes the account fleet-wide again. */
async function saveSiteRoles(userId: number, roles: SiteRoleInput[]): Promise<void> {
  await transaction(async (client) => {
    await client.query(`DELETE FROM user_site_roles WHERE user_id = $1`, [userId]);
    for (const r of roles) {
      await client.query(`INSERT INTO user_site_roles (user_id, site_id, role) VALUES ($1, $2, $3)`, [userId, r.site_id, r.role]);
    }
  });
  // Applies from the user's next request, not after the session cache expires.
  forgetSessionAccount(userId);
}

const USER_COLUMNS = `u.id, u.username, u.email, u.role, u.auth_provider, u.created_at,
  COALESCE(
    (SELECT json_agg(json_build_object('site_id', usr.site_id, 'site_name', s.name, 'role', usr.role) ORDER BY s.name)
       FROM user_site_roles usr JOIN sites s ON s.id = usr.site_id WHERE usr.user_id = u.id),
    '[]'::json) AS site_roles`;

router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
  const users = await query(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.username`);
  res.json(users);
});

// POST /api/settings/users
router.post('/users', requireAdmin, async (req: Request, res: Response) => {
  const { username, password, role = 'viewer' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const pwError = validatePassword(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }
  const validRoles = ['admin', 'operator', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, operator, or viewer' });
  }

  const siteRoles = await parseSiteRoles(req.body.site_roles);
  if (!siteRoles.ok) return res.status(400).json({ error: siteRoles.error });

  const existing = await queryOne(`SELECT id FROM users WHERE username = $1`, [username]);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, 12);
  const rows = await query<{ id: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [username, hash, role]
  );
  if (siteRoles.value && siteRoles.value.length > 0) await saveSiteRoles(rows[0].id, siteRoles.value);
  const created = await queryOne(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [rows[0].id]);
  return res.status(201).json(created);
});

// PUT /api/settings/users/:id - update role and/or reset password
router.put('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id);
  const { role, password } = req.body;

  const existing = await queryOne<{ id: number; role: string }>(
    `SELECT id, role FROM users WHERE id = $1`,
    [userId]
  );
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Cannot demote yourself
  if (userId === req.user!.userId && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role away from admin' });
  }
  const siteRoles = await parseSiteRoles(req.body.site_roles);
  if (!siteRoles.ok) return res.status(400).json({ error: siteRoles.error });
  // Nor limit yourself to particular sites, which would end your fleet administration.
  if (userId === req.user!.userId && siteRoles.value && siteRoles.value.length > 0) {
    return res.status(400).json({ error: 'Cannot limit your own account to particular sites' });
  }

  const validRoles = ['admin', 'operator', 'viewer'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  let pwHash: string | null = null;
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }
    pwHash = await bcrypt.hash(password, 12);
  }
  if (role) {
    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
  }
  if (pwHash) {
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [pwHash, userId]);
  }
  // A new role or a reset password ends the account's existing sessions, so a
  // demoted or compromised account loses access now rather than within 24
  // hours (outside review P2-1). Changing your own ends yours too.
  if (pwHash || (role && role !== existing.role)) {
    await endAllSessions(userId);
  }

  if (siteRoles.value !== undefined) await saveSiteRoles(userId, siteRoles.value);

  const updated = await queryOne(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId]);
  return res.json(updated);
});

// ─── Encryption key (outside review P2-29) ───────────────────────────────────

async function encryptionOverview() {
  const locations = await encryptionStatus(true);
  const totals = locations.reduce(
    (t, l) => ({ current: t.current + l.current, old: t.old + l.old, unreadable: t.unreadable + l.unreadable }),
    { current: 0, old: 0, unreadable: 0 });
  const info = encryptionKeyInfo();
  const missing = encryptionKeyMissing();
  return {
    source: info.source === 'generated' ? 'persisted' : info.source,
    key_id: info.keyId,
    saved_previous_keys: info.savedPreviousKeys,
    env_previous_keys: info.envPreviousKeys,
    key_missing: missing,
    locations,
    totals,
    can_rotate: info.source !== 'env' && !missing && totals.unreadable === 0,
    // Old keys can go once nothing stored needs them.
    can_retire: info.savedPreviousKeys > 0 && totals.old === 0 && totals.unreadable === 0,
  };
}

// GET /api/settings/encryption — which key protects stored credentials, and how much is under it.
router.get('/encryption', requireAdmin, async (_req: Request, res: Response) => {
  res.json(await encryptionOverview());
});

// POST /api/settings/encryption/rotate — switch to a new key, keeping the old
// one until everything is re-encrypted under the new one.
router.post('/encryption/rotate', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const before = await encryptionStatus(true);
    if (before.some((l) => l.unreadable > 0)) {
      return res.status(409).json({ error: 'Some stored values cannot be decrypted with any known key. Resolve that before rotating.' });
    }
    const { keyId: newKeyId } = rotateEncryptionKey();
    const result = await reencryptAll();
    return res.json({ message: `Switched to key ${newKeyId} and re-encrypted ${result.rewritten} stored value(s).`, ...result, ...(await encryptionOverview()) });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/settings/encryption/reencrypt — move anything still under an older key forward.
router.post('/encryption/reencrypt', requireAdmin, async (_req: Request, res: Response) => {
  const result = await reencryptAll();
  res.json({ message: `Re-encrypted ${result.rewritten} stored value(s).`, ...result, ...(await encryptionOverview()) });
});

// POST /api/settings/encryption/retire — forget older keys once nothing needs them.
router.post('/encryption/retire', requireAdmin, async (_req: Request, res: Response) => {
  const overview = await encryptionOverview();
  if (!overview.can_retire) {
    return res.status(409).json({ error: 'Older keys are still needed, or there are none to retire.' });
  }
  const dropped = retireOldEncryptionKeys();
  return res.json({ message: `Retired ${dropped} older key(s).`, ...(await encryptionOverview()) });
});

// DELETE /api/settings/users/:id
router.delete('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  if (parseInt(req.params.id) === req.user!.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const result = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!result.length) return res.status(404).json({ error: 'User not found' });
  // Its sessions stop working on their next request: the account is gone.
  forgetSessionAccount(parseInt(req.params.id, 10));
  return res.json({ message: 'User deleted' });
});

export default router;
