/**
 * The local firmware mirror (#193).
 *
 * A designated RouterOS device, the package server, holds RouterOS packages in
 * a folder of its own; other devices pull them through
 * /system/package/local-update (RouterOS 7.17+), so a rollout no longer depends
 * on every device reaching MikroTik's servers. The manager keeps the server
 * stocked: it fetches each file once from download.mikrotik.com, checks it
 * against MikroTik's SHA-256, uploads it over SFTP and prunes old versions.
 *
 * Facts this rests on, checked on hardware (a CCR2216 serving a wAP ax):
 * - Clients log in to the server over Winbox. Listing needs read; downloading
 *   needs ftp, which the built-in read group lacks, so the login has its own group.
 * - Packages in a subfolder are found. RouterOS installs .npk files in the root
 *   on reboot, so a folder keeps the server from installing them itself.
 * - local-update/download starts in the background and can fail without a word,
 *   so a download is confirmed by the file on the device, never by the reply.
 */
import https from 'https';
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Client as SSHClient } from 'ssh2';
import { query, queryOne } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { resolveAuth } from './sshExec';
import { sshHostCheck, explainSshError } from './sshHostCheck';
import { logSafe } from '../utils/logSafe';
import {
  planFiles, versionsToPrune, parseNewest, parseSha256File, supportsLocalUpdate,
  isMirrorVersion, newestCompleteFrom, MIRROR_GROUP, MIRROR_GROUP_POLICY, mirrorPath, mirrorDisks,
  type FleetDevice, type NeededFile, type MirrorDisk,
} from '../utils/firmwareMirror';

const CACHE_ROOT = path.join(process.env.SECRETS_DIR || '/app/data', 'firmware-cache');
const MAX_PACKAGE_BYTES = 120 * 1024 * 1024;
const FETCH_ATTEMPTS = 3;
/** Room left on the package server after an upload, for its own config saves. */
const SERVER_HEADROOM_BYTES = 5 * 1024 * 1024;
const AUTO_SYNC_EVERY_MS = 6 * 60 * 60_000;

export interface MirrorRow {
  id: number;
  device_id: number;
  site_id: number | null;
  folder: string;
  /** Mount point of the disk the packages are on; null: internal storage. */
  disk: string | null;
  serve_address: string | null;
  username: string;
  password_encrypted: string | null;
  keep_versions: number;
  auto_sync: boolean;
  channel: string;
  status: string;
  last_error: string | null;
  last_sync_at: string | null;
  free_bytes: string | null;
  total_bytes: string | null;
}

export interface SyncResult {
  version: string;
  uploaded: string[];
  alreadyThere: string[];
  pruned: string[];
  skippedDevices: { id: number; name: string; reason: string }[];
}

const busy = new Set<number>();

// ─── Talking to MikroTik ─────────────────────────────────────────────────────

/**
 * HTTPS GET from MikroTik only. The host is fixed here, not taken from the
 * caller, and redirects aren't followed: download.mikrotik.com and
 * upgrade.mikrotik.com answer directly, so a redirect is treated as an error
 * rather than a way to send the manager somewhere else.
 */
const MIKROTIK_HOSTS = new Set(['download.mikrotik.com', 'upgrade.mikrotik.com']);

function get(host: string, pathname: string, onResponse: (res: import('http').IncomingMessage) => void, onError: (e: Error) => void): void {
  if (!MIKROTIK_HOSTS.has(host) || !/^\/routeros\/[A-Za-z0-9._/-]+$/.test(pathname) || pathname.includes('..')) {
    onError(new Error('Refusing to fetch: packages come from mikrotik.com only'));
    return;
  }
  const req = https.get({ host, path: pathname, protocol: 'https:', timeout: 30_000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      onError(new Error(`${host} answered ${res.statusCode} for ${path.posix.basename(pathname)}`));
      return;
    }
    onResponse(res);
  });
  req.on('timeout', () => req.destroy(new Error(`${host} stopped answering`)));
  req.on('error', onError);
}

function fetchText(host: string, pathname: string, maxBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    get(host, pathname, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > maxBytes) res.destroy(new Error('Reply too large'));
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }, reject);
  });
}

/** The newest RouterOS 7 release on a channel, as MikroTik announces it. */
export async function latestVersion(channel: string): Promise<string> {
  const ch = channel === 'long-term' ? 'long-term' : 'stable';
  const body = await fetchText('upgrade.mikrotik.com', `/routeros/NEWESTa7.${ch}`);
  const v = parseNewest(body);
  if (!v) throw new Error(`MikroTik didn't name a ${ch} version`);
  return v;
}

/**
 * A file's place in the cache. The version is rebuilt from its numbers and the
 * name checked against the package-file shape, and the result has to resolve
 * inside the cache: nothing from a request can point outside it.
 */
function cachePath(version: string, filename: string): string {
  const v = canonicalVersion(version);
  if (!/^[a-z0-9][a-z0-9-]*-7\.\d{1,3}(?:\.\d{1,3})?(?:-[a-z0-9_]+)?\.npk$/.test(filename)) {
    throw new Error(`Unexpected package file name ${JSON.stringify(filename)}`);
  }
  const root = path.resolve(CACHE_ROOT);
  const full = path.resolve(root, v, path.basename(filename));
  if (!full.startsWith(root + path.sep)) throw new Error('Package path outside the cache');
  return full;
}

function cacheDir(version: string): string {
  const root = path.resolve(CACHE_ROOT);
  const full = path.resolve(root, canonicalVersion(version));
  if (!full.startsWith(root + path.sep)) throw new Error('Package path outside the cache');
  return full;
}

/** "7.24.5" rebuilt from its numbers, so only digits and dots survive. */
function canonicalVersion(version: string): string {
  if (!isMirrorVersion(version)) throw new Error(`${JSON.stringify(version)} isn't a RouterOS 7 release`);
  return version.split('.').map((n) => String(Number(n))).join('.');
}

/**
 * The file in the manager's cache, verified. Fetched once, then reused for
 * every package server and every device that needs it.
 */
export async function ensureCached(version: string, filename: string): Promise<{ path: string; size: number; sha256: string }> {
  const file = cachePath(version, filename);
  const sidecar = `${file}.sha256`;
  if (fs.existsSync(file) && fs.existsSync(sidecar)) {
    const want = fs.readFileSync(sidecar, 'utf8').trim();
    const got = await hashFile(file);
    if (got === want) return { path: file, size: fs.statSync(file).size, sha256: got };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const remote = `/routeros/${canonicalVersion(version)}/${path.basename(file)}`;
      const expected = parseSha256File(await fetchText('download.mikrotik.com', `${remote}.sha256`));
      if (!expected) throw new Error(`MikroTik's checksum for ${filename} couldn't be read`);
      const tmp = `${file}.part`;
      const { sha256, size } = await download(remote, tmp);
      if (sha256 !== expected) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`${filename} didn't match MikroTik's checksum`);
      }
      fs.renameSync(tmp, file);
      fs.writeFileSync(sidecar, sha256);
      return { path: file, size, sha256 };
    } catch (e) {
      lastError = e as Error;
      console.warn(`[Mirror] fetching ${logSafe(filename)} (attempt ${attempt}/${FETCH_ATTEMPTS}): ${logSafe(lastError.message)}`);
    }
  }
  throw new Error(`Couldn't fetch ${filename} from MikroTik: ${lastError?.message ?? 'unknown error'}`);
}

function download(pathname: string, dest: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    get('download.mikrotik.com', pathname, (res) => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > MAX_PACKAGE_BYTES) { res.destroy(); reject(new Error('Package larger than expected')); return; }
      const hash = createHash('sha256');
      const out = fs.createWriteStream(dest);
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_PACKAGE_BYTES) res.destroy(new Error('Package larger than expected'));
        hash.update(c);
      });
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => {
        if (declared && size !== declared) reject(new Error(`Download stopped at ${size} of ${declared} bytes`));
        else resolve({ sha256: hash.digest('hex'), size });
      });
      res.pipe(out);
    }, reject);
  });
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ─── Talking to the package server ───────────────────────────────────────────

async function serverDevice(mirror: MirrorRow): Promise<DeviceRow> {
  const d = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [mirror.device_id]);
  if (!d) throw new Error('The package server device no longer exists');
  return d;
}

/** Upload one file into the mirror folder over SFTP. */
function sftpUpload(device: DeviceRow, localFile: string, remoteFile: string): Promise<void> {
  return resolveAuth(device).then(({ username, auth }) => new Promise<void>((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const port = device.ssh_port || 22;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* closing */ }
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Upload of ${path.basename(remoteFile)} timed out`)), 15 * 60_000);
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return finish(err);
        // The folder may not exist yet; an error here usually means it does.
        sftp.mkdir(path.posix.dirname(remoteFile), () => {
          sftp.fastPut(localFile, remoteFile, (e) => finish(e ?? undefined));
        });
      });
    });
    conn.on('error', (e) => finish(explainSshError(e, device.ip_address, port)));
    conn.connect({ host: device.ip_address, port, username, ...sshHostCheck(device.ip_address, port), ...auth, readyTimeout: 15_000 });
  }));
}

async function withCollector<T>(device: DeviceRow, fn: (c: DeviceCollector) => Promise<T>): Promise<T> {
  const c = new DeviceCollector(device);
  try {
    await c.connect();
    return await fn(c);
  } finally {
    c.disconnect();
  }
}

function serveAddress(mirror: MirrorRow, server: DeviceRow): string {
  return (mirror.serve_address || server.ip_address).trim();
}

// ─── Mirrors ─────────────────────────────────────────────────────────────────

export async function getMirror(id: number): Promise<MirrorRow | null> {
  return queryOne<MirrorRow>(`SELECT * FROM firmware_mirrors WHERE id = $1`, [id]);
}

/** Devices a mirror serves: its site's, or for the fleet mirror, those in sites without their own. */
export async function scopeDevices(mirror: MirrorRow): Promise<FleetDevice[]> {
  return mirror.site_id === null
    ? query<FleetDevice>(
        `SELECT d.id, d.name, d.architecture, d.installed_packages, d.ros_version FROM devices d
          WHERE NOT EXISTS (SELECT 1 FROM firmware_mirrors m WHERE m.site_id IS NOT NULL AND m.site_id = d.site_id)
          ORDER BY d.name`)
    : query<FleetDevice>(
        `SELECT id, name, architecture, installed_packages, ros_version FROM devices WHERE site_id = $1 ORDER BY name`,
        [mirror.site_id]);
}

async function setStatus(id: number, status: string, error: string | null): Promise<void> {
  await query(`UPDATE firmware_mirrors SET status = $2, last_error = $3 WHERE id = $1`, [id, status, error]);
}

/**
 * Prepare the package server: a login for the devices to use, in a group of
 * its own, with a password only the manager knows. Run again to rotate it.
 */
/**
 * Free and total space where the packages go: the chosen disk, or internal
 * storage. A disk that has gone (card pulled, stick unplugged) is an error
 * rather than a quiet fallback that would fill internal flash.
 */
async function storageSpace(c: DeviceCollector, mirror: MirrorRow, server: DeviceRow): Promise<{ free: number; total: number }> {
  const [disks, res] = await Promise.all([mirror.disk ? c.getDisks() : Promise.resolve([]), c.getSystemResource()]);
  const target = mirrorDisks(disks, res).find((d) => d.mount_point === (mirror.disk || null));
  if (!target) throw new Error(`${server.name.trim()} has no disk ${mirror.disk} any more (removed, or not mounted); choose another in the mirror's settings`);
  return { free: target.free_bytes, total: target.size_bytes };
}

/** Delete a mirror folder and everything in it. */
async function removeMirrorFiles(c: DeviceCollector, folderPath: string): Promise<void> {
  for (const f of await c.getFilesUnder(`${folderPath}/`)) if (f['.id']) await c.removeFileById(f['.id']);
  const folder = (await c.getFilesUnder(folderPath)).find((f) => f['name'] === folderPath);
  if (folder?.['.id']) await c.removeFileById(folder['.id']);
}

/** The disks a device could keep a mirror on, internal storage first. */
export async function serverDisks(device: DeviceRow): Promise<MirrorDisk[]> {
  return withCollector(device, async (c) => {
    const [disks, res] = await Promise.all([c.getDisks(), c.getSystemResource()]);
    return mirrorDisks(disks, res);
  });
}

/**
 * Move a mirror to another disk: the packages on the old one are deleted and
 * the records cleared, so the next sync (automatic, or Sync now) stocks the new
 * one. Devices keep the same address and login.
 */
export async function moveMirror(id: number, disk: string | null): Promise<void> {
  const mirror = await getMirror(id);
  if (!mirror) throw new Error('Mirror not found');
  if ((mirror.disk || null) === (disk || null)) return;
  const server = await serverDevice(mirror);
  await withCollector(server, async (c) => {
    if (disk) {
      const found = mirrorDisks(await c.getDisks(), await c.getSystemResource()).find((d) => d.mount_point === disk);
      if (!found) throw new Error(`${server.name.trim()} has no writable disk ${disk}`);
    }
    await removeMirrorFiles(c, mirrorPath(mirror.folder, mirror.disk)).catch(() => { /* old disk may be gone */ });
  });
  await query(`DELETE FROM firmware_mirror_files WHERE mirror_id = $1`, [id]);
  await query(`UPDATE firmware_mirrors SET disk = $2, status = 'deployed', last_error = NULL WHERE id = $1`, [id, disk || null]);
}

export async function deployMirror(id: number): Promise<{ user: 'created' | 'updated' }> {
  const mirror = await getMirror(id);
  if (!mirror) throw new Error('Mirror not found');
  const server = await serverDevice(mirror);
  if (!supportsLocalUpdate(server.ros_version)) {
    throw new Error(`${server.name.trim()} runs RouterOS ${server.ros_version || 'unknown'}; a package server needs 7.17 or later`);
  }
  const password = randomBytes(18).toString('base64url');
  const user = await withCollector(server, (c) =>
    c.ensureMirrorUser(mirror.username, MIRROR_GROUP, MIRROR_GROUP_POLICY, password, 'MikroTik Manager package mirror'));
  await query(`UPDATE firmware_mirrors SET password_encrypted = $2, status = 'deployed', last_error = NULL WHERE id = $1`,
    [id, encrypt(password)]);
  return { user };
}

/**
 * Stock the package server with a version: fetch what the devices in its
 * scope run, check space, upload what's missing, prune old versions.
 */
export async function syncMirror(id: number, requested?: string): Promise<SyncResult> {
  if (busy.has(id)) throw new Error('This mirror is already syncing');
  busy.add(id);
  try {
    const mirror = await getMirror(id);
    if (!mirror) throw new Error('Mirror not found');
    if (!mirror.password_encrypted) throw new Error('Set up the package server first');
    await setStatus(id, 'syncing', null);

    const version = requested ?? await latestVersion(mirror.channel);
    if (!isMirrorVersion(version)) throw new Error(`${version} isn't a RouterOS 7 release`);
    const plan = planFiles(await scopeDevices(mirror), version);
    if (plan.files.length === 0) {
      throw new Error(plan.skipped.length
        ? `No device can use the mirror yet: ${plan.skipped[0].name.trim()}: ${plan.skipped[0].reason}`
        : 'No devices for this mirror');
    }

    // Everything fetched and verified before the server is touched.
    const cached = new Map<string, { path: string; size: number; sha256: string; file: NeededFile }>();
    for (const f of plan.files) cached.set(f.filename, { ...(await ensureCached(version, f.filename)), file: f });

    const server = await serverDevice(mirror);
    const prefix = `${mirrorPath(mirror.folder, mirror.disk)}/`;
    const result: SyncResult = { version, uploaded: [], alreadyThere: [], pruned: [], skippedDevices: plan.skipped };

    const onServer = await withCollector(server, async (c) => {
      const files = await c.getFilesUnder(prefix);
      return { files, ...(await storageSpace(c, mirror, server)) };
    });
    const present = new Map(onServer.files.map((f) => [f['name'].slice(prefix.length), Number(f['size'] || 0)]));
    const missing = [...cached.values()].filter((c) => present.get(c.file.filename) !== c.size);
    const needBytes = missing.reduce((n, c) => n + c.size, 0);
    if (needBytes > 0 && onServer.free && needBytes + SERVER_HEADROOM_BYTES > onServer.free) {
      throw new Error(
        `${server.name.trim()} has ${mb(onServer.free)} free; ${version} needs ${mb(needBytes)} more ` +
        `(${missing.length} file${missing.length === 1 ? '' : 's'}). Lower "versions kept" or use a package server with more storage.`);
    }

    for (const c of missing) {
      try {
        await sftpUpload(server, c.path, prefix + c.file.filename);
      } catch (e) {
        throw new Error(`Uploading ${c.file.filename} to ${server.name.trim()} failed: ${(e as Error).message}`, { cause: e });
      }
      result.uploaded.push(c.file.filename);
    }
    for (const c of cached.values()) if (!missing.includes(c)) result.alreadyThere.push(c.file.filename);

    // Confirm by size what is actually on the server now, and record it.
    const after = await withCollector(server, async (c) => {
      const files = await c.getFilesUnder(prefix);
      return { files, ...(await storageSpace(c, mirror, server)) };
    });
    const sizes = new Map(after.files.map((f) => [f['name'].slice(prefix.length), Number(f['size'] || 0)]));
    for (const c of cached.values()) {
      if (sizes.get(c.file.filename) !== c.size) {
        throw new Error(`${c.file.filename} isn't on ${server.name.trim()} at the right size after uploading`);
      }
      await query(
        `INSERT INTO firmware_mirror_files (mirror_id, version, package, architecture, filename, size_bytes, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (mirror_id, filename) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, uploaded_at = NOW()`,
        [id, version, c.file.package, c.file.architecture, c.file.filename, c.size, c.sha256]);
    }

    result.pruned = await prune(mirror, server);
    const final = await withCollector(server, (c) => storageSpace(c, mirror, server)).catch(() => null);
    await query(
      `UPDATE firmware_mirrors SET status = 'ready', last_error = NULL, last_sync_at = NOW(), free_bytes = $2, total_bytes = $3 WHERE id = $1`,
      [id, final ? final.free : after.free, final ? final.total : after.total]);
    console.log(`[Mirror] #${id} synced ${logSafe(version)}: ${result.uploaded.length} uploaded, ${result.alreadyThere.length} already there, ${result.pruned.length} pruned`);
    return result;
  } catch (e) {
    await setStatus(id, 'error', (e as Error).message).catch(() => {});
    throw e;
  } finally {
    busy.delete(id);
  }
}

/** Remove versions beyond the number kept, from the server, the records and the cache. */
async function prune(mirror: MirrorRow, server: DeviceRow): Promise<string[]> {
  const versions = (await query<{ version: string }>(
    `SELECT DISTINCT version FROM firmware_mirror_files WHERE mirror_id = $1`, [mirror.id])).map((r) => r.version);
  const drop = versionsToPrune(versions, mirror.keep_versions);
  if (drop.length === 0) return [];
  const prefix = `${mirrorPath(mirror.folder, mirror.disk)}/`;
  await withCollector(server, async (c) => {
    const files = await c.getFilesUnder(prefix);
    for (const f of files) {
      const name = f['name'].slice(prefix.length);
      if (drop.some((v) => name.includes(`-${v}-`) || name.endsWith(`-${v}.npk`)) && f['.id']) await c.removeFileById(f['.id']);
    }
  });
  await query(`DELETE FROM firmware_mirror_files WHERE mirror_id = $1 AND version = ANY($2::text[])`, [mirror.id, drop]);
  // A version no mirror holds any more leaves the cache too.
  for (const v of drop) {
    const still = await queryOne(`SELECT 1 FROM firmware_mirror_files WHERE version = $1 LIMIT 1`, [v]);
    if (!still && isMirrorVersion(v)) fs.rmSync(cacheDir(v), { recursive: true, force: true });
  }
  return drop;
}

function mb(bytes: number): string {
  return `${Math.round((bytes / 1048576) * 10) / 10} MB`;
}

// ─── Devices using a mirror ──────────────────────────────────────────────────

export interface ClientChange { device_id: number; name: string; ok: boolean; message: string }

/** Point devices at a mirror (or stop), on the devices themselves. */
export async function setClients(id: number, deviceIds: number[], enable: boolean): Promise<ClientChange[]> {
  const mirror = await getMirror(id);
  if (!mirror) throw new Error('Mirror not found');
  if (enable && !mirror.password_encrypted) throw new Error('Set up the package server first');
  const server = await serverDevice(mirror);
  const address = serveAddress(mirror, server);
  // Addresses of every package server we manage: a device moved between
  // mirrors drops the old one.
  const ours = new Set((await query<{ address: string }>(
    `SELECT COALESCE(NULLIF(m.serve_address, ''), d.ip_address) AS address
       FROM firmware_mirrors m JOIN devices d ON d.id = m.device_id`)).map((r) => r.address.trim()));
  ours.add(address);

  const out: ClientChange[] = [];
  for (const deviceId of deviceIds) {
    const d = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    if (!d) { out.push({ device_id: deviceId, name: `#${deviceId}`, ok: false, message: 'Device not found' }); continue; }
    const name = d.name.trim();
    if (enable && d.id === server.id) {
      out.push({ device_id: d.id, name, ok: false, message: 'This is the package server itself' });
      continue;
    }
    if (enable && !supportsLocalUpdate(d.ros_version)) {
      out.push({ device_id: d.id, name, ok: false, message: `RouterOS ${d.ros_version || 'unknown'} is older than 7.17` });
      continue;
    }
    try {
      await withCollector(d, async (c) => {
        for (const s of await c.getLocalUpdateSources()) {
          if (s['.id'] && ours.has((s['address'] || '').trim())) await c.removeLocalUpdateSource(s['.id']);
        }
        if (enable) await c.addLocalUpdateSource(address, mirror.username, decrypt(mirror.password_encrypted!));
      });
      if (enable) {
        await query(
          `INSERT INTO firmware_mirror_clients (device_id, mirror_id, status, error, updated_at) VALUES ($1,$2,'ok',NULL,NOW())
           ON CONFLICT (device_id) DO UPDATE SET mirror_id = EXCLUDED.mirror_id, status = 'ok', error = NULL, updated_at = NOW()`,
          [d.id, id]);
      } else {
        await query(`DELETE FROM firmware_mirror_clients WHERE device_id = $1`, [d.id]);
      }
      out.push({ device_id: d.id, name, ok: true, message: enable ? `Uses ${address}` : 'Back to MikroTik’s servers only' });
    } catch (e) {
      const message = (e as Error).message;
      if (enable) {
        await query(
          `INSERT INTO firmware_mirror_clients (device_id, mirror_id, status, error, updated_at) VALUES ($1,$2,'error',$3,NOW())
           ON CONFLICT (device_id) DO UPDATE SET mirror_id = EXCLUDED.mirror_id, status = 'error', error = EXCLUDED.error, updated_at = NOW()`,
          [d.id, id, message.slice(0, 500)]);
      }
      out.push({ device_id: d.id, name, ok: false, message });
    }
  }
  return out;
}

/** Take a mirror away: devices stop using it, the server loses the files and the login. */
export async function removeMirror(id: number): Promise<{ notes: string[] }> {
  const mirror = await getMirror(id);
  if (!mirror) throw new Error('Mirror not found');
  const notes: string[] = [];
  const clients = (await query<{ device_id: number }>(
    `SELECT device_id FROM firmware_mirror_clients WHERE mirror_id = $1`, [id])).map((r) => r.device_id);
  for (const r of await setClients(id, clients, false)) if (!r.ok) notes.push(`${r.name}: ${r.message}`);
  try {
    const server = await serverDevice(mirror);
    await withCollector(server, async (c) => {
      await removeMirrorFiles(c, mirrorPath(mirror.folder, mirror.disk));
      await c.removeUserByName(mirror.username);
      await c.removeUserGroup(MIRROR_GROUP);
    });
  } catch (e) {
    notes.push(`Package server: ${(e as Error).message}`);
  }
  const versions = (await query<{ version: string }>(
    `SELECT DISTINCT version FROM firmware_mirror_files WHERE mirror_id = $1`, [id])).map((r) => r.version);
  await query(`DELETE FROM firmware_mirrors WHERE id = $1`, [id]);
  // The manager's own copies go too, unless another mirror still holds them.
  for (const v of versions) {
    const still = await queryOne(`SELECT 1 FROM firmware_mirror_files WHERE version = $1 LIMIT 1`, [v]);
    if (!still && isMirrorVersion(v)) fs.rmSync(cacheDir(v), { recursive: true, force: true });
  }
  return { notes };
}

// ─── Rollouts ────────────────────────────────────────────────────────────────

/** The mirror a device pulls from, if it's set up and working. */
export async function mirrorForDevice(deviceId: number): Promise<MirrorRow | null> {
  return queryOne<MirrorRow>(
    `SELECT m.* FROM firmware_mirror_clients c JOIN firmware_mirrors m ON m.id = c.mirror_id
      WHERE c.device_id = $1 AND c.status = 'ok' AND m.status IN ('ready','syncing')`, [deviceId]);
}

/**
 * The newest version a mirror holds every file of for this device. The
 * device's installed packages all have to be there, or it isn't offered.
 */
export async function newestCompleteVersion(mirrorId: number, arch: string | null, packages: string[] | null): Promise<string | null> {
  if (!arch || !packages?.length) return null;
  const rows = await query<{ version: string; filename: string }>(
    `SELECT version, filename FROM firmware_mirror_files WHERE mirror_id = $1`, [mirrorId]);
  return newestCompleteFrom(rows, arch, packages);
}

// ─── Automatic sync ──────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/** Check each auto-sync mirror for a newer release every few hours. */
export function startMirrorScheduler(): void {
  if (timer) return;
  const tick = () => { void autoSync().catch((e) => console.error('[Mirror] auto-sync:', logSafe((e as Error).message))); };
  setTimeout(tick, 5 * 60_000);
  timer = setInterval(tick, AUTO_SYNC_EVERY_MS);
}

async function autoSync(): Promise<void> {
  const mirrors = await query<MirrorRow>(
    `SELECT * FROM firmware_mirrors WHERE auto_sync AND password_encrypted IS NOT NULL`);
  for (const m of mirrors) {
    try {
      const latest = await latestVersion(m.channel);
      const have = await queryOne(`SELECT 1 FROM firmware_mirror_files WHERE mirror_id = $1 AND version = $2 LIMIT 1`, [m.id, latest]);
      if (!have) await syncMirror(m.id, latest);
    } catch (e) {
      console.warn(`[Mirror] #${m.id} auto-sync: ${logSafe((e as Error).message)}`);
    }
  }
}
