import { Router, Request, Response } from 'express';
import { devicesDenied, strictIdList, guardIdParams } from '../utils/siteAccess';
import { cleanOverrides, validateOverrides, resolveEffective } from '../utils/pollOverrides';
import { globalSettings } from '../services/pollSettings';
import { query, queryOne, transaction } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { groupsChanged } from '../services/siteGroups';
import { accountsOnlyReaching } from '../utils/siteRoles';
import { chooseJumpHost } from '../services/jumpHosts';

const router = Router();
router.use(requireAuth);
// Ids are plain numbers, read the same way by the site check and the handler (GHSA-j9x4-qwcj-p8v8).
guardIdParams(router, ['id'], 'Site not found');

const MAX_NAME = 120;

export interface SiteRow {
  id: number;
  name: string;
  address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  map_zoom?: number | null;
  notes: string | null;
  is_default: boolean;
  created_at: string;
  /** The group (customer) it belongs to (#306). */
  group_id?: number | null;
  /** The jump host new devices in this site are reached through, unless they say otherwise. */
  default_jump_host_id?: number | null;
}

/**
 * A group_id from a request: undefined = unchanged, null = no group, or an
 * existing group's id. Only fleet-wide accounts may set it: putting a site in
 * a group gives everyone with a role in that group access to it (#306).
 */
async function parseGroupId(req: Request, res: Response): Promise<{ ok: boolean; value?: number | null }> {
  const raw = (req.body as { group_id?: unknown }).group_id;
  if (raw === undefined) return { ok: true, value: undefined };
  if (req.user?.siteRoles) { res.status(403).json({ error: 'Only fleet-wide accounts can change which group a site is in.' }); return { ok: false }; }
  if (raw === null || raw === '') return { ok: true, value: null };
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid group' }); return { ok: false }; }
  const g = await queryOne<{ id: number }>(`SELECT id FROM site_groups WHERE id = $1`, [id]);
  if (!g) { res.status(400).json({ error: 'That group does not exist' }); return { ok: false }; }
  return { ok: true, value: id };
}

/** Shared validation so create and rename cannot drift apart. */
function normaliseName(raw: unknown): { name?: string; error?: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Site name is required' };
  if (name.length > MAX_NAME) return { error: `Site name must be ${MAX_NAME} characters or fewer` };
  return { name };
}

/**
 * The zoom a site's map opens at (#362): a whole number from 1 (the world) to
 * 19 (a building), or null for the map to fit what's on it. Undefined when not
 * given, so an edit that doesn't mention it leaves it alone.
 */
export function parseMapZoom(v: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 19) return { ok: false, error: 'Map zoom: a whole number from 1 (the world) to 19 (a building), or blank to fit the map.' };
  return { ok: true, value: n };
}

/** Coordinates are optional, but a half-pair is a bug rather than a location. */
function normaliseCoords(lat: unknown, lng: unknown): { lat: number | null; lng: number | null } {
  const latN = lat === null || lat === undefined || lat === '' ? null : Number(lat);
  const lngN = lng === null || lng === undefined || lng === '' ? null : Number(lng);
  const ok = latN !== null && lngN !== null
    && Number.isFinite(latN) && Number.isFinite(lngN)
    && Math.abs(latN) <= 90 && Math.abs(lngN) <= 180;
  return ok ? { lat: latN, lng: lngN } : { lat: null, lng: null };
}

// GET /api/sites — list with device counts, for the selector and the all-sites table
/**
 * Site-scoped accounts (P1-7): creating or deleting sites is for fleet-wide
 * accounts, and changing a site needs admin of that site. Returns false after
 * refusing.
 */
function refuseUnlessFleet(req: Request, res: Response): boolean {
  if (!req.user?.siteRoles) return true;
  res.status(403).json({ error: 'Only fleet-wide accounts can create or delete sites.' });
  return false;
}
function refuseUnlessSiteAdmin(req: Request, res: Response, siteId: number): boolean {
  if (!req.user?.siteRoles) return true;
  if (req.user.siteRoles[siteId] === 'admin') return true;
  res.status(req.user.siteRoles[siteId] ? 403 : 404).json({ error: req.user.siteRoles[siteId] ? 'You need admin access to that site.' : 'Site not found' });
  return false;
}

// ─── Settings this site overrides (#261) ────────────────────────────────────
// Poll intervals, MAC scan, config snapshots, secrets in backups: the site's
// devices use these instead of the global settings, unless a device overrides
// them itself. Changing them takes an admin: a fleet admin, or this site's.

function siteAdminOrRefuse(req: Request, res: Response, siteId: number): boolean {
  const scoped = req.user?.siteRoles;
  const ok = scoped ? scoped[siteId] === 'admin' : req.user?.role === 'admin';
  if (!ok) res.status(scoped && !scoped[siteId] ? 404 : 403).json({ error: scoped && !scoped[siteId] ? 'Site not found' : 'You need admin access to that site.' });
  return ok;
}

router.get('/:id/poll-settings', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid site id' });
  if (req.user?.siteRoles && !req.user.siteRoles[id]) return res.status(404).json({ error: 'Site not found' });
  const row = await queryOne<{ poll_overrides: unknown }>(`SELECT poll_overrides FROM sites WHERE id = $1`, [id]);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  const site = cleanOverrides(row.poll_overrides);
  return res.json({ overrides: site, effective: resolveEffective(await globalSettings(), site, null) });
});

router.put('/:id/poll-settings', requireWrite, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid site id' });
  if (!siteAdminOrRefuse(req, res, id)) return;
  const row = await queryOne<{ poll_overrides: unknown }>(`SELECT poll_overrides FROM sites WHERE id = $1`, [id]);
  if (!row) return res.status(404).json({ error: 'Site not found' });
  const v = validateOverrides(cleanOverrides(row.poll_overrides), req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  await query(`UPDATE sites SET poll_overrides = $2, updated_at = NOW() WHERE id = $1`,
    [id, Object.keys(v.value).length ? JSON.stringify(v.value) : null]);
  return res.json({ overrides: v.value, effective: resolveEffective(await globalSettings(), v.value, null) });
});

router.get('/', async (req, res) => {
  // A site-scoped account sees only its own sites (P1-7).
  const own = req.user?.siteRoles ? Object.keys(req.user.siteRoles).map(Number) : null;
  const sites = await query<SiteRow & { device_count: string }>(
    `SELECT s.id, s.name, s.address,
            s.location_lat::float8 AS location_lat,
            s.location_lng::float8 AS location_lng, s.map_zoom,
            s.notes, s.is_default, s.created_at, s.group_id, g.name AS group_name, s.default_jump_host_id,
            COUNT(d.id)::text AS device_count,
            COUNT(d.id) FILTER (WHERE d.status = 'online')::text AS online_count
     FROM sites s
     LEFT JOIN devices d ON d.site_id = s.id
     LEFT JOIN site_groups g ON g.id = s.group_id
     ${own ? 'WHERE s.id = ANY($1::int[])' : ''}
     GROUP BY s.id, g.name
     ORDER BY s.is_default DESC, LOWER(s.name) ASC`,
    own ? [own] : []
  );
  res.json(sites.map((s) => ({
    ...s,
    device_count: parseInt(s.device_count, 10),
    online_count: parseInt((s as unknown as { online_count: string }).online_count, 10),
  })));
});

// POST /api/sites — create
router.post('/', requireWrite, async (req, res) => {
  if (!refuseUnlessFleet(req, res)) return;
  const { name, error } = normaliseName((req.body as { name?: string }).name);
  if (error) { res.status(400).json({ error }); return; }

  const { address, notes } = req.body as { address?: string; notes?: string };
  const { lat, lng } = normaliseCoords(
    (req.body as { location_lat?: unknown }).location_lat,
    (req.body as { location_lng?: unknown }).location_lng
  );

  const zoom = parseMapZoom((req.body as { map_zoom?: unknown }).map_zoom);
  if (!zoom.ok) { res.status(400).json({ error: zoom.error }); return; }
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM sites WHERE LOWER(name) = LOWER($1)`, [name]
  );
  if (existing) { res.status(409).json({ error: 'A site with that name already exists' }); return; }
  const group = await parseGroupId(req, res);
  if (!group.ok) return;

  const rows = await query<SiteRow>(
    `INSERT INTO sites (name, address, location_lat, location_lng, notes, group_id, map_zoom)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, address, location_lat::float8 AS location_lat,
               location_lng::float8 AS location_lng, map_zoom, notes, is_default, created_at, group_id`,
    [name, address?.trim() || null, lat, lng, notes?.trim() || null, group.value ?? null, zoom.value ?? null]
  );
  if (group.value != null) groupsChanged();
  res.status(201).json({ ...rows[0], device_count: 0, online_count: 0 });
});

// PUT /api/sites/:id — rename / set address / notes
router.put('/:id', requireWrite, async (req, res) => {
  if (!refuseUnlessSiteAdmin(req, res, parseInt(req.params.id, 10))) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid site id' }); return; }

  const body = req.body as {
    name?: string; address?: string; notes?: string;
    location_lat?: unknown; location_lng?: unknown;
    default_jump_host_id?: unknown; map_zoom?: unknown;
  };
  const zoom = parseMapZoom(body.map_zoom);
  if (!zoom.ok) { res.status(400).json({ error: zoom.error }); return; }

  // Pre-fills new devices only: existing devices keep their own route.
  let defaultJumpHost: number | null | undefined;
  if (body.default_jump_host_id !== undefined) {
    try {
      defaultJumpHost = await chooseJumpHost(body.default_jump_host_id, id, { siteDefault: false });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  let name: string | null = null;
  if (body.name !== undefined) {
    const parsed = normaliseName(body.name);
    if (parsed.error) { res.status(400).json({ error: parsed.error }); return; }
    name = parsed.name!;
    const clash = await queryOne<{ id: number }>(
      `SELECT id FROM sites WHERE LOWER(name) = LOWER($1) AND id <> $2`, [name, id]
    );
    if (clash) { res.status(409).json({ error: 'A site with that name already exists' }); return; }
  }

  // Address and coordinates travel together: changing the address without
  // re-geocoding would leave the pin on the old location, which is worse than
  // no pin at all.
  const addressGiven = body.address !== undefined;
  const { lat, lng } = normaliseCoords(body.location_lat, body.location_lng);
  const group = await parseGroupId(req, res);
  if (!group.ok) return;

  const rows = await query<SiteRow>(
    `UPDATE sites SET
       name         = COALESCE($1, name),
       address      = CASE WHEN $2::boolean THEN $3 ELSE address END,
       location_lat = CASE WHEN $2::boolean THEN $4 ELSE location_lat END,
       location_lng = CASE WHEN $2::boolean THEN $5 ELSE location_lng END,
       notes        = COALESCE($6, notes),
       group_id     = CASE WHEN $8::boolean THEN $9 ELSE group_id END,
       default_jump_host_id = CASE WHEN $10::boolean THEN $11::integer ELSE default_jump_host_id END,
       map_zoom     = CASE WHEN $12::boolean THEN $13::smallint ELSE map_zoom END,
       updated_at   = NOW()
     WHERE id = $7
     RETURNING id, name, address, location_lat::float8 AS location_lat,
               location_lng::float8 AS location_lng, map_zoom, notes, is_default, created_at, group_id, default_jump_host_id`,
    [name, addressGiven, body.address?.trim() || null, lat, lng, body.notes?.trim() ?? null, id,
     group.value !== undefined, group.value ?? null, defaultJumpHost !== undefined, defaultJumpHost ?? null,
     zoom.value !== undefined, zoom.value ?? null]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Site not found' }); return; }
  if (group.value !== undefined) groupsChanged();
  res.json(rows[0]);
});

// DELETE /api/sites/:id — refused while devices remain, and never for the last site
router.delete('/:id', requireWrite, async (req, res) => {
  if (!refuseUnlessFleet(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid site id' }); return; }

  const site = await queryOne<{ id: number; name: string }>(`SELECT id, name FROM sites WHERE id = $1`, [id]);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }

  // Deleting a site must never delete the devices in it. Make the operator move
  // them first, so the destination is a decision rather than a side effect.
  const count = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM devices WHERE site_id = $1`, [id]
  );
  const devices = parseInt(count?.n ?? '0', 10);
  if (devices > 0) {
    res.status(409).json({
      error: `"${site.name}" still contains ${devices} device${devices === 1 ? '' : 's'}. `
           + 'Move them to another site before deleting it.',
      device_count: devices,
    });
    return;
  }

  // An account whose only access is this site would be left with none, which
  // makes it fleet-wide: refuse rather than widen it (#306).
  const stranded = await accountsOnlyReaching({ siteId: id });
  if (stranded.length > 0) {
    res.status(409).json({
      error: `${stranded.join(', ')} ${stranded.length === 1 ? 'has' : 'have'} access only to "${site.name}". `
           + 'Give them access elsewhere, or remove the account, before deleting the site.',
      accounts: stranded,
    });
    return;
  }

  // Count and delete under one lock: two deletes at once each saw two sites
  // and removed both (outside review S10).
  const deleted = await transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sites:delete'))`);
    const total = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sites`);
    if (parseInt(total.rows[0]?.n ?? '0', 10) <= 1) return false;
    await client.query(`DELETE FROM sites WHERE id = $1`, [id]);
    return true;
  });
  if (!deleted) {
    res.status(409).json({ error: 'Cannot delete the only site' });
    return;
  }
  // Its group, and roles on it, are gone with it.
  groupsChanged();
  res.json({ ok: true });
});

// POST /api/sites/:id/devices — move devices into this site
router.post('/:id/devices', requireWrite, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid site id' }); return; }

  const { deviceIds } = req.body as { deviceIds: number[] };
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ error: 'deviceIds array required' });
    return;
  }
  const ids = strictIdList(deviceIds);
  if (!ids || ids.length === 0) { res.status(400).json({ error: 'deviceIds must be device ids' }); return; }

  const site = await queryOne<{ id: number }>(`SELECT id FROM sites WHERE id = $1`, [id]);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }

  // Moving a device changes who can reach it, so a site-scoped account needs
  // admin of the destination and of each device's current site (P1-7).
  if (req.user?.siteRoles) {
    if (!refuseUnlessSiteAdmin(req, res, id)) return;
    if ((await devicesDenied(req.user, ids, 'admin')).length > 0) {
      res.status(404).json({ error: 'Some of those devices were not found.' });
      return;
    }
  }

  // A site's jump host only serves that site's devices; one moved away would
  // go on using it from another site.
  const viaOtherSite = await query<{ name: string; jump_host: string }>(
    `SELECT d.name, j.name AS jump_host FROM devices d JOIN jump_hosts j ON j.id = d.jump_host_id
      WHERE d.id = ANY($1::int[]) AND j.site_id IS NOT NULL AND j.site_id <> $2
      ORDER BY d.name`, [ids, id]);
  if (viaOtherSite.length > 0) {
    const [first] = viaOtherSite;
    const others = viaOtherSite.length - 1;
    const who = others === 0 ? `${first.name} connects`
      : `${first.name} and ${others} other device${others === 1 ? '' : 's'} connect`;
    const their = others === 0 ? 'its' : 'their';
    res.status(409).json({
      error: `${who} through jump host "${first.jump_host}", which belongs to ${their} current site. `
        + `Change ${their} connection first, or make the jump host fleet-wide.`,
      code: 'jump_host_other_site',
    });
    return;
  }

  await query(`UPDATE devices SET site_id = $1 WHERE id = ANY($2::int[])`, [id, ids]);
  res.json({ ok: true, moved: ids.length });
});

export default router;
