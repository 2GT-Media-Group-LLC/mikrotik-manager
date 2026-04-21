import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { encrypt } from '../utils/crypto';
import { rateLimitMutations } from '../middleware/rateLimitMutations';

const router = Router();
router.use(requireAuth);

const presetMutationLimiter = rateLimitMutations({
  windowMs: 60_000,
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
    has_api_password: !!row.api_password_encrypted,
    has_ssh_password: !!row.ssh_password_encrypted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/credential-presets — any authenticated user can list (the Add
// Device modal needs this for its picker), but secrets are never exposed.
router.get('/', async (_req: Request, res: Response) => {
  const rows = await query<CredentialPresetRow>(
    `SELECT * FROM credential_presets ORDER BY name ASC`
  );
  res.json(rows.map(toPublic));
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
  } = req.body as {
    name?: string;
    api_username?: string;
    api_password?: string;
    api_port?: number | null;
    ssh_username?: string | null;
    ssh_password?: string | null;
    ssh_port?: number | null;
    notes?: string | null;
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

  const rows = await query<CredentialPresetRow>(
    `INSERT INTO credential_presets
       (name, api_username, api_password_encrypted, api_port,
        ssh_username, ssh_password_encrypted, ssh_port, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
  };

  if (typeof name === 'string' && name && name !== existing.name) {
    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM credential_presets WHERE name = $1 AND id <> $2`,
      [name, id]
    );
    if (clash) return res.status(409).json({ error: 'A preset with this name already exists' });
  }

  const newApiPass = api_password ? encrypt(api_password) : existing.api_password_encrypted;
  let newSshPass: string | null = existing.ssh_password_encrypted;
  if (clear_ssh_password) newSshPass = null;
  if (ssh_password) newSshPass = encrypt(ssh_password);

  await query(
    `UPDATE credential_presets SET
       name                   = COALESCE($1, name),
       api_username           = COALESCE($2, api_username),
       api_password_encrypted = $3,
       api_port               = $4,
       ssh_username           = $5,
       ssh_password_encrypted = $6,
       ssh_port               = $7,
       notes                  = $8,
       updated_at             = NOW()
     WHERE id = $9`,
    [
      name ?? null,
      api_username ?? null,
      newApiPass,
      api_port === undefined ? existing.api_port : api_port,
      ssh_username === undefined ? existing.ssh_username : (ssh_username || null),
      newSshPass,
      ssh_port === undefined ? existing.ssh_port : ssh_port,
      notes === undefined ? existing.notes : (notes || null),
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
