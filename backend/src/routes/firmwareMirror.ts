/**
 * Local firmware mirror (#193): package servers, what they hold, and which
 * devices pull from them.
 *
 * One mirror for the whole fleet, and optionally one per site. Fleet admins
 * manage the fleet mirror; a site admin manages their own site's. Anyone who
 * can see a site can see its mirror.
 */
import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { presetCaller, type PresetCaller } from '../utils/presetAccess';
import {
  getMirror, deployMirror, syncMirror, setClients, removeMirror, scopeDevices, latestVersion, type MirrorRow,
} from '../services/firmwareMirror';
import {
  planFiles, isMirrorFolder, isMirrorVersion, clampKeepVersions, supportsLocalUpdate, DEFAULT_MIRROR_FOLDER,
} from '../utils/firmwareMirror';
import { normalizeDeviceAddress } from '../utils/deviceAddress';

const router = Router();
router.use(requireAuth);

const caller = (req: Request): PresetCaller => presetCaller(req.user);
const canManage = (c: PresetCaller, siteId: number | null) => c.fleetAdmin || (siteId != null && c.adminSites.includes(siteId));
const canSee = (c: PresetCaller, siteId: number | null) =>
  c.memberSites == null || (siteId != null && c.memberSites.includes(siteId)) || (siteId == null && c.fleetAdmin);

const CHANNELS = new Set(['stable', 'long-term']);

async function loadVisible(req: Request, res: Response, manage: boolean): Promise<MirrorRow | null> {
  const id = Number(req.params.id);
  const m = Number.isInteger(id) ? await getMirror(id) : null;
  const c = caller(req);
  if (!m || !canSee(c, m.site_id)) { res.status(404).json({ error: 'Mirror not found' }); return null; }
  if (manage && !canManage(c, m.site_id)) {
    res.status(403).json({ error: m.site_id == null ? 'Only fleet administrators manage the fleet mirror' : 'Only this site’s administrators manage its mirror' });
    return null;
  }
  return m;
}

async function describe(m: MirrorRow, c: PresetCaller) {
  const server = await queryOne<{ id: number; name: string; ip_address: string; ros_version: string | null }>(
    `SELECT id, name, ip_address, ros_version FROM devices WHERE id = $1`, [m.device_id]);
  const site = m.site_id == null ? null : await queryOne<{ id: number; name: string }>(`SELECT id, name FROM sites WHERE id = $1`, [m.site_id]);
  const files = await query<{ version: string; package: string; architecture: string; filename: string; size_bytes: string }>(
    `SELECT version, package, architecture, filename, size_bytes FROM firmware_mirror_files WHERE mirror_id = $1 ORDER BY filename`, [m.id]);
  const versions = new Map<string, { version: string; files: { package: string; architecture: string; filename: string; size_bytes: number }[]; total_bytes: number }>();
  for (const f of files) {
    if (!versions.has(f.version)) versions.set(f.version, { version: f.version, files: [], total_bytes: 0 });
    const v = versions.get(f.version)!;
    const size = Number(f.size_bytes);
    v.files.push({ package: f.package, architecture: f.architecture, filename: f.filename, size_bytes: size });
    v.total_bytes += size;
  }
  const clients = await query<{ device_id: number; name: string; status: string; error: string | null }>(
    `SELECT c.device_id, d.name, c.status, c.error FROM firmware_mirror_clients c JOIN devices d ON d.id = c.device_id
      WHERE c.mirror_id = $1 ORDER BY d.name`, [m.id]);
  return {
    id: m.id,
    server: server ? { id: server.id, name: server.name.trim(), ip_address: server.ip_address, ros_version: server.ros_version } : null,
    site,
    folder: m.folder,
    serve_address: m.serve_address,
    effective_address: (m.serve_address || server?.ip_address || '').trim(),
    username: m.username,
    keep_versions: m.keep_versions,
    auto_sync: m.auto_sync,
    channel: m.channel,
    status: m.status,
    last_error: m.last_error,
    last_sync_at: m.last_sync_at,
    free_bytes: m.free_bytes == null ? null : Number(m.free_bytes),
    total_bytes: m.total_bytes == null ? null : Number(m.total_bytes),
    used_bytes: files.reduce((n, f) => n + Number(f.size_bytes), 0),
    versions: [...versions.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })),
    clients,
    can_manage: canManage(c, m.site_id),
  };
}

// GET /api/firmware/mirrors
router.get('/', async (req: Request, res: Response) => {
  const c = caller(req);
  const rows = await query<MirrorRow>(`SELECT * FROM firmware_mirrors ORDER BY site_id NULLS FIRST, id`);
  const visible = rows.filter((m) => canSee(c, m.site_id));
  res.json({
    mirrors: await Promise.all(visible.map((m) => describe(m, c))),
    can_create_fleet: c.fleetAdmin && !rows.some((m) => m.site_id == null),
    admin_sites: c.fleetAdmin ? null : c.adminSites,
  });
});

// GET /api/firmware/mirrors/:id/devices — the devices it can serve, for switching them over
router.get('/:id/devices', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, false);
  if (!m) return;
  const devices = await scopeDevices(m);
  const clients = new Map((await query<{ device_id: number; mirror_id: number; status: string; error: string | null }>(
    `SELECT device_id, mirror_id, status, error FROM firmware_mirror_clients`)).map((r) => [r.device_id, r]));
  res.json(devices.map((d) => {
    const cl = clients.get(d.id);
    return {
      id: d.id,
      name: d.name.trim(),
      ros_version: d.ros_version,
      architecture: d.architecture,
      packages: d.installed_packages ?? [],
      is_server: d.id === m.device_id,
      supported: supportsLocalUpdate(d.ros_version),
      client: cl ? { mirror_id: cl.mirror_id, this_mirror: cl.mirror_id === m.id, status: cl.status, error: cl.error } : null,
    };
  }));
});

// GET /api/firmware/mirrors/:id/plan?version= — what a sync would fetch
router.get('/:id/plan', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, false);
  if (!m) return;
  try {
    const requested = typeof req.query.version === 'string' && req.query.version ? req.query.version : null;
    if (requested && !isMirrorVersion(requested)) return res.status(400).json({ error: 'version must be a RouterOS 7 release such as 7.24.5' });
    const version = requested ?? await latestVersion(m.channel);
    res.json({ version, ...planFiles(await scopeDevices(m), version) });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// POST /api/firmware/mirrors — choose a package server and set it up
router.post('/', async (req: Request, res: Response) => {
  const c = caller(req);
  const body = req.body as { device_id?: number; site_id?: number | null; folder?: string; serve_address?: string | null; keep_versions?: number; auto_sync?: boolean; channel?: string };
  const siteId = body.site_id == null ? null : Number(body.site_id);
  if (siteId != null && !Number.isInteger(siteId)) return res.status(400).json({ error: 'site_id must be a site id or null' });
  if (!canManage(c, siteId)) return res.status(403).json({ error: siteId == null ? 'Only fleet administrators set up the fleet mirror' : 'Only this site’s administrators set up its mirror' });
  const server = await queryOne<{ id: number; site_id: number | null; ros_version: string | null; name: string }>(
    `SELECT id, site_id, ros_version, name FROM devices WHERE id = $1`, [Number(body.device_id)]);
  if (!server) return res.status(400).json({ error: 'Choose the device to use as the package server' });
  if (siteId != null && server.site_id !== siteId) return res.status(400).json({ error: 'A site’s package server has to be one of that site’s devices' });
  if (!c.fleetAdmin && (server.site_id == null || !c.adminSites.includes(server.site_id))) return res.status(403).json({ error: 'You can only use devices in sites you administer' });
  if (!supportsLocalUpdate(server.ros_version)) return res.status(400).json({ error: `${server.name.trim()} runs RouterOS ${server.ros_version || 'unknown'}; a package server needs 7.17 or later` });
  const folder = (body.folder || DEFAULT_MIRROR_FOLDER).trim();
  if (!isMirrorFolder(folder)) return res.status(400).json({ error: 'The folder name can use letters, digits, - and _ only' });
  const serve = await parseServeAddress(body.serve_address);
  if (serve.error) return res.status(400).json({ error: serve.error });
  const channel = CHANNELS.has(body.channel || '') ? body.channel! : 'stable';
  const exists = await queryOne(`SELECT 1 FROM firmware_mirrors WHERE COALESCE(site_id, 0) = COALESCE($1::int, 0)`, [siteId]);
  if (exists) return res.status(409).json({ error: siteId == null ? 'The fleet already has a mirror' : 'This site already has a mirror' });

  const row = await queryOne<{ id: number }>(
    `INSERT INTO firmware_mirrors (device_id, site_id, folder, serve_address, keep_versions, auto_sync, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [server.id, siteId, folder, serve.value, clampKeepVersions(body.keep_versions ?? 3), body.auto_sync !== false, channel]);
  try {
    await deployMirror(row!.id);
  } catch (e) {
    await query(`DELETE FROM firmware_mirrors WHERE id = $1`, [row!.id]);
    return res.status(502).json({ error: `Couldn’t set up ${server.name.trim()}: ${(e as Error).message}` });
  }
  res.status(201).json(await describe((await getMirror(row!.id))!, c));
});

async function parseServeAddress(raw: unknown): Promise<{ value: string | null; error?: string }> {
  if (raw == null || raw === '') return { value: null };
  const n = normalizeDeviceAddress(String(raw));
  if (!n.ok) return { value: null, error: n.reason };
  return { value: n.address };
}

// PUT /api/firmware/mirrors/:id — settings
router.put('/:id', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, true);
  if (!m) return;
  const body = req.body as { serve_address?: string | null; keep_versions?: number; auto_sync?: boolean; channel?: string };
  const sets: string[] = [];
  const vals: unknown[] = [m.id];
  if (body.keep_versions !== undefined) { vals.push(clampKeepVersions(body.keep_versions)); sets.push(`keep_versions = $${vals.length}`); }
  if (body.auto_sync !== undefined) { vals.push(body.auto_sync === true); sets.push(`auto_sync = $${vals.length}`); }
  if (body.channel !== undefined) {
    if (!CHANNELS.has(body.channel)) return res.status(400).json({ error: 'channel must be stable or long-term' });
    vals.push(body.channel); sets.push(`channel = $${vals.length}`);
  }
  let addressChanged = false;
  if (body.serve_address !== undefined) {
    const serve = await parseServeAddress(body.serve_address);
    if (serve.error) return res.status(400).json({ error: serve.error });
    addressChanged = (serve.value || null) !== (m.serve_address || null);
    vals.push(serve.value); sets.push(`serve_address = $${vals.length}`);
  }
  if (sets.length) await query(`UPDATE firmware_mirrors SET ${sets.join(', ')} WHERE id = $1`, vals);
  // Devices are told the new address straight away.
  let clientResults = null;
  if (addressChanged) {
    const ids = (await query<{ device_id: number }>(`SELECT device_id FROM firmware_mirror_clients WHERE mirror_id = $1`, [m.id])).map((r) => r.device_id);
    if (ids.length) clientResults = await setClients(m.id, ids, true);
  }
  res.json({ mirror: await describe((await getMirror(m.id))!, caller(req)), clients: clientResults });
});

// POST /api/firmware/mirrors/:id/deploy — redo the package server login (new password), and tell the devices
router.post('/:id/deploy', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, true);
  if (!m) return;
  try {
    const out = await deployMirror(m.id);
    const ids = (await query<{ device_id: number }>(`SELECT device_id FROM firmware_mirror_clients WHERE mirror_id = $1`, [m.id])).map((r) => r.device_id);
    const clients = ids.length ? await setClients(m.id, ids, true) : [];
    res.json({ user: out.user, clients, mirror: await describe((await getMirror(m.id))!, caller(req)) });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// POST /api/firmware/mirrors/:id/sync { version? } — runs in the background; poll GET for status
router.post('/:id/sync', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, true);
  if (!m) return;
  const version = (req.body as { version?: string })?.version;
  if (version !== undefined && !isMirrorVersion(version)) return res.status(400).json({ error: 'version must be a RouterOS 7 release such as 7.24.5' });
  if (m.status === 'syncing') return res.status(409).json({ error: 'This mirror is already syncing' });
  await query(`UPDATE firmware_mirrors SET status = 'syncing', last_error = NULL WHERE id = $1`, [m.id]);
  void syncMirror(m.id, version).catch((e) => console.warn(`[Mirror] #${m.id} sync: ${(e as Error).message}`));
  res.status(202).json({ started: true });
});

// POST /api/firmware/mirrors/:id/clients { device_ids, enable }
router.post('/:id/clients', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, true);
  if (!m) return;
  const body = req.body as { device_ids?: unknown; enable?: boolean };
  const ids = Array.isArray(body.device_ids) ? body.device_ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'device_ids is required' });
  const scope = new Set((await scopeDevices(m)).map((d) => d.id));
  const outside = ids.filter((id) => !scope.has(id));
  if (outside.length) return res.status(400).json({ error: m.site_id == null ? 'Some devices belong to a site with its own mirror' : 'Some devices aren’t in this mirror’s site' });
  try {
    res.json({ results: await setClients(m.id, ids, body.enable !== false) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// DELETE /api/firmware/mirrors/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const m = await loadVisible(req, res, true);
  if (!m) return;
  try {
    res.json(await removeMirror(m.id));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
