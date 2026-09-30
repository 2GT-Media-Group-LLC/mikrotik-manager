import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin, isSiteScoped } from '../middleware/auth';
import { encrypt } from '../utils/crypto';
import { rateLimitRedis } from '../middleware/rateLimitRedis';

const router = Router();
router.use(requireAuth);

const presetMutationLimiter = rateLimitRedis({
  windowSec: 60,
  max: 30,
  keyPrefix: 'credential-preset',
});

export interface CredentialPresetRow {
  id: number;
  name: string;
  api_username: string;
  api_password_encrypted: string;
  api_port: number | null;
  ssh_username: string | null;
  ssh_password_encrypted: string | null;
  ssh_port: number | null;
  notes: string | null;
  /** When false, only admins may use this preset when adding/updating devices. */
  allow_operator_use: boolean;
  created_at: string;
  updated_at: string;
}

// Public (listable) shape — never returns the encrypted secrets themselves,
// just booleans telling the UI which slots are populated.
interface CredentialPresetPublic {
  id: number;
  name: string;
  api_username: string;
  api_port: number | null;
  ssh_username: string | null;
  ssh_port: number | null;
  notes: string | null;
  allow_operator_use: boolean;
  has_api_password: boolean;
  has_ssh_password: boolean;
  created_at: string;
  updated_at: string;
}

function toPublic(row: CredentialPresetRow): CredentialPresetPublic {
  return {
    id: row.id,
    name: row.name,
    api_username: row.api_username,
    api_port: row.api_port,
    ssh_username: row.ssh_username,
    ssh_port: row.ssh_port,
    notes: row.notes,
    allow_operator_use: row.allow_operator_use !== false,
    has_api_password: !!row.api_password_encrypted,
    has_ssh_password: !!row.ssh_password_encrypted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/credential-presets — any authenticated user can list (the Add
// Device modal needs this for its picker), but secrets are never exposed.
router.get('/', async (req: Request, res: Response) => {
  const role = req.user?.role;
  const rows = await query<CredentialPresetRow>(
    `SELECT * FROM credential_presets ORDER BY name ASC`
  );
  // Admin-only presets are fleet objects: a site admin sees them as an operator would (P1-7).
  const filtered =
    role === 'admin' && !isSiteScoped(req.user)
      ? rows
      : rows.filter((r) => (r as CredentialPresetRow).allow_operator_use !== false);
  res.json(filtered.map(toPublic));
});

// POST /api/credential-presets — admin only
router.post('/', requireAdmin, presetMutationLimiter, async (req: Request, res: Response) => {
  const {
    name,
    api_username,
    api_password,
    api_port,
    ssh_username,
    ssh_password,
    ssh_port,
    notes,
    allow_operator_use,
  } = req.body as {
    name?: string;
    api_username?: string;
    api_password?: string;
    api_port?: number | null;
    ssh_username?: string | null;
    ssh_password?: string | null;
    ssh_port?: number | null;
    notes?: string | null;
    allow_operator_use?: boolean;
  };

  if (!name || !api_username || !api_password) {
    return res
      .status(400)
      .json({ error: 'name, api_username, and api_password are required' });
  }

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM credential_presets WHERE name = $1`,
    [name]
  );
  if (existing) {
    return res.status(409).json({ error: 'A preset with this name already exists' });
  }

  const encApi = encrypt(api_password);
  const encSsh = ssh_password ? encrypt(ssh_password) : null;

  const allowOp = allow_operator_use !== false;

  const rows = await query<CredentialPresetRow>(
    `INSERT INTO credential_presets
       (name, api_username, api_password_encrypted, api_port,
        ssh_username, ssh_password_encrypted, ssh_port, notes, allow_operator_use)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      name,
      api_username,
      encApi,
      api_port ?? null,
      ssh_username || null,
      encSsh,
      ssh_port ?? null,
      notes || null,
      allowOp,
    ]
  );
  return res.status(201).json(toPublic(rows[0]));
});

// PUT /api/credential-presets/:id — admin only
router.put('/:id', requireAdmin, presetMutationLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const existing = await queryOne<CredentialPresetRow>(
    `SELECT * FROM credential_presets WHERE id = $1`,
    [id]
  );
  if (!existing) return res.status(404).json({ error: 'Preset not found' });

  const {
    name,
    api_username,
    api_password,
    api_port,
    ssh_username,
    ssh_password,
    ssh_port,
    notes,
    clear_ssh_password,
    allow_operator_use,
  } = req.body as {
    name?: string;
    api_username?: string;
    api_password?: string;
    api_port?: number | null;
    ssh_username?: string | null;
    ssh_password?: string | null;
    ssh_port?: number | null;
    notes?: string | null;
    // Explicit flag to remove a previously-saved SSH password
    clear_ssh_password?: boolean;
    allow_operator_use?: boolean;
  };

  if (typeof name === 'string' && name && name !== existing.name) {
    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM credential_presets WHERE name = $1 AND id <> $2`,
      [name, id]
    );
    if (clash) return res.status(409).json({ error: 'A preset with this name already exists' });
  }

  // Only what the request sends is written; everything else is left to the
  // database. Writing back values read at the start of the request let a
  // notes-only edit overwrite a password another admin had just changed
  // (outside review S10).
  const sent = (v: unknown): boolean => v !== undefined;
  const newApiPass = api_password ? encrypt(api_password) : null;
  const newSshPass = ssh_password ? encrypt(ssh_password) : null;

  await query(
    `UPDATE credential_presets SET
       name                   = COALESCE($1, name),
       api_username           = COALESCE($2, api_username),
       api_password_encrypted = COALESCE($3, api_password_encrypted),
       api_port               = CASE WHEN $4::boolean THEN $5::integer ELSE api_port END,
       ssh_username           = CASE WHEN $6::boolean THEN $7::text ELSE ssh_username END,
       ssh_password_encrypted = CASE WHEN $8::text IS NOT NULL THEN $8::text
                                     WHEN $9::boolean THEN NULL
                                     ELSE ssh_password_encrypted END,
       ssh_port               = CASE WHEN $10::boolean THEN $11::integer ELSE ssh_port END,
       notes                  = CASE WHEN $12::boolean THEN $13::text ELSE notes END,
       allow_operator_use     = COALESCE($14, allow_operator_use),
       updated_at             = NOW()
     WHERE id = $15`,
    [
      name || null,
      api_username || null,
      newApiPass,
      sent(api_port), api_port ?? null,
      sent(ssh_username), ssh_username || null,
      newSshPass,
      clear_ssh_password === true,
      sent(ssh_port), ssh_port ?? null,
      sent(notes), notes || null,
      allow_operator_use === undefined ? null : allow_operator_use,
      id,
    ]
  );

  const updated = await queryOne<CredentialPresetRow>(
    `SELECT * FROM credential_presets WHERE id = $1`,
    [id]
  );
  return res.json(toPublic(updated!));
});

// DELETE /api/credential-presets/:id — admin only
router.delete('/:id', requireAdmin, presetMutationLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const result = await query(
    `DELETE FROM credential_presets WHERE id = $1 RETURNING id`,
    [id]
  );
  if (!result.length) return res.status(404).json({ error: 'Preset not found' });
  return res.json({ message: 'Preset deleted' });
});

export default router;
