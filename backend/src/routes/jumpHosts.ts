import { Router, Request, Response } from 'express';
import { utils as sshUtils } from 'ssh2';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { presetCaller, canManagePresetSite, canSeePreset, presetUseRefusal, type PresetCaller } from '../utils/presetAccess';
import { encrypt } from '../utils/crypto';
import { checkPort } from '../utils/apiTls';
import { normalizeDeviceAddress } from '../utils/deviceAddress';
import { rateLimitRedis } from '../middleware/rateLimitRedis';
import { sshFingerprintDisplay } from '../services/identityPins';
import { strictId } from '../utils/siteAccess';
import {
  dropJumpHost, jumpHostStatus, parseHostKeyFingerprint, testJumpHost, trustNewJumpHostKey, type JumpHostRow,
} from '../services/jumpHosts';

/**
 * SSH jump hosts: routers the manager connects through to reach devices it
 * can't reach directly (services/jumpHosts.ts).
 *
 * Managed like credential presets (#228): fleet-wide or one site's, changed
 * by fleet admins or that site's admins. Everyone who can see the site sees
 * its jump hosts in the device form, never their secrets.
 */
const router = Router();
router.use(requireAuth);

const mutationLimiter = rateLimitRedis({ windowSec: 60, max: 30, keyPrefix: 'jump-host' });
// A test opens an SSH connection to the jump host.
const testLimiter = rateLimitRedis({ windowSec: 60, max: 10, keyPrefix: 'jump-host-test' });

const MANAGE_REFUSED = 'You can only manage jump hosts for sites you administer.';
const NOT_FOUND = 'Jump host not found';

type Row = JumpHostRow & {
  notes: string | null;
  host_key_mismatch_at: string | null;
  created_at: string;
  updated_at: string;
  site_name?: string | null;
  preset_name?: string | null;
  device_count?: string | number;
};

/** Visible to a site's members, and fleet-wide ones to everyone, as a preset open to operators. */
const visible = (caller: PresetCaller, row: { site_id: number | null }) =>
  canSeePreset(caller, { site_id: row.site_id, allow_operator_use: true });

function toPublic(row: Row, caller: PresetCaller) {
  const status = jumpHostStatus(row.id);
  return {
    id: row.id,
    name: row.name,
    site_id: row.site_id,
    site_name: row.site_name ?? null,
    host: row.host,
    port: row.port,
    username: row.username,
    auth: row.credential_preset_id != null ? 'preset' : row.private_key_encrypted ? 'key' : 'password',
    credential_preset_id: row.credential_preset_id,
    credential_preset_name: row.preset_name ?? null,
    has_password: !!row.password_encrypted,
    has_private_key: !!row.private_key_encrypted,
    host_key_fingerprint: row.host_key_fingerprint ? sshFingerprintDisplay(row.host_key_fingerprint) : null,
    /** A different key it presented, waiting for an admin to trust it. */
    seen_host_key_fingerprint: row.seen_host_key_fingerprint ? sshFingerprintDisplay(row.seen_host_key_fingerprint) : null,
    host_key_mismatch_at: row.host_key_mismatch_at,
    notes: row.notes,
    device_count: Number(row.device_count ?? 0),
    status: status.state,
    status_error: status.error ?? null,
    can_manage: canManagePresetSite(caller, row.site_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT = `
  SELECT j.*, s.name AS site_name, p.name AS preset_name,
         (SELECT COUNT(*) FROM devices d WHERE d.jump_host_id = j.id) AS device_count
    FROM jump_hosts j
    LEFT JOIN sites s ON s.id = j.site_id
    LEFT JOIN credential_presets p ON p.id = j.credential_preset_id`;

async function loadRow(id: number): Promise<Row | null> {
  return queryOne<Row>(`${SELECT} WHERE j.id = $1`, [id]);
}

/** The site a request names: null for fleet-wide, undefined when not given, 'bad' when invalid. */
async function requestedSite(v: unknown): Promise<number | null | undefined | 'bad'> {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const id = strictId(v);
  if (id === null) return 'bad';
  const site = await queryOne<{ id: number }>(`SELECT id FROM sites WHERE id = $1`, [id]);
  return site ? id : 'bad';
}

interface Body {
  name?: string;
  host?: string;
  port?: unknown;
  username?: string | null;
  password?: string | null;
  private_key?: string | null;
  passphrase?: string | null;
  credential_preset_id?: number | null;
  host_key_fingerprint?: string | null;
  notes?: string | null;
}

/**
 * The address and SSH port a create or edit sends, as stored. The address is
 * read as a device's is, so brackets around IPv6, a pasted URL or a ":port"
 * come off; such a port is the SSH port, unless a different one is given.
 */
function addressOf(b: Body): { ok: true; host?: string; port: number | null } | { ok: false; error: string } {
  const pc = checkPort(b.port, 'SSH port');
  if (!pc.ok) return { ok: false, error: pc.error };
  if (b.host === undefined) return { ok: true, port: pc.port };
  const n = typeof b.host === 'string' ? normalizeDeviceAddress(b.host) : null;
  if (!n?.ok) return { ok: false, error: n?.reason ?? 'The address must be an IP address or host name.' };
  if (n.address.length > 253) return { ok: false, error: 'The address is too long.' };
  const ap = checkPort(n.port, 'The port in the address');
  if (!ap.ok) return { ok: false, error: ap.error };
  if (n.port && pc.port !== null && n.port !== pc.port) {
    return { ok: false, error: `The address includes port ${n.port}, but the SSH port is ${pc.port}. Use one or the other.` };
  }
  return { ok: true, host: n.address, port: n.port ?? pc.port };
}

/** Check what a create or edit sends, for a jump host of `siteId` logging in with `presetId`; an error message, or null. */
async function invalid(b: Body, caller: PresetCaller, siteId: number | null, presetId: number | null | undefined): Promise<string | null> {
  if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100)) {
    return 'The name must be 1 to 100 characters.';
  }
  if (b.username != null && (typeof b.username !== 'string' || b.username.length > 50)) {
    return 'The username can be at most 50 characters.';
  }
  if (b.private_key) {
    const parsed = sshUtils.parseKey(b.private_key, b.passphrase || undefined);
    if (parsed instanceof Error) return `The private key could not be read: ${parsed.message}`;
  }
  if (b.host_key_fingerprint && !parseHostKeyFingerprint(b.host_key_fingerprint)) {
    return 'The host key fingerprint must be SHA256:… as ssh-keygen -l prints it, or 64 hex digits.';
  }
  if (presetId != null) {
    if (strictId(presetId) === null) return 'credential_preset_id must be a credential preset id.';
    const preset = await queryOne<{ site_id: number | null; allow_operator_use: boolean }>(
      `SELECT site_id, allow_operator_use FROM credential_presets WHERE id = $1`, [presetId]);
    if (!preset) return 'That credential preset does not exist.';
    // The same rules as applying it to a device of the jump host's site.
    const refusal = presetUseRefusal(caller, preset, siteId);
    if (refusal) return refusal;
  }
  return null;
}

// GET /api/jump-hosts — the device form's picker and Settings → Jump hosts
router.get('/', async (req, res) => {
  const caller = presetCaller(req.user);
  const rows = await query<Row>(`${SELECT} ORDER BY j.site_id NULLS FIRST, j.name ASC`);
  res.json(rows.filter((r) => visible(caller, r)).map((r) => toPublic(r, caller)));
});

// POST /api/jump-hosts
router.post('/', mutationLimiter, async (req, res) => {
  const caller = presetCaller(req.user);
  const b = req.body as Body;
  const site = await requestedSite((req.body as { site_id?: unknown }).site_id);
  if (site === 'bad') return res.status(400).json({ error: 'Unknown site' });
  // No site given: fleet-wide for a fleet admin, the only site a site admin runs.
  const siteId = site !== undefined
    ? site
    : (caller.fleetAdmin ? null : (caller.adminSites.length === 1 ? caller.adminSites[0] : null));
  if (!canManagePresetSite(caller, siteId)) return res.status(403).json({ error: MANAGE_REFUSED });

  if (!b.name || !b.host) return res.status(400).json({ error: 'name and host are required' });
  const addr = addressOf(b);
  if (!addr.ok) return res.status(400).json({ error: addr.error });
  const usesPreset = b.credential_preset_id != null;
  if (!usesPreset && !b.username) return res.status(400).json({ error: 'A username is required unless a credential preset is used.' });
  const secrets = [usesPreset, !!b.password, !!b.private_key].filter(Boolean).length;
  if (secrets !== 1) return res.status(400).json({ error: 'Give exactly one of: a password, a private key, or a credential preset.' });
  const bad = await invalid(b, caller, siteId, b.credential_preset_id);
  if (bad) return res.status(400).json({ error: bad });

  const clash = await queryOne<{ id: number }>(
    `SELECT id FROM jump_hosts WHERE name = $1 AND COALESCE(site_id, 0) = COALESCE($2::integer, 0)`, [b.name.trim(), siteId]);
  if (clash) return res.status(409).json({ error: 'A jump host with this name already exists' });

  const rows = await query<{ id: number }>(
    `INSERT INTO jump_hosts (name, site_id, host, port, username, password_encrypted, private_key_encrypted,
                             passphrase_encrypted, credential_preset_id, host_key_fingerprint, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      b.name.trim(), siteId, addr.host, addr.port ?? 22, b.username || null,
      b.password ? encrypt(b.password) : null,
      b.private_key ? encrypt(b.private_key) : null,
      b.private_key && b.passphrase ? encrypt(b.passphrase) : null,
      usesPreset ? b.credential_preset_id : null,
      b.host_key_fingerprint ? parseHostKeyFingerprint(b.host_key_fingerprint) : null,
      b.notes || null,
    ]);
  return res.status(201).json(toPublic((await loadRow(rows[0].id))!, caller));
});

/** "1 device is reached" / "3 devices are reached". */
const devicesReached = (n: number): string => (n === 1 ? '1 device is reached' : `${n} devices are reached`);

/**
 * Whether the caller may point a jump host at another server: a new address
 * or port, or a different host key trusted. Its login, and the saved API
 * password of every device behind it, then go to whatever answers there: the
 * reason a device's new address needs its password (GHSA-63v6-w7qf-349f), one
 * step removed. So while devices use it only a fleet admin may, as only a
 * fleet admin moves a device without its password. Anyone else changing the
 * address of one no device uses gives its login with the change, so the saved
 * one only goes where it was saved for. The refusal to send, or null.
 */
function redirectRefusal(
  caller: PresetCaller, row: Row, change: { moved: boolean; rekeyed: boolean; loginGiven: boolean },
): { status: number; error: string; code: string } | null {
  if (caller.fleetAdmin || (!change.moved && !change.rekeyed)) return null;
  const devices = Number(row.device_count ?? 0);
  if (devices > 0) {
    return {
      status: 403,
      error: `${devicesReached(devices)} through this jump host, so only a fleet admin can change its address, port or `
        + 'host key. Their saved passwords would go to whatever answers there.',
      code: 'fleet_admin_required_while_in_use',
    };
  }
  if (change.moved && !change.loginGiven) {
    return {
      status: 400,
      error: "Give the jump host's login again (its password, key or credential preset) to change its address or port. "
        + 'The saved one is only sent to the address it was saved for.',
      code: 'login_required_for_address_change',
    };
  }
  return null;
}

/** The jump host the request names, when the caller may manage it; otherwise the response is sent. */
async function managed(req: Request<{ id: string }>, res: Response): Promise<{ row: Row; caller: PresetCaller } | null> {
  const caller = presetCaller(req.user);
  const id = strictId(req.params.id);
  const row = id !== null ? await loadRow(id) : null;
  if (!row || !visible(caller, row)) { res.status(404).json({ error: NOT_FOUND }); return null; }
  if (!canManagePresetSite(caller, row.site_id)) { res.status(403).json({ error: MANAGE_REFUSED }); return null; }
  return { row, caller };
}

// PUT /api/jump-hosts/:id — only what the request sends is changed
router.put('/:id', mutationLimiter, async (req, res) => {
  const m = await managed(req, res);
  if (!m) return;
  const { row, caller } = m;
  const b = req.body as Body;
  const movedTo = await requestedSite((req.body as { site_id?: unknown }).site_id);
  if (movedTo === 'bad') return res.status(400).json({ error: 'Unknown site' });
  if (movedTo !== undefined && !canManagePresetSite(caller, movedTo)) return res.status(403).json({ error: MANAGE_REFUSED });
  const siteId = movedTo === undefined ? row.site_id : movedTo;
  if (movedTo !== undefined && movedTo !== row.site_id && movedTo !== null) {
    // Other sites' devices, or their new devices, would be left using another site's jump host.
    const elsewhere = await queryOne<{ devices: string; sites: string }>(
      `SELECT (SELECT COUNT(*) FROM devices WHERE jump_host_id = $1 AND site_id IS DISTINCT FROM $2) AS devices,
              (SELECT COUNT(*) FROM sites WHERE default_jump_host_id = $1 AND id <> $2) AS sites`, [row.id, movedTo]);
    if (Number(elsewhere?.devices ?? 0) > 0 || Number(elsewhere?.sites ?? 0) > 0) {
      return res.status(409).json({
        error: 'Devices in other sites use this jump host, or other sites have it as their default, so it can only be fleet-wide or stay where it is.',
      });
    }
  }
  const addr = addressOf(b);
  if (!addr.ok) return res.status(400).json({ error: addr.error });
  // A preset it keeps must suit the site it moves to, as a new one must.
  const keptPreset = movedTo !== undefined && movedTo !== row.site_id
    && b.credential_preset_id === undefined && !b.password && !b.private_key ? row.credential_preset_id : null;
  const bad = await invalid(b, caller, siteId, b.credential_preset_id ?? keptPreset);
  if (bad) return res.status(400).json({ error: bad });

  if ((b.name && b.name.trim() !== row.name) || movedTo !== undefined) {
    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM jump_hosts WHERE name = $1 AND id <> $2 AND COALESCE(site_id, 0) = COALESCE($3::integer, 0)`,
      [(b.name || row.name).trim(), row.id, siteId]);
    if (clash) return res.status(409).json({ error: 'A jump host with this name already exists' });
  }

  // One login at a time: a new password, key or preset replaces the others.
  const authChange: 'password' | 'key' | 'preset' | null =
    b.credential_preset_id != null ? 'preset' : b.private_key ? 'key' : b.password ? 'password' : null;
  if (b.credential_preset_id === null && row.credential_preset_id != null && !b.password && !b.private_key) {
    return res.status(400).json({ error: 'Give a password or private key to stop using the credential preset.' });
  }
  const usernameAfter = b.username !== undefined ? b.username : row.username;
  const presetAfter = authChange === 'preset' ? b.credential_preset_id : authChange ? null : row.credential_preset_id;
  if (presetAfter == null && !usernameAfter) return res.status(400).json({ error: 'A username is required unless a credential preset is used.' });

  // A different router answers at a new address: its key is pinned afresh,
  // unless one was given with the change.
  const moved = (addr.host !== undefined && addr.host !== row.host) || (addr.port !== null && addr.port !== row.port);
  const fingerprint = b.host_key_fingerprint ? parseHostKeyFingerprint(b.host_key_fingerprint) : null;
  // A key given where none is pinned yet points it nowhere new: the first key
  // seen would be pinned anyway. Replacing a pinned one is trusting a new key.
  const rekeyed = fingerprint !== null && row.host_key_fingerprint !== null && fingerprint !== row.host_key_fingerprint;
  const refused = redirectRefusal(caller, row, { moved, rekeyed, loginGiven: authChange !== null });
  if (refused) return res.status(refused.status).json({ error: refused.error, code: refused.code });
  const sent = (v: unknown): boolean => v !== undefined;

  await query(
    `UPDATE jump_hosts SET
       name                  = COALESCE($2, name),
       site_id               = CASE WHEN $3::boolean THEN $4::integer ELSE site_id END,
       host                  = COALESCE($5, host),
       port                  = COALESCE($6, port),
       username              = CASE WHEN $7::boolean THEN $8::text ELSE username END,
       password_encrypted    = CASE WHEN $9::text IS NULL THEN password_encrypted WHEN $9 = 'password' THEN $10 ELSE NULL END,
       private_key_encrypted = CASE WHEN $9::text IS NULL THEN private_key_encrypted WHEN $9 = 'key' THEN $11 ELSE NULL END,
       passphrase_encrypted  = CASE WHEN $9::text IS NULL THEN passphrase_encrypted WHEN $9 = 'key' THEN $12 ELSE NULL END,
       credential_preset_id  = CASE WHEN $9::text IS NULL THEN credential_preset_id WHEN $9 = 'preset' THEN $13::integer ELSE NULL END,
       host_key_fingerprint  = CASE WHEN $14::text IS NOT NULL THEN $14 WHEN $15::boolean THEN NULL ELSE host_key_fingerprint END,
       seen_host_key_fingerprint = CASE WHEN $14::text IS NOT NULL OR $15::boolean THEN NULL ELSE seen_host_key_fingerprint END,
       host_key_mismatch_at  = CASE WHEN $14::text IS NOT NULL OR $15::boolean THEN NULL ELSE host_key_mismatch_at END,
       notes                 = CASE WHEN $16::boolean THEN $17::text ELSE notes END,
       updated_at            = NOW()
     WHERE id = $1`,
    [
      row.id, b.name?.trim() || null, movedTo !== undefined, movedTo ?? null,
      addr.host ?? null, addr.port, sent(b.username), b.username || null,
      authChange,
      authChange === 'password' ? encrypt(b.password!) : null,
      authChange === 'key' ? encrypt(b.private_key!) : null,
      authChange === 'key' && b.passphrase ? encrypt(b.passphrase) : null,
      authChange === 'preset' ? b.credential_preset_id : null,
      fingerprint, moved,
      sent(b.notes), b.notes || null,
    ]);
  // Its connection was opened with the old address, login or pin; a new name,
  // site or notes leave it, and the sessions through it, as they are.
  if (moved || authChange || fingerprint || (sent(b.username) && (b.username || null) !== row.username)) dropJumpHost(row.id);
  return res.json(toPublic((await loadRow(row.id))!, caller));
});

// DELETE /api/jump-hosts/:id — refused while devices use it
router.delete('/:id', mutationLimiter, async (req, res) => {
  const m = await managed(req, res);
  if (!m) return;
  const devices = Number(m.row.device_count ?? 0);
  if (devices > 0) {
    return res.status(409).json({
      error: `${devicesReached(devices)} through this jump host. Move ${devices === 1 ? 'it' : 'them'} to another route first.`,
      code: 'jump_host_in_use',
    });
  }
  try {
    await query(`DELETE FROM jump_hosts WHERE id = $1`, [m.row.id]);
  } catch (err) {
    // A device was moved onto it since the check.
    if ((err as { code?: string }).code === '23503') {
      return res.status(409).json({ error: 'Devices are reached through this jump host. Move them first.', code: 'jump_host_in_use' });
    }
    throw err;
  }
  dropJumpHost(m.row.id);
  return res.json({ message: 'Jump host deleted' });
});

// POST /api/jump-hosts/:id/test — connect now, without waiting out a backoff
router.post('/:id/test', testLimiter, async (req, res) => {
  const m = await managed(req, res);
  if (!m) return;
  const result = await testJumpHost(m.row.id);
  const after = (await loadRow(m.row.id))!;
  return res.json({ ...result, fingerprint: result.ok && result.fingerprint ? sshFingerprintDisplay(result.fingerprint) : null, jump_host: toPublic(after, m.caller) });
});

// POST /api/jump-hosts/:id/trust-key — accept the changed host key it last presented
router.post('/:id/trust-key', mutationLimiter, async (req, res) => {
  const m = await managed(req, res);
  if (!m) return;
  // On one no device uses, a site admin may still trust a new key with the
  // saved login, as they may a device's new key.
  const refused = redirectRefusal(m.caller, m.row, { moved: false, rekeyed: true, loginGiven: false });
  if (refused) return res.status(refused.status).json({ error: refused.error, code: refused.code });
  if (!(await trustNewJumpHostKey(m.row.id))) return res.status(409).json({ error: 'There is no changed host key to trust.' });
  return res.json(toPublic((await loadRow(m.row.id))!, m.caller));
});

export default router;
