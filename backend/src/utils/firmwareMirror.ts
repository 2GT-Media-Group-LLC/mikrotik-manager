/**
 * The arithmetic of the local firmware mirror (#193), kept pure so it can be
 * tested without a router, a download or a database.
 *
 * The manager keeps a designated RouterOS device (the package server) stocked
 * with the packages the fleet runs; other devices pull them through
 * /system/package/local-update, which RouterOS has from 7.17.
 */
import { compareRosVersions, parseRosVersion } from './rosVersion';

/** local-update, the client side of the mirror, first shipped in 7.17. */
export const LOCAL_UPDATE_MIN_VERSION = '7.17';

export const DEFAULT_MIRROR_FOLDER = 'mtm-packages';

/**
 * The package server login's group, and its permissions. Shown on hardware:
 * listing needs more than read and winbox (a group with only read, ftp and
 * winbox listed nothing), and downloading needs ftp. This is RouterOS's
 * built-in read group plus ftp, the set proven to list and download. Narrowing
 * it is a follow-up; until then a dedicated package server is the advice,
 * since ftp lets the login read every file on the router.
 */
export const MIRROR_GROUP = 'mtm-mirror';
export const MIRROR_GROUP_POLICY = 'local,telnet,ssh,reboot,read,test,winbox,password,web,sniff,sensitive,api,romon,rest-api,ftp';
export const MIN_KEEP_VERSIONS = 1;
export const MAX_KEEP_VERSIONS = 5;
export const DEFAULT_KEEP_VERSIONS = 3;

const PACKAGE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const ARCH_RE = /^[a-z0-9_]{2,16}$/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** A RouterOS 7 release: 7.x or 7.x.y, no pre-releases. */
export function isMirrorVersion(v: string): boolean {
  const parts = String(v ?? '').split('.');
  return parts[0] === '7' && (parts.length === 2 || parts.length === 3)
    && parts.slice(1).every((p) => /^\d{1,3}$/.test(p));
}

export function isMirrorFolder(f: string): boolean {
  return FOLDER_RE.test(f);
}

/** Whether a device's RouterOS can pull from a package server. */
export function supportsLocalUpdate(rosVersion: string | null | undefined): boolean {
  const parsed = parseRosVersion(rosVersion);
  if (!parsed || parsed.parts[0] !== 7) return false;
  return compareRosVersions(rosVersion, LOCAL_UPDATE_MIN_VERSION) >= 0;
}

/**
 * RouterOS 7 package file name: `<package>-<version>-<arch>.npk`, except x86,
 * whose files carry no architecture (`routeros-7.24.5.npk`). Devices report
 * x86 as `x86_64`. Returns null for anything that doesn't look like a real
 * package, architecture or version, so a name is never built from junk.
 */
export function packageFileName(pkg: string, version: string, arch: string): string | null {
  const a = arch.toLowerCase();
  if (!PACKAGE_RE.test(pkg) || !ARCH_RE.test(a) || !isMirrorVersion(version)) return null;
  if (a === 'x86' || a === 'x86_64') return `${pkg}-${version}.npk`;
  return `${pkg}-${version}-${a}.npk`;
}

export function downloadUrl(version: string, filename: string): string {
  return `https://download.mikrotik.com/routeros/${version}/${filename}`;
}

/** MikroTik's "newest" answer: "7.24.5 1790691687" → "7.24.5". */
export function parseNewest(body: string): string | null {
  const v = (body || '').trim().split(/\s+/)[0] || '';
  return isMirrorVersion(v) ? v : null;
}

/** The first field of a `.sha256` file, if it is a SHA-256. */
export function parseSha256File(body: string): string | null {
  const h = (body || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

export interface FleetDevice {
  id: number;
  name: string;
  architecture: string | null;
  installed_packages: string[] | null;
  ros_version: string | null;
}

export interface NeededFile {
  package: string;
  architecture: string;
  filename: string;
}

export interface FleetPlan {
  files: NeededFile[];
  /** Devices the mirror can't serve yet, with the reason. */
  skipped: { id: number; name: string; reason: string }[];
}

/**
 * The files a version needs for these devices: every installed package for
 * every architecture in use, once each. Uploading routeros alone would leave
 * a device's other packages at the old version, and RouterOS disables a
 * mismatched wifi-qcom on reboot, so an access point would come back with no
 * wireless.
 */
export function planFiles(devices: FleetDevice[], version: string): FleetPlan {
  const files = new Map<string, NeededFile>();
  const skipped: FleetPlan['skipped'] = [];
  for (const d of devices) {
    if (!supportsLocalUpdate(d.ros_version)) {
      skipped.push({ id: d.id, name: d.name, reason: `RouterOS ${d.ros_version || 'unknown'} is older than ${LOCAL_UPDATE_MIN_VERSION}` });
      continue;
    }
    if (!d.architecture || !d.installed_packages?.length) {
      skipped.push({ id: d.id, name: d.name, reason: 'Its architecture and packages haven’t been read yet' });
      continue;
    }
    const arch = d.architecture.toLowerCase();
    for (const pkg of d.installed_packages) {
      const filename = packageFileName(pkg, version, arch);
      if (!filename) continue;
      files.set(filename, { package: pkg, architecture: arch, filename });
    }
  }
  return {
    files: [...files.values()].sort((a, b) => a.filename.localeCompare(b.filename)),
    skipped,
  };
}

/** Versions to drop so only the newest `keep` remain. */
export function versionsToPrune(versions: string[], keep: number): string[] {
  const k = clampKeepVersions(keep);
  const sorted = [...new Set(versions)].sort((a, b) => compareRosVersions(b, a));
  return sorted.slice(k);
}

export function clampKeepVersions(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_KEEP_VERSIONS;
  return Math.min(MAX_KEEP_VERSIONS, Math.max(MIN_KEEP_VERSIONS, v));
}

export interface LocalUpdateRow {
  '.id'?: string;
  name?: string;
  version?: string;
  status?: string;
}

/**
 * What a device would pull for a target version: one local-update entry per
 * installed package. A package with no entry at that version means the
 * mirror can't upgrade this device safely, so nothing is downloaded.
 */
export function matchLocalUpdate(
  rows: LocalUpdateRow[],
  installed: string[],
  version: string,
): { ok: true; ids: { name: string; id: string }[] } | { ok: false; missing: string[] } {
  const ids: { name: string; id: string }[] = [];
  const missing: string[] = [];
  for (const pkg of installed) {
    const row = rows.find((r) => r.name === pkg && r.version === version && r['.id']);
    if (row) ids.push({ name: pkg, id: row['.id']! });
    else missing.push(pkg);
  }
  return missing.length ? { ok: false, missing } : { ok: true, ids };
}

/**
 * The newest version among a mirror's files that has every installed package
 * of a device, for its architecture. Null when none is complete.
 */
export function newestCompleteFrom(
  files: { version: string; filename: string }[],
  arch: string | null,
  packages: string[] | null,
): string | null {
  if (!arch || !packages?.length) return null;
  const byVersion = new Map<string, Set<string>>();
  for (const f of files) {
    if (!byVersion.has(f.version)) byVersion.set(f.version, new Set());
    byVersion.get(f.version)!.add(f.filename);
  }
  const a = arch.toLowerCase();
  const complete = [...byVersion.entries()]
    .filter(([v, names]) => packages.every((p) => { const n = packageFileName(p, v, a); return !!n && names.has(n); }))
    .map(([v]) => v)
    .sort((x, y) => compareRosVersions(y, x));
  return complete[0] ?? null;
}


// ─── Where the packages go (Discussion #85) ─────────────────────────────────
//
// Many devices have 16 MB of flash, too little for more than one version, and
// some carry a microSD card or USB stick. A mirror can keep its packages on any
// mounted, writable disk instead of internal storage. RouterOS shows a disk in
// the file tree under its mount point (sd1/, usb1/), so the folder becomes
// `<mount-point>/<folder>`.

const DISK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function isDiskName(d: string): boolean {
  return DISK_RE.test(d);
}

/** Where the packages live on the server: `mtm-packages` or `sd1/mtm-packages`. */
export function mirrorPath(folder: string, disk: string | null | undefined): string {
  return disk ? `${disk}/${folder}` : folder;
}

export interface MirrorDisk {
  /** Mount point (the top-level name in the file tree); null for internal storage. */
  mount_point: string | null;
  label: string;
  free_bytes: number;
  size_bytes: number;
  /** A RAM disk (tmpfs): emptied on every reboot. */
  ram: boolean;
}

const bytes = (v: string | undefined): number => {
  const n = Number(String(v ?? '').replace(/\s/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Disks a mirror can use, from `/disk/print detail`: mounted, writable, with a
 * mount point that is a plain name. Internal storage comes first, from
 * `/system/resource` (free-hdd-space).
 */
export function mirrorDisks(disks: Record<string, string>[], resource: Record<string, string> | undefined): MirrorDisk[] {
  const out: MirrorDisk[] = [{
    mount_point: null,
    label: 'Internal storage',
    free_bytes: bytes(resource?.['free-hdd-space']),
    size_bytes: bytes(resource?.['total-hdd-space']),
    ram: false,
  }];
  for (const d of disks) {
    const mp = (d['mount-point'] || '').trim();
    const mounted = d['mount-filesystem'] !== 'false' && d['mount-filesystem'] !== 'no'
      && d['mounted'] !== 'false' && d['disabled'] !== 'true';
    const readOnly = d['mount-read-only'] === 'true' || d['mount-read-only'] === 'yes';
    if (!mp || !mounted || readOnly || !isDiskName(mp)) continue;
    const ram = d['type'] === 'tmpfs' || d['fs'] === 'tmpfs';
    const kind = ram ? 'RAM disk' : [d['model'], d['interface']].filter((x) => x && x !== 'tmpfs').join(', ') || d['type'] || 'disk';
    out.push({ mount_point: mp, label: `${mp} (${kind})`, free_bytes: bytes(d['free']), size_bytes: bytes(d['size']), ram });
  }
  return out;
}

/** The suggested disk: the most free space, never a RAM disk. */
export function suggestDisk(disks: MirrorDisk[]): string | null {
  const best = disks.filter((d) => !d.ram).sort((a, b) => b.free_bytes - a.free_bytes)[0];
  return best?.mount_point ?? null;
}
