/**
 * Netinstall from a RouterOS device (#310). RouterOS 7.24 and later can run
 * Netinstall itself as an extra package: a device on the same layer 2 segment
 * that etherboots is reinstalled from it. The package's menus are
 * /tool/netinstall (server entries), /cache, /devices and /settings.
 *
 * An install reformats the target, so the rules here are deliberately strict.
 * An enabled entry that answers etherboot must name the one MAC address it
 * installs, or wait for someone to start each install. Without either, it
 * would reinstall whatever device on that segment etherboots, including one in
 * production. Everything a form sends is checked here, because RouterOS
 * accepts any text as a version or a package name and only fails later, on
 * the install.
 *
 * Pure, so every rule is tested without a device.
 */
import { compareRosVersions, parseRosVersion } from './rosVersion';

/** The first release with the netinstall package. */
export const NETINSTALL_MIN_VERSION = '7.24beta1';

/** CPU architectures RouterOS is built for; SMIPS devices can't run the package. */
export const ARCHES = ['arm', 'arm64', 'mipsbe', 'mmips', 'smips', 'ppc', 'tile', 'x86'] as const;
export type Arch = typeof ARCHES[number];

/**
 * Extra packages RouterOS 7 ships, for the install forms. A name the server
 * device itself lists is accepted too, so a package added in a later release
 * doesn't wait for this list.
 */
export const KNOWN_EXTRA_PACKAGES = [
  'calea', 'container', 'dude', 'gps', 'iot', 'iot-bt-extra', 'lora', 'netinstall', 'openflow',
  'rose-storage', 'switch-marvell', 'tr069-client', 'ups', 'user-manager', 'wifi-halow-mm',
  'wifi-mediatek', 'wifi-qcom', 'wifi-qcom-ac', 'wireless', 'zerotier',
];

export type NetinstallSupport =
  /** The package is installed. */
  | 'installed'
  /** It can be installed from the device's package list. */
  | 'available'
  /** RouterOS older than 7.24. */
  | 'too-old'
  /** A SMIPS device, which has no netinstall package. */
  | 'unsupported'
  /** Not polled yet, or the version can't be read. */
  | 'unknown';

export interface SupportInput {
  ros_version: string | null;
  architecture: string | null;
  installed_packages: string[] | null;
  /** Installed but switched off: a removed extra package stays on flash, disabled. */
  disabled_packages?: string[] | null;
}

export function netinstallSupport(d: SupportInput): NetinstallSupport {
  if (d.installed_packages?.includes('netinstall') && !d.disabled_packages?.includes('netinstall')) return 'installed';
  if ((d.architecture ?? '').toLowerCase() === 'smips') return 'unsupported';
  if (!parseRosVersion(d.ros_version)) return 'unknown';
  if (compareRosVersions(d.ros_version, NETINSTALL_MIN_VERSION) < 0) return 'too-old';
  return d.architecture ? 'available' : 'unknown';
}

// ─── Values ──────────────────────────────────────────────────────────────────

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

/** A MAC as RouterOS prints it (upper case, colons), or null when it isn't one. */
export function normalizeMac(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/-/g, ':');
  return MAC.test(s) ? s.toUpperCase() : null;
}

/** Multicast and broadcast addresses never etherboot. */
function isUnicastMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 1) === 0 && mac !== '00:00:00:00:00:00';
}

function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** A BOOTP range must be in one /24, so it's one subnet as RouterOS hands it out. */
const MAX_RANGE = 256;

export function ipRangeError(raw: string): string | null {
  const parts = raw.split('-').map((p) => p.trim());
  if (parts.length !== 2) return 'Enter a range like 192.168.88.10-192.168.88.20.';
  const [a, b] = parts.map(ipv4);
  if (a === null || b === null) return 'Both ends of the range must be IPv4 addresses.';
  if (a > b) return 'The range must start at the lower address.';
  if (b - a + 1 > MAX_RANGE) return `Keep the range to ${MAX_RANGE} addresses or fewer.`;
  return null;
}

/** A RouterOS release: 7.25, 7.24.3, 7.26beta2, 7.25rc1. */
export function isRosRelease(v: string): boolean {
  return /^\d+\.\d+(\.\d+)?((beta|rc)\d+)?$/.test(v);
}

const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_EXTRA = 20;

/**
 * A comma-separated package list, checked. `routeros` is installed anyway, so
 * it's dropped rather than refused. Returns the list as RouterOS takes it.
 */
export function packageListCheck(raw: unknown, known: string[]): { value: string; error: string | null } {
  const names = [...new Set(String(raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
    .filter((n) => n !== 'routeros');
  const allowed = new Set([...KNOWN_EXTRA_PACKAGES, ...known.map((k) => k.toLowerCase())]);
  const bad = names.filter((n) => !PACKAGE_NAME.test(n) || !allowed.has(n));
  if (bad.length) return { value: '', error: `Not a RouterOS package: ${bad.join(', ')}.` };
  if (names.length > MAX_EXTRA) return { value: '', error: `At most ${MAX_EXTRA} extra packages.` };
  return { value: names.join(','), error: null };
}

const COMMENT_MAX = 255;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const bool = (v: unknown): boolean | undefined =>
  v === undefined || v === null || v === '' ? undefined
    : v === true || v === 'true' || v === 'yes' ? true
      : v === false || v === 'false' || v === 'no' ? false : undefined;
const yesNo = (b: boolean) => (b ? 'yes' : 'no');

export const AUTO_REBOOT = ['reboot', 'shutdown', 'none'] as const;

// ─── Server entries ──────────────────────────────────────────────────────────

/** An entry as RouterOS prints it. */
export type RosRow = Record<string, string>;

export interface EntryCheck {
  /** Parameters for /tool/netinstall/add or set, only when there are no errors. */
  params: Record<string, string>;
  /** Field name to message, for the form to show inline. */
  errors: Record<string, string>;
}

const ENTRY_BOOLS = [
  'keep-old-configuration', 'apply-default-configuration', 'install-once', 'remove-branding',
  'wait', 'allow-etherboot', 'allow-flashfig', 'disabled',
] as const;

/**
 * Check a server entry from the form. `existing` is the entry being edited, as
 * RouterOS prints it; its values fill in what the form leaves out, so the
 * safety rule sees the entry as it would be after the change.
 */
export function checkEntry(
  body: Record<string, unknown>,
  ctx: { interfaces: string[]; knownPackages: string[]; existing?: RosRow },
): EntryCheck {
  const errors: Record<string, string> = {};
  const params: Record<string, string> = {};
  const ex = ctx.existing;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  // Interface
  if (has('interface') || !ex) {
    const iface = String(body.interface ?? '').trim();
    if (!iface) errors.interface = 'Choose the interface the device to install is reached on.';
    else if (!ctx.interfaces.includes(iface)) errors.interface = `${iface} isn't an interface on this device.`;
    else params.interface = iface;
  }

  // MAC address. RouterOS can't clear one once set.
  let mac: string | null = ex?.['mac-address'] ? normalizeMac(ex['mac-address']) : null;
  if (has('mac-address')) {
    const raw = String(body['mac-address'] ?? '').trim();
    if (!raw) {
      if (ex?.['mac-address']) errors['mac-address'] = 'RouterOS can\'t clear the MAC address of an entry. Delete the entry and add it again.';
      mac = null;
    } else {
      const m = normalizeMac(raw);
      if (!m) errors['mac-address'] = 'Enter a MAC address like 01:23:45:67:89:AB.';
      else if (!isUnicastMac(m)) errors['mac-address'] = 'That\'s a multicast or broadcast address; use the device\'s own MAC.';
      else { params['mac-address'] = m; mac = m; }
    }
  }

  if (has('ip-range') && String(body['ip-range'] ?? '').trim() !== '') {
    const r = String(body['ip-range']).replace(/\s+/g, '');
    const e = ipRangeError(r);
    if (e) errors['ip-range'] = e; else params['ip-range'] = r;
  } else if (has('ip-range') && ex?.['ip-range']) {
    errors['ip-range'] = 'RouterOS can\'t clear the range of an entry. Delete the entry and add it again, or enter a range.';
  }

  if (has('version')) {
    const v = String(body.version ?? '').trim();
    if (v && !isRosRelease(v)) errors.version = 'Enter a RouterOS version like 7.25 or 7.24.3, or leave it empty for the latest.';
    else if (v && compareRosVersions(v, '7.0') < 0) errors.version = 'Netinstall from RouterOS installs RouterOS 7.';
    else if (v || ex?.version) params.version = v;
  }

  if (has('extra-packages')) {
    const p = packageListCheck(body['extra-packages'], ctx.knownPackages);
    if (p.error) errors['extra-packages'] = p.error; else params['extra-packages'] = p.value;
  }

  if (has('auto-reboot')) {
    const v = String(body['auto-reboot'] ?? '');
    if (!(AUTO_REBOOT as readonly string[]).includes(v)) errors['auto-reboot'] = 'Choose reboot, shutdown or none.';
    else params['auto-reboot'] = v;
  }

  const flags: Record<string, boolean> = {};
  for (const k of ENTRY_BOOLS) {
    const b = has(k) ? bool(body[k]) : undefined;
    if (has(k) && b === undefined) { errors[k] = 'Must be yes or no.'; continue; }
    if (b !== undefined) params[k] = yesNo(b);
    // RouterOS defaults, for an entry being added.
    const fallback = k === 'keep-old-configuration' || k === 'allow-etherboot' ? true
      : k === 'allow-flashfig' ? true : false;
    flags[k] = b ?? (ex?.[k] !== undefined ? ex[k] === 'true' : fallback);
  }
  // A new entry doesn't answer FlashFig unless asked to.
  if (!ex && !has('allow-flashfig')) { params['allow-flashfig'] = 'no'; flags['allow-flashfig'] = false; }

  if (flags['keep-old-configuration'] && flags['apply-default-configuration']) {
    errors['apply-default-configuration'] = 'Choose one: keep the old configuration, or apply the default one.';
  }

  if (has('comment')) {
    const c = String(body.comment ?? '');
    if (c.length > COMMENT_MAX) errors.comment = `Keep the comment under ${COMMENT_MAX} characters.`;
    else if (CONTROL.test(c)) errors.comment = 'The comment can\'t contain line breaks or control characters.';
    else params.comment = c;
  }

  // The rule that matters: never an entry that installs any device that etherboots.
  const answers = !flags.disabled && (flags['allow-etherboot'] || flags['allow-flashfig']);
  if (answers && !mac && !flags.wait && !errors['mac-address']) {
    errors['mac-address'] = 'Enter the MAC address of the device to install, or turn on Wait so each install is started by hand. '
      + 'Without either, any device on this segment that etherboots would be reformatted.';
  }

  return { params: Object.keys(errors).length ? {} : params, errors };
}

/** The same rule for an entry already on a device: true when it would install anything that asks. */
export function isOpenEntry(e: RosRow): boolean {
  if (e.disabled === 'true') return false;
  const answers = e['allow-etherboot'] !== 'false' || e['allow-flashfig'] === 'true';
  return answers && !e['mac-address'] && e.wait !== 'true';
}

// ─── Starting an install ─────────────────────────────────────────────────────

export function checkInstall(body: Record<string, unknown>, target: RosRow | undefined, knownPackages: string[]): EntryCheck {
  const errors: Record<string, string> = {};
  const params: Record<string, string> = {};
  if (!target) return { params, errors: { device: 'That device is no longer waiting. Refresh the list.' } };
  const mac = normalizeMac(target['mac-address']);
  if (!mac || normalizeMac(body.confirm_mac) !== mac) {
    errors.confirm_mac = `Type the device's MAC address (${target['mac-address'] ?? 'unknown'}) to confirm. Its storage will be erased.`;
  }
  params.numbers = target['.id'];
  const v = String(body.version ?? '').trim();
  if (v && !isRosRelease(v)) errors.version = 'Enter a RouterOS version like 7.25, or leave it empty.';
  else if (v) params.version = v;
  if (body['extra-packages'] !== undefined && String(body['extra-packages']).trim() !== '') {
    const p = packageListCheck(body['extra-packages'], knownPackages);
    if (p.error) errors['extra-packages'] = p.error; else params['extra-packages'] = p.value;
  }
  if (body['auto-reboot'] !== undefined && body['auto-reboot'] !== '') {
    const a = String(body['auto-reboot']);
    if (!(AUTO_REBOOT as readonly string[]).includes(a)) errors['auto-reboot'] = 'Choose reboot, shutdown or none.';
    else params['auto-reboot'] = a;
  }
  return { params: Object.keys(errors).length ? {} : params, errors };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const MiB = 1024 * 1024;

export interface CacheStorage {
  /** Where NetinstallCache lives: RAM, the device's flash, or a disk. */
  kind: 'ram' | 'flash' | 'disk';
  /** The disk's name or mount point, for a disk. */
  disk: string | null;
  free: number | null;
  total: number | null;
}

/**
 * Where the cache directory is, from /tool/netinstall/settings, /file and
 * /disk. RouterOS keeps the root in RAM on devices with a `flash` directory,
 * and on flash on the rest; a path under a disk's mount point is on that disk.
 */
export function cacheStorage(
  cacheDirectory: string,
  files: RosRow[],
  disks: RosRow[],
  resource: RosRow,
): CacheStorage {
  const first = cacheDirectory.replace(/^\/+/, '').split('/')[0] ?? '';
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const disk = disks.find((d) => first && (d['mount-point'] === first || d.slot === first || d.name === first));
  if (disk) {
    const ram = disk.type === 'tmpfs';
    return { kind: ram ? 'ram' : 'disk', disk: first, free: num(disk.free), total: num(disk.size) };
  }
  // The flash directory itself is the device's persistent storage.
  if (first === 'flash') return { kind: 'flash', disk: null, free: num(resource['free-hdd-space']), total: num(resource['total-hdd-space']) };
  const flashDir = files.some((f) => f.name === 'flash' && (f.type === 'disk' || f.type === 'directory'));
  if (flashDir) return { kind: 'ram', disk: null, free: num(resource['free-memory']), total: num(resource['total-memory']) };
  return { kind: 'flash', disk: null, free: num(resource['free-hdd-space']), total: num(resource['total-hdd-space']) };
}

/** A conservative size for what an install downloads into the cache. */
export function cacheEstimate(opts: {
  arch: string | null;
  serverArch: string | null;
  /** The server's own package sizes, from /system/package/print. */
  sizes: Record<string, number>;
  extras: string[];
}): number {
  const same = !!opts.arch && opts.arch === opts.serverArch;
  const kernel = 4 * MiB;
  const system = same && opts.sizes.routeros ? opts.sizes.routeros : 16 * MiB;
  const extras = opts.extras.reduce((sum, p) => sum + (same && opts.sizes[p] ? opts.sizes[p] : 12 * MiB), 0);
  return kernel + system + extras;
}

/**
 * Why the cache can't take `need` bytes, or null. Flash keeps a margin like
 * API backups do; RAM keeps more, because the device runs in it.
 */
export function cacheSpaceProblem(s: CacheStorage, need: number): string | null {
  const mb = (n: number) => `${(n / MiB).toFixed(1)} MB`;
  if (s.free === null) return null;
  const margin = s.kind === 'ram'
    ? Math.max(32 * MiB, (s.total ?? 0) * 0.15)
    : Math.max(1 * MiB, (s.total ?? 0) * 0.05);
  if (s.free - margin >= need) return null;
  const where = s.kind === 'ram' ? 'RAM' : s.kind === 'disk' ? `the disk ${s.disk}` : 'flash';
  return `The Netinstall cache is in ${where}, with ${mb(s.free)} free. An install downloads about ${mb(need)} there, `
    + `and ${mb(margin)} is kept free${s.kind === 'flash' ? ' so the device can still save its configuration' : ''}. `
    + 'Point the cache at a disk or a RAM disk under Cache settings, or free some space.';
}

/** Space to install or remove a package on the device's own flash. */
export function packageSpaceProblem(size: number, free: number | null, total: number | null): string | null {
  if (free === null) return null;
  const need = size * 2 + Math.max(1 * MiB, (total ?? 0) * 0.05);
  if (free >= need) return null;
  return `The device has ${(free / MiB).toFixed(1)} MB of flash free; installing the package needs about ${(need / MiB).toFixed(1)} MB.`;
}

/** A cache directory: NetinstallCache/ at the root, or a folder on one of the device's disks. */
export function cacheDirectoryError(dir: string, disks: RosRow[]): string | null {
  const d = dir.trim().replace(/^\/+/, '');
  if (!d) return 'Enter a folder, like NetinstallCache/ or usb1/NetinstallCache/.';
  if (d.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(d) || d.split('/').some((p) => p === '..' || p === '.')) {
    return 'Use letters, digits, dots, dashes and slashes only.';
  }
  const parts = d.split('/').filter(Boolean);
  if (parts.length > 1) {
    const mounts = disks.flatMap((x) => [x['mount-point'], x.slot, x.name]).filter(Boolean);
    if (parts[0] !== 'flash' && !mounts.includes(parts[0])) return `${parts[0]} isn't one of this device's disks.`;
  }
  return null;
}
