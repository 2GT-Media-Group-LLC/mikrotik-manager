import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const MAX_NAME = 120;

export interface SiteRow {
  id: number;
  name: string;
  address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  notes: string | null;
  is_default: boolean;
  created_at: string;
}

/** Shared validation so create and rename cannot drift apart. */
function normaliseName(raw: unknown): { name?: string; error?: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Site name is required' };
  if (name.length > MAX_NAME) return { error: `Site name must be ${MAX_NAME} characters or fewer` };
  return { name };
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
router.get('/', async (_req: Request, res: Response) => {
  const sites = await query<SiteRow & { device_count: string }>(
    `SELECT s.id, s.name, s.address,
            s.location_lat::float8 AS location_lat,
            s.location_lng::float8 AS location_lng,
            s.notes, s.is_default, s.created_at,
            COUNT(d.id)::text AS device_count,
            COUNT(d.id) FILTER (WHERE d.status = 'online')::text AS online_count
     FROM sites s
     LEFT JOIN devices d ON d.site_id = s.id
     GROUP BY s.id
     ORDER BY s.is_default DESC, LOWER(s.name) ASC`
  );
  res.json(sites.map((s) => ({
    ...s,
    device_count: parseInt(s.device_count, 10),
    online_count: parseInt((s as unknown as { online_count: string }).online_count, 10),
  })));
});

// POST /api/sites — create
router.post('/', requireWrite, async (req: Request, res: Response) => {
  const { name, error } = normaliseName((req.body as { name?: string }).name);
  if (error) { res.status(400).json({ error }); return; }

  const { address, notes } = req.body as { address?: string; notes?: string };
  const { lat, lng } = normaliseCoords(
    (req.body as { location_lat?: unknown }).location_lat,
    (req.body as { location_lng?: unknown }).location_lng
  );

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM sites WHERE LOWER(name) = LOWER($1)`, [name]
  );
  if (existing) { res.status(409).json({ error: 'A site with that name already exists' }); return; }

  const rows = await query<SiteRow>(
    `INSERT INTO sites (name, address, location_lat, location_lng, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, address, location_lat::float8 AS location_lat,
               location_lng::float8 AS location_lng, notes, is_default, created_at`,
    [name, address?.trim() || null, lat, lng, notes?.trim() || null]
  );
  res.status(201).json({ ...rows[0], device_count: 0, online_count: 0 });
});

// PUT /api/sites/:id — rename / set address / notes
router.put('/:id', requireWrite, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid site id' }); return; }

  const body = req.body as {
    name?: string; address?: string; notes?: string;
    location_lat?: unknown; location_lng?: unknown;
  };

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

  const rows = await query<SiteRow>(
    `UPDATE sites SET
       name         = COALESCE($1, name),
       address      = CASE WHEN $2::boolean THEN $3 ELSE address END,
       location_lat = CASE WHEN $2::boolean THEN $4 ELSE location_lat END,
       location_lng = CASE WHEN $2::boolean THEN $5 ELSE location_lng END,
       notes        = COALESCE($6, notes),
       updated_at   = NOW()
     WHERE id = $7
     RETURNING id, name, address, location_lat::float8 AS location_lat,
               location_lng::float8 AS location_lng, notes, is_default, created_at`,
    [name, addressGiven, body.address?.trim() || null, lat, lng, body.notes?.trim() ?? null, id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Site not found' }); return; }
  res.json(rows[0]);
});

// DELETE /api/sites/:id — refused while devices remain, and never for the last site
router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
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

  const total = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sites`);
  if (parseInt(total?.n ?? '0', 10) <= 1) {
    res.status(409).json({ error: 'Cannot delete the only site' });
    return;
  }

  await query(`DELETE FROM sites WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// POST /api/sites/:id/devices — move devices into this site
router.post('/:id/devices', requireWrite, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid site id' }); return; }

  const { deviceIds } = req.body as { deviceIds: number[] };
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ error: 'deviceIds array required' });
    return;
  }
  const ids = deviceIds.map((d) => parseInt(String(d), 10)).filter(Number.isInteger);
  if (ids.length === 0) { res.status(400).json({ error: 'deviceIds array required' }); return; }

  const site = await queryOne<{ id: number }>(`SELECT id FROM sites WHERE id = $1`, [id]);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }

  await query(`UPDATE devices SET site_id = $1 WHERE id = ANY($2::int[])`, [id, ids]);
  res.json({ ok: true, moved: ids.length });
});

export default router;
