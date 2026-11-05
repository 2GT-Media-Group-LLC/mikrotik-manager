import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireWrite } from '../middleware/auth';
import { activeSite } from '../middleware/site';
import { siteScopeDevices } from '../utils/siteScope';
import { strictId } from '../utils/siteAccess';
import { withGuardedChange } from '../services/changeGuard/guardedRoute';
import { previewContext } from '../utils/previewContext';
import { isNewerRosVersion } from '../utils/rosVersion';
import { DeviceCollector, type DeviceRow } from '../services/mikrotik/DeviceCollector';
import {
  ARCHES, isOpenEntry, netinstallSupport, normalizeMac, checkEntry, checkInstall, cacheStorage, cacheEstimate,
  cacheSpaceProblem, packageSpaceProblem, cacheDirectoryError, packageListCheck, isRosRelease, NETINSTALL_MIN_VERSION,
  type RosRow,
} from '../utils/netinstall';

/**
 * Netinstall from RouterOS devices (#310), under /api/network-services, so the
 * site check, per-device write lock and secret masking of that router apply.
 *
 * Reads are live: what a device's Netinstall is doing changes by the second
 * while a target etherboots. Server entries, the cache and its settings are
 * written under Change Guard like every other network service. Installing or
 * removing the package reboots the device, so it's sent like a RouterOS
 * update: once, without a revert, and the poller sees the result.
 */
const router = Router();

function deviceIdParam(req: Request, res: Response): number | null {
  const id = strictId(req.query.deviceId);
  if (!id) { res.status(400).json({ error: 'deviceId query param is required' }); return null; }
  return id;
}

async function deviceRow(id: number): Promise<DeviceRow | null> {
  return queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
}

type Live = Awaited<ReturnType<DeviceCollector['getNetinstall']>>;

async function readLive(device: DeviceRow): Promise<Live> {
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    return await c.getNetinstall();
  } finally {
    c.disconnect();
  }
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Managed devices whose interfaces carry one of these MACs, in the selected site. */
async function managedByMac(req: Request, macs: string[]): Promise<Map<string, { id: number; name: string }>> {
  const list = [...new Set(macs.map(normalizeMac).filter((m): m is string => !!m))];
  if (!list.length) return new Map();
  const scope = siteScopeDevices(activeSite(req), 'd');
  const rows = await query<{ mac: string; id: number; name: string }>(
    `SELECT DISTINCT ON (UPPER(i.mac_address)) UPPER(i.mac_address) AS mac, d.id, d.name
       FROM interfaces i JOIN devices d ON d.id = i.device_id
      WHERE UPPER(i.mac_address) = ANY($1::text[]) ${scope ? `AND ${scope}` : ''}
      ORDER BY UPPER(i.mac_address), d.id`,
    [list]
  );
  return new Map(rows.map((r) => [r.mac, { id: r.id, name: r.name }]));
}

function summarize(device: DeviceRow, live: Live) {
  const pkg = live.packages.find((p) => p.name === 'netinstall');
  const installed = !!pkg && pkg.available !== 'true' && pkg.disabled !== 'true';
  const sizes = Object.fromEntries(live.packages.map((p) => [p.name, num(p.size)]));
  const serverArch = live.resource['architecture-name'] ?? (device as DeviceRow & { architecture?: string | null }).architecture ?? null;
  const storage = cacheStorage(live.settings['cache-directory'] ?? 'NetinstallCache/', live.files, live.disks, live.resource);
  // An install for a device of unknown architecture, with no extra packages.
  const estimate = cacheEstimate({ arch: null, serverArch, sizes, extras: [] });
  return {
    pkg, installed, sizes, serverArch, storage, estimate,
    // Other package changes waiting for apply-changes: applying ours would make them too.
    pending: live.packages.filter((p) => p.name !== 'netinstall' && (p.scheduled ?? '') !== '').map((p) => `${p.name} (${p.scheduled})`),
    knownPackages: live.packages.map((p) => p.name).filter(Boolean),
    interfaces: live.interfaces.map((i) => i.name).filter(Boolean),
  };
}

// ─── Package changes in flight ───────────────────────────────────────────────

/**
 * Package installs and removals sent from here, until the device shows the
 * result. The slow poll that records packages can be five minutes away, so
 * once the device is back the fleet list reads its packages itself.
 */
const PENDING_MS = 15 * 60_000;
const pendingChanges = new Map<number, { action: 'install' | 'remove'; at: number }>();

type PkgRow = { id: number; status: string; installed_packages: string[] | null; disabled_packages: string[] | null };

async function settlePending(d: PkgRow): Promise<'install' | 'remove' | null> {
  const p = pendingChanges.get(d.id);
  if (!p) return null;
  const running = (x: Pick<PkgRow, 'installed_packages' | 'disabled_packages'>) =>
    !!x.installed_packages?.includes('netinstall') && !x.disabled_packages?.includes('netinstall');
  const done = (x: Pick<PkgRow, 'installed_packages' | 'disabled_packages'>) => (p.action === 'install') === running(x);
  if (Date.now() - p.at > PENDING_MS || done(d)) { pendingChanges.delete(d.id); return null; }
  // Still rebooting, or only just back.
  if (d.status !== 'online' || Date.now() - p.at < 20_000) return p.action;
  const row = await deviceRow(d.id);
  if (!row) { pendingChanges.delete(d.id); return null; }
  const c = new DeviceCollector(row);
  try {
    await c.connect();
    const st = await c.getPackageState();
    await query(`UPDATE devices SET installed_packages = $2::text[], disabled_packages = $3::text[] WHERE id = $1`, [d.id, st.installed, st.disabled]);
    d.installed_packages = st.installed;
    d.disabled_packages = st.disabled;
    if (done(d)) { pendingChanges.delete(d.id); return null; }
  } catch { /* not answering yet */ } finally { c.disconnect(); }
  return p.action;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** GET /netinstall: every device in the site, and whether it can run Netinstall. */
router.get('/', async (req, res) => {
  const scope = siteScopeDevices(activeSite(req), 'd');
  const rows = await query<PkgRow & {
    name: string; device_type: string; model: string | null; ros_version: string | null; architecture: string | null;
  }>(
    `SELECT d.id, d.name, d.status, d.device_type, d.model, d.ros_version, d.architecture, d.installed_packages, d.disabled_packages
       FROM devices d ${scope ? `WHERE ${scope}` : ''} ORDER BY d.name`
  );
  const changing = await Promise.all(rows.map((r) => settlePending(r)));
  res.json({
    min_version: NETINSTALL_MIN_VERSION,
    devices: rows.map(({ installed_packages, disabled_packages, ...d }, i) => ({
      ...d, support: netinstallSupport({ ...d, installed_packages, disabled_packages }), package_change: changing[i],
    })),
  });
});

/** GET /netinstall/device?deviceId=: the device's Netinstall, read live. */
router.get('/device', async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const device = await deviceRow(id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  let live: Live;
  try { live = await readLive(device); } catch (err) {
    return res.status(502).json({ error: `Couldn't read the device: ${(err as Error).message}` });
  }
  const s = summarize(device, live);
  const managed = await managedByMac(req, [...live.devices, ...live.entries].map((r) => r['mac-address']));
  const tag = (mac: string | undefined) => managed.get(normalizeMac(mac) ?? '') ?? null;
  return res.json({
    device: { id: device.id, name: device.name, status: device.status, ros_version: device.ros_version },
    support: s.installed ? 'installed' : netinstallSupport({ ros_version: live.resource.version?.split(' ')[0] ?? device.ros_version,
      architecture: s.serverArch, installed_packages: [] }),
    package: s.pkg ? { version: s.pkg.version || null, size: num(s.pkg.size), installed: s.installed, scheduled: s.pkg.scheduled || null } : null,
    pending: s.pending,
    entries: live.entries.map((e) => ({ ...e, open: isOpenEntry(e), managed: tag(e['mac-address']) })),
    cache: live.cache,
    devices: live.devices.map((d) => ({ ...d, managed: tag(d['mac-address']) })),
    cache_directory: live.settings['cache-directory'] ?? 'NetinstallCache/',
    storage: s.storage,
    install_estimate: s.estimate,
    space_problem: cacheSpaceProblem(s.storage, s.estimate),
    server_arch: s.serverArch,
    interfaces: s.interfaces,
    packages: s.knownPackages,
    disks: live.disks.map((d) => ({ name: d['mount-point'] || d.slot || d.name, type: d.type ?? null, free: num(d.free) || null, size: num(d.size) || null })),
  });
});

// ─── The package ─────────────────────────────────────────────────────────────

/**
 * POST /netinstall/package?deviceId= { action: 'install' | 'remove', confirm: true }.
 * Either reboots the device.
 */
router.post('/package', requireWrite, async (req, res) => {
  const id = deviceIdParam(req, res); if (!id) return;
  const action = req.body?.action;
  if (action !== 'install' && action !== 'remove') return res.status(400).json({ error: 'action must be install or remove' });
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: `${action === 'install' ? 'Installing' : 'Removing'} the package reboots the device. Repeat with {"confirm": true}.` });
  }
  const device = await deviceRow(id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    const live = await c.getNetinstall();
    const s = summarize(device, live);
    if (!s.pkg) {
      return res.status(409).json({ error: `This device doesn't offer the netinstall package. It needs RouterOS ${NETINSTALL_MIN_VERSION} or later, and isn't available for SMIPS.` });
    }
    if (action === 'install' && s.installed) return res.status(409).json({ error: 'The netinstall package is already installed.' });
    if (action === 'remove' && !s.installed) return res.status(409).json({ error: 'The netinstall package isn\'t installed.' });
    if (s.pending.length) {
      return res.status(409).json({ error: `Other package changes are waiting on this device (${s.pending.join(', ')}). Applying this one would make them too, so apply or cancel them first.` });
    }
    if (action === 'install') {
      const support = netinstallSupport({ ros_version: live.resource.version?.split(' ')[0] ?? device.ros_version, architecture: s.serverArch, installed_packages: [] });
      if (support !== 'available') return res.status(409).json({ error: `This device can't run Netinstall (${support}).` });
      const space = packageSpaceProblem(num(s.pkg.size), num(live.resource['free-hdd-space']) || null, num(live.resource['total-hdd-space']) || null);
      if (space) return res.status(409).json({ error: space });
    }
    // RouterOS can install the newest release with the package when its last
    // update check found one (it did on a test switch: enabling netinstall
    // took it from 7.25 to 7.25.1). Only with the user's say-so.
    const upd = await c.getUpdateVersions().catch(() => null);
    const installedV = (upd?.['installed-version'] ?? '').trim();
    const latestV = (upd?.['latest-version'] ?? '').trim();
    if (installedV && latestV && isNewerRosVersion(latestV, installedV) && req.body?.allow_upgrade !== true) {
      return res.status(409).json({
        error: `RouterOS ${latestV} is available for ${device.name}, which runs ${installedV}, and RouterOS may install it along with the package change. `
          + 'Allow the upgrade, or upgrade it from the Firmware page first.',
        upgrade_to: latestV,
      });
    }
    await c.changePackage(s.pkg['.id'], action === 'install');
    if (!previewContext()) pendingChanges.set(id, { action, at: Date.now() });
    return res.json({
      started: true,
      message: action === 'install'
        ? `Installing the netinstall package. ${device.name} reboots now; Netinstall shows here once it's back and polled.`
        : `Removing the netinstall package. ${device.name} reboots now.`,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  } finally {
    c.disconnect();
  }
});

// ─── Server entries ──────────────────────────────────────────────────────────

/** Read the device for a form: its interfaces, package names and entries, and where the cache is. */
async function formContext(device: DeviceRow) {
  const live = await readLive(device);
  const s = summarize(device, live);
  if (!s.installed) throw Object.assign(new Error('The netinstall package isn\'t installed on this device.'), { status: 409 });
  return { live, s };
}

function sendErrors(res: Response, errors: Record<string, string>) {
  return res.status(400).json({ error: Object.values(errors)[0], errors });
}

async function withForm(req: Request, res: Response, fn: (ctx: Awaited<ReturnType<typeof formContext>>, device: DeviceRow, id: number) => Promise<unknown>) {
  const id = deviceIdParam(req, res); if (!id) return;
  const device = await deviceRow(id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  let ctx: Awaited<ReturnType<typeof formContext>>;
  try { ctx = await formContext(device); } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return res.status(status).json({ error: status === 502 ? `Couldn't read the device: ${(err as Error).message}` : (err as Error).message });
  }
  return fn(ctx, device, id);
}

/** An entry that answers etherboot downloads into the cache; refuse one that would fill it. */
function entrySpace(ctx: Awaited<ReturnType<typeof formContext>>, params: Record<string, string>, existing?: RosRow): string | null {
  const merged = { ...existing, ...params };
  const disabled = (merged.disabled ?? 'false') === 'true' || merged.disabled === 'yes';
  if (disabled) return null;
  const extras = (merged['extra-packages'] ?? '').split(',').filter(Boolean);
  return cacheSpaceProblem(ctx.s.storage, cacheEstimate({ arch: null, serverArch: ctx.s.serverArch, sizes: ctx.s.sizes, extras }));
}

// POST /netinstall/entry?deviceId=
router.post('/entry', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const r = checkEntry(req.body ?? {}, { interfaces: ctx.s.interfaces, knownPackages: ctx.s.knownPackages });
  if (Object.keys(r.errors).length) return sendErrors(res, r.errors);
  const space = entrySpace(ctx, r.params);
  if (space) return sendErrors(res, { storage: space });
  await withGuardedChange(id, req, res, { kind: 'netinstall.add', summary: 'Add Netinstall server entry' },
    async (c) => { await c.addNetinstallEntry(r.params); return { success: true }; });
}));

// PUT /netinstall/entry/:id?deviceId=
router.put('/entry/:id', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const existing = ctx.live.entries.find((e) => e['.id'] === req.params.id);
  if (!existing) return res.status(404).json({ error: 'That entry is no longer on the device. Refresh the page.' });
  const r = checkEntry(req.body ?? {}, { interfaces: ctx.s.interfaces, knownPackages: ctx.s.knownPackages, existing });
  if (Object.keys(r.errors).length) return sendErrors(res, r.errors);
  if (!Object.keys(r.params).length) return res.json({ success: true, unchanged: true });
  const space = entrySpace(ctx, r.params, existing);
  if (space) return sendErrors(res, { storage: space });
  await withGuardedChange(id, req, res, { kind: 'netinstall.set', summary: 'Edit Netinstall server entry' },
    async (c) => { await c.setNetinstallEntry(existing['.id'], r.params); return { success: true }; });
}));

// DELETE /netinstall/entry/:id?deviceId=
router.delete('/entry/:id', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const existing = ctx.live.entries.find((e) => e['.id'] === req.params.id);
  if (!existing) return res.status(404).json({ error: 'That entry is no longer on the device. Refresh the page.' });
  await withGuardedChange(id, req, res, { kind: 'netinstall.remove', summary: 'Delete Netinstall server entry' },
    async (c) => { await c.removeNetinstallEntry(existing['.id']); return { success: true }; });
}));

// ─── Cache and settings ──────────────────────────────────────────────────────

// POST /netinstall/cache?deviceId= { arch, version?, packages? }
router.post('/cache', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const errors: Record<string, string> = {};
  const arch = String(req.body?.arch ?? '');
  if (!(ARCHES as readonly string[]).includes(arch)) errors.arch = 'Choose the architecture of the devices to install.';
  const version = String(req.body?.version ?? '').trim();
  if (version && !isRosRelease(version)) errors.version = 'Enter a RouterOS version like 7.25, or leave it empty for the latest.';
  const pk = packageListCheck(req.body?.packages, ctx.s.knownPackages);
  if (pk.error) errors.packages = pk.error;
  if (Object.keys(errors).length) return sendErrors(res, errors);
  const extras = pk.value.split(',').filter(Boolean);
  const space = cacheSpaceProblem(ctx.s.storage, cacheEstimate({ arch, serverArch: ctx.s.serverArch, sizes: ctx.s.sizes, extras }));
  if (space) return sendErrors(res, { storage: space });
  const params: Record<string, string> = { arch };
  if (version) params.version = version;
  if (pk.value) params.packages = pk.value;
  await withGuardedChange(id, req, res, { kind: 'netinstall.cache.add', summary: `Download Netinstall files for ${arch}` },
    async (c) => { await c.addNetinstallCache(params); return { success: true }; });
}));

// DELETE /netinstall/cache?deviceId=&path=
// By path: cache rows are numbered by position (*0, *1...), so an id read
// earlier can name another file once one is removed.
router.delete('/cache', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const path = String(req.query.path ?? '');
  const row = path ? ctx.live.cache.find((r) => r.path === path) : undefined;
  if (!row) return res.status(404).json({ error: 'That file is no longer in the cache. Refresh the page.' });
  await withGuardedChange(id, req, res, { kind: 'netinstall.cache.remove', summary: 'Remove a Netinstall cache file' },
    async (c) => { await c.removeNetinstallCache(row['.id']); return { success: true }; });
}));

// PUT /netinstall/settings?deviceId= { cache_directory }
router.put('/settings', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const dir = String(req.body?.cache_directory ?? '').trim().replace(/^\/+/, '');
  const e = cacheDirectoryError(dir, ctx.live.disks);
  if (e) return sendErrors(res, { cache_directory: e });
  await withGuardedChange(id, req, res, { kind: 'netinstall.settings', summary: 'Change the Netinstall cache folder' },
    async (c) => { await c.setNetinstallCacheDirectory(dir.endsWith('/') ? dir : `${dir}/`); return { success: true }; });
}));

// ─── Devices it sees ─────────────────────────────────────────────────────────

/**
 * POST /netinstall/devices/install?deviceId= { mac, confirm_mac, version?, extra-packages?, auto-reboot? }
 * Reinstall a device that's waiting. Its storage is erased. The device is
 * found by MAC, read again now, never by a row id from an earlier read: the
 * list's ids can name another device by the time the button is pressed.
 */
router.post('/devices/install', requireWrite, (req, res) => withForm(req, res, async (ctx, _device, id) => {
  const want = normalizeMac(req.body?.mac);
  const target = want ? ctx.live.devices.find((d) => normalizeMac(d['mac-address']) === want) : undefined;
  const r = checkInstall(req.body ?? {}, target, ctx.s.knownPackages);
  if (Object.keys(r.errors).length) return sendErrors(res, r.errors);
  const extras = (r.params['extra-packages'] ?? '').split(',').filter(Boolean);
  const space = cacheSpaceProblem(ctx.s.storage, cacheEstimate({ arch: target!.arch ?? null, serverArch: ctx.s.serverArch, sizes: ctx.s.sizes, extras }));
  if (space) return sendErrors(res, { storage: space });
  await withGuardedChange(id, req, res, { kind: 'netinstall.install', summary: `Netinstall ${target!['mac-address']}` },
    async (c) => {
      // Looked up again right before the write: Change Guard's own steps come in between.
      const now = (await c.getNetinstall()).devices.find((d) => normalizeMac(d['mac-address']) === want);
      if (!now) throw new Error('The device is no longer in the list, so nothing was installed. Refresh the page.');
      await c.startNetinstall({ ...r.params, numbers: now['.id'] });
      return { success: true };
    });
}));

// POST /netinstall/devices/clear?deviceId=
router.post('/devices/clear', requireWrite, (req, res) => withForm(req, res, async (_ctx, _device, id) => {
  await withGuardedChange(id, req, res, { kind: 'netinstall.clear', summary: 'Clear the Netinstall device list' },
    async (c) => { await c.clearNetinstallDevices(); return { success: true }; });
}));

export default router;
