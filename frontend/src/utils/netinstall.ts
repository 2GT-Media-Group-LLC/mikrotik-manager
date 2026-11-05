/**
 * Netinstall form checks (#310), the same ones the server makes
 * (backend/src/utils/netinstall.ts), so a form says what's wrong inline and
 * Save stays off until it's right.
 */

export const ARCHES = ['arm', 'arm64', 'mipsbe', 'mmips', 'smips', 'ppc', 'tile', 'x86'] as const;

export const KNOWN_EXTRA_PACKAGES = [
  'calea', 'container', 'dude', 'gps', 'iot', 'iot-bt-extra', 'lora', 'netinstall', 'openflow',
  'rose-storage', 'switch-marvell', 'tr069-client', 'ups', 'user-manager', 'wifi-halow-mm',
  'wifi-mediatek', 'wifi-qcom', 'wifi-qcom-ac', 'wireless', 'zerotier',
];

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

export function normalizeMac(raw: string): string | null {
  const s = raw.trim().replace(/-/g, ':');
  return MAC.test(s) ? s.toUpperCase() : null;
}

function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

export function ipRangeError(raw: string): string | null {
  const parts = raw.replace(/\s+/g, '').split('-');
  if (parts.length !== 2) return 'Enter a range like 192.168.88.10-192.168.88.20.';
  const [a, b] = parts.map(ipv4);
  if (a === null || b === null) return 'Both ends of the range must be IPv4 addresses.';
  if (a > b) return 'The range must start at the lower address.';
  if (b - a + 1 > 256) return 'Keep the range to 256 addresses or fewer.';
  return null;
}

export const isRosRelease = (v: string) => /^\d+\.\d+(\.\d+)?((beta|rc)\d+)?$/.test(v);

export function versionError(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (!isRosRelease(t)) return 'Enter a RouterOS version like 7.25 or 7.24.3, or leave it empty for the latest.';
  if (Number(t.split('.')[0]) < 7) return 'Netinstall from RouterOS installs RouterOS 7.';
  return null;
}

export function packagesError(list: string[], known: string[]): string | null {
  const allowed = new Set([...KNOWN_EXTRA_PACKAGES, ...known]);
  const bad = list.filter((n) => n !== 'routeros' && !allowed.has(n));
  if (bad.length) return `Not a RouterOS package: ${bad.join(', ')}.`;
  if (list.length > 20) return 'At most 20 extra packages.';
  return null;
}

export interface EntryForm {
  interface: string;
  mac: string;
  ipRange: string;
  version: string;
  extraPackages: string[];
  autoReboot: 'reboot' | 'shutdown' | 'none';
  keepOld: boolean;
  applyDefault: boolean;
  installOnce: boolean;
  removeBranding: boolean;
  wait: boolean;
  allowEtherboot: boolean;
  allowFlashfig: boolean;
  disabled: boolean;
  comment: string;
}

export const OPEN_ENTRY_MESSAGE = 'Enter the MAC address of the device to install, or turn on Wait so each install is started by hand. '
  + 'Without either, any device on this segment that etherboots would be reformatted.';

/** Field to message; empty when the form can be saved. `hadMac`/`hadRange`: the entry being edited had one. */
export function entryErrors(f: EntryForm, ctx: { interfaces: string[]; packages: string[]; hadMac?: boolean; hadRange?: boolean }): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.interface) e.interface = 'Choose the interface the device to install is reached on.';
  else if (!ctx.interfaces.includes(f.interface)) e.interface = `${f.interface} isn't an interface on this device.`;
  const mac = f.mac.trim();
  if (mac) {
    const m = normalizeMac(mac);
    if (!m) e.mac = 'Enter a MAC address like 01:23:45:67:89:AB.';
    else if ((parseInt(m.slice(0, 2), 16) & 1) === 1 || m === '00:00:00:00:00:00') e.mac = 'That\'s a multicast or broadcast address; use the device\'s own MAC.';
  } else if (ctx.hadMac) {
    e.mac = 'RouterOS can\'t clear the MAC address of an entry. Delete the entry and add it again.';
  }
  if (f.ipRange.trim()) { const r = ipRangeError(f.ipRange); if (r) e.ipRange = r; }
  else if (ctx.hadRange) e.ipRange = 'RouterOS can\'t clear the range of an entry. Delete the entry and add it again, or enter a range.';
  const v = versionError(f.version); if (v) e.version = v;
  const p = packagesError(f.extraPackages, ctx.packages); if (p) e.extraPackages = p;
  if (f.keepOld && f.applyDefault) e.applyDefault = 'Choose one: keep the old configuration, or apply the default one.';
  if (f.comment.length > 255) e.comment = 'Keep the comment under 255 characters.';
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f]/.test(f.comment)) e.comment = 'The comment can\'t contain line breaks or control characters.';
  if (!e.mac && !mac && !f.wait && !f.disabled && (f.allowEtherboot || f.allowFlashfig)) e.mac = OPEN_ENTRY_MESSAGE;
  return e;
}

/**
 * The form as the API takes it. MAC and range are only sent when set
 * (RouterOS can't clear them), and the comment when there is one or it's an edit.
 */
export function entryBody(f: EntryForm, editing = false): Record<string, string | boolean> {
  const b: Record<string, string | boolean> = {
    interface: f.interface,
    version: f.version.trim(),
    'extra-packages': f.extraPackages.join(','),
    'auto-reboot': f.autoReboot,
    'keep-old-configuration': f.keepOld,
    'apply-default-configuration': f.applyDefault,
    'install-once': f.installOnce,
    'remove-branding': f.removeBranding,
    wait: f.wait,
    'allow-etherboot': f.allowEtherboot,
    'allow-flashfig': f.allowFlashfig,
    disabled: f.disabled,
  };
  if (f.comment || editing) b.comment = f.comment;
  if (f.mac.trim()) b['mac-address'] = normalizeMac(f.mac) ?? f.mac.trim();
  if (f.ipRange.trim()) b['ip-range'] = f.ipRange.replace(/\s+/g, '');
  return b;
}

/** An entry as RouterOS prints it, as the form edits it. */
export function entryForm(row?: Record<string, string>): EntryForm {
  const yes = (k: string, d: boolean) => (row?.[k] === undefined ? d : row[k] === 'true');
  return {
    interface: row?.interface ?? '',
    mac: row?.['mac-address'] ?? '',
    ipRange: row?.['ip-range'] ?? '',
    version: row?.version ?? '',
    extraPackages: (row?.['extra-packages'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    autoReboot: (['reboot', 'shutdown', 'none'].includes(row?.['auto-reboot'] ?? '') ? row!['auto-reboot'] : 'reboot') as EntryForm['autoReboot'],
    keepOld: yes('keep-old-configuration', true),
    applyDefault: yes('apply-default-configuration', false),
    installOnce: yes('install-once', true),
    removeBranding: yes('remove-branding', false),
    // A new entry waits by default: each install is started by hand.
    wait: yes('wait', !row),
    allowEtherboot: yes('allow-etherboot', true),
    allowFlashfig: yes('allow-flashfig', false),
    disabled: yes('disabled', false),
    comment: row?.comment ?? '',
  };
}

export function cacheDirectoryError(dir: string, disks: string[]): string | null {
  const d = dir.trim().replace(/^\/+/, '');
  if (!d) return 'Enter a folder, like NetinstallCache/ or usb1/NetinstallCache/.';
  if (d.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(d) || d.split('/').some((p) => p === '..' || p === '.')) {
    return 'Use letters, digits, dots, dashes and slashes only.';
  }
  const parts = d.split('/').filter(Boolean);
  if (parts.length > 1 && parts[0] !== 'flash' && !disks.includes(parts[0])) return `${parts[0]} isn't one of this device's disks.`;
  return null;
}

export const formatMb = (n: number | null) => (n === null ? '—' : `${(n / 1024 / 1024).toFixed(1)} MB`);
