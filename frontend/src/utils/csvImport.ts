import type { BulkAddDeviceItem, CredentialPreset } from '../services/api';

/**
 * Parsing a device list for bulk import (#160).
 *
 * Requested by an operator with ~1,500 devices. Rows become items for the
 * existing bulk-add job, so adding, progress and cancel all behave the same as
 * "Try All" on discovered devices.
 *
 * Every row is checked before anything is sent, and problems are reported per
 * line. A 500-row file with three typos should show three errors, not fail at
 * row 212 of a running job.
 */

export const MAX_ROWS = 500; // the bulk-add endpoint's own limit

const DEVICE_TYPES: Record<string, string> = {
  router: 'router', rtr: 'router',
  switch: 'switch', sw: 'switch',
  wireless_ap: 'wireless_ap', ap: 'wireless_ap', wireless: 'wireless_ap', wap: 'wireless_ap',
  other: 'other',
};

/** Header aliases, so a spreadsheet exported from another tool mostly just works. */
const COLUMNS: Record<string, keyof RowFields> = {
  name: 'name', identity: 'name', hostname: 'name',
  ip: 'ip_address', ip_address: 'ip_address', address: 'ip_address', host: 'ip_address',
  type: 'device_type', device_type: 'device_type',
  preset: 'credential_preset', credential_preset: 'credential_preset', credentials: 'credential_preset',
  username: 'api_username', user: 'api_username', api_username: 'api_username',
  password: 'api_password', api_password: 'api_password',
  port: 'api_port', api_port: 'api_port',
  // SSH is optional. Left blank, SSH (backups, bulk commands, key deployment)
  // uses the API username and password, which is the usual case.
  ssh_username: 'ssh_username', ssh_user: 'ssh_username',
  ssh_password: 'ssh_password', ssh_pass: 'ssh_password',
  ssh_port: 'ssh_port',
  // Several tags in one cell, separated by | or ; (or commas, inside quotes).
  tags: 'tags', tag: 'tags', groups: 'tags', group: 'tags',
  notes: 'notes', note: 'notes', comment: 'notes',
};

interface RowFields {
  name?: string;
  ip_address?: string;
  device_type?: string;
  credential_preset?: string;
  api_username?: string;
  api_password?: string;
  api_port?: string;
  ssh_username?: string;
  ssh_password?: string;
  ssh_port?: string;
  tags?: string;
  notes?: string;
}

export interface ParsedRow {
  /** 1-based line number in the file, for error messages. */
  line: number;
  item: BulkAddDeviceItem | null;
  errors: string[];
  warnings: string[];
  /**
   * Already managed at this address. Not sent: the bulk job reports an existing
   * device as a duplicate-serial failure and leaves it unchanged, so including
   * it would only add a failed row to the results.
   */
  skip: boolean;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Problems with the file itself rather than a row. */
  fileErrors: string[];
  /** Header names that were not recognised and will be ignored. */
  ignoredColumns: string[];
}

/**
 * The separator a file uses. Excel writes semicolons instead of commas in many
 * locales (wherever the decimal separator is a comma), and some exports use
 * tabs. Decided from the header line, counting only characters outside quotes.
 */
export function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of headerLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

/** Split one CSV line, honouring quotes and doubled quotes inside them. */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function validAddress(v: string): boolean {
  const m = IPV4.exec(v);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return HOSTNAME.test(v);
}

export function parseDeviceCsv(
  text: string,
  presets: Pick<CredentialPreset, 'id' | 'name'>[],
  existingAddresses: string[] = [],
  tags: { id: number; name: string }[] = []
): ParseResult {
  const tagByName = new Map(tags.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const fileErrors: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  // First non-blank, non-comment line is the header.
  const headerIdx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (headerIdx === -1) return { rows: [], fileErrors: ['The file is empty.'], ignoredColumns: [] };

  const delimiter = detectDelimiter(lines[headerIdx]);
  const header = splitCsvLine(lines[headerIdx], delimiter).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const mapping = header.map((h) => COLUMNS[h]);
  const ignoredColumns = header.filter((h, i) => h && !mapping[i]);
  if (!mapping.includes('ip_address')) {
    fileErrors.push('No address column. Add a header row with at least "ip_address" (or "ip", "address", "host").');
    return { rows: [], fileErrors, ignoredColumns };
  }

  const presetByName = new Map(presets.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const existing = new Set(existingAddresses.map((a) => a.trim().toLowerCase()));
  const seen = new Map<string, number>();
  const rows: ParsedRow[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const cells = splitCsvLine(raw, delimiter);
    const f: RowFields = {};
    mapping.forEach((key, c) => { if (key && cells[c] !== undefined && cells[c] !== '') f[key] = cells[c]; });

    const line = i + 1;
    const errors: string[] = [];
    const warnings: string[] = [];
    const addr = (f.ip_address || '').trim();

    if (!addr) errors.push('Missing address.');
    else if (!validAddress(addr)) errors.push(`"${addr}" is not a valid IP address or hostname.`);

    const key = addr.toLowerCase();
    if (addr && seen.has(key)) errors.push(`Same address as line ${seen.get(key)}.`);
    else if (addr) seen.set(key, line);
    // The template's example rows use 192.0.2.0/24, which is reserved for
    // documentation (RFC 5737) and never a real device. Left in by mistake,
    // they are skipped rather than queued as devices that can never connect.
    const example = /^192\.0\.2\.\d{1,3}$/.test(addr);
    const managed = !!addr && existing.has(key);
    const skip = example || managed;
    if (example) warnings.push('Example row from the template. Skipped.');
    else if (managed) warnings.push('Already managed. Skipped.');

    let deviceType: string | undefined;
    if (f.device_type) {
      deviceType = DEVICE_TYPES[f.device_type.toLowerCase()];
      if (!deviceType) errors.push(`Unknown type "${f.device_type}". Use router, switch, ap or other.`);
    }

    let presetId: number | undefined;
    if (f.credential_preset) {
      presetId = presetByName.get(f.credential_preset.trim().toLowerCase());
      if (presetId === undefined) errors.push(`No credential preset called "${f.credential_preset}".`);
    } else if (!f.api_username || !f.api_password) {
      errors.push('Needs a credential preset, or both username and password.');
    }

    const portOf = (v: string | undefined, label: string): number | undefined => {
      if (!v) return undefined;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
      errors.push(`${label} "${v}" is not valid.`);
      return undefined;
    };
    const port = portOf(f.api_port, 'Port');
    const sshPort = portOf(f.ssh_port, 'SSH port');

    // A username without a password (or the reverse) is half a credential, and
    // the device would end up with SSH that can never log in.
    const hasSsh = !!(f.ssh_username || f.ssh_password);
    if (hasSsh && !(f.ssh_username && f.ssh_password)) {
      errors.push('SSH needs both ssh_username and ssh_password, or neither.');
    }
    if (presetId !== undefined && (hasSsh || sshPort)) {
      warnings.push('Uses the preset\'s SSH settings. The SSH columns on this line are ignored.');
    }

    // Existing tags only: creating tags is an admin action, and a typo should
    // be caught here rather than quietly start a new group.
    const tagIds: number[] = [];
    for (const name of (f.tags ?? '').split(/[|;,]/).map((t) => t.trim()).filter(Boolean)) {
      const id = tagByName.get(name.toLowerCase());
      if (id === undefined) errors.push(`No tag called "${name}". Create it under Settings → Tags first.`);
      else if (!tagIds.includes(id)) tagIds.push(id);
    }

    const item: BulkAddDeviceItem | null = errors.length ? null : {
      name: f.name?.trim() || addr,
      ip_address: addr,
      ...(deviceType ? { device_type: deviceType } : {}),
      ...(presetId !== undefined ? { credential_preset_id: presetId } : {
        api_username: f.api_username, api_password: f.api_password,
      }),
      ...(port ? { api_port: port } : {}),
      ...(presetId === undefined && hasSsh ? { ssh_username: f.ssh_username, ssh_password: f.ssh_password } : {}),
      ...(presetId === undefined && sshPort ? { ssh_port: sshPort } : {}),
      ...(tagIds.length ? { tag_ids: tagIds } : {}),
      ...(f.notes ? { notes: f.notes } : {}),
    };
    rows.push({ line, item, errors, warnings, skip });
  }

  if (rows.length === 0) fileErrors.push('The file has a header but no device rows.');
  if (rows.length > MAX_ROWS) {
    fileErrors.push(`${rows.length} rows; the limit per import is ${MAX_ROWS}. Split the file and import it in parts.`);
  }
  return { rows, fileErrors, ignoredColumns };
}

/**
 * A starter file, offered as a download so people do not have to guess the
 * columns. No comment lines: most people open this in a spreadsheet, where a
 * "#" note shows up as a row of data. The example rows explain themselves in
 * the notes column instead, and use documentation addresses (192.0.2.x) so
 * they are skipped if left in.
 *
 * `presetName` is one of the installation's own presets, when it has any, so
 * the preset example works as written.
 */
export function buildCsvTemplate(presetName?: string, tagName?: string): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows: string[][] = [
    ['name', 'ip_address', 'type', 'preset', 'username', 'password', 'ssh_username', 'ssh_password', 'tags', 'notes'],
  ];
  const tag = tagName ?? '';
  if (presetName) {
    rows.push(['example-switch', '192.0.2.10', 'switch', presetName, '', '', '', '', tag,
      'Example: logs in with a saved credential preset. Replace these rows with your devices.']);
  }
  rows.push(['example-router', '192.0.2.1', 'router', '', 'admin', 'your-password', '', '', tag,
    'Example: username and password instead of a preset.']);
  rows.push(['example-ap', '192.0.2.20', 'ap', '', 'admin', 'your-password', 'backup', 'ssh-password', '',
    'Example: separate SSH login. Leave SSH blank to use the same login.']);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
