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

/** Split one CSV line, honouring quotes and doubled quotes inside them. */
export function splitCsvLine(line: string): string[] {
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
    else if (ch === ',') { out.push(cur); cur = ''; }
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
  existingAddresses: string[] = []
): ParseResult {
  const fileErrors: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  // First non-blank, non-comment line is the header.
  const headerIdx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (headerIdx === -1) return { rows: [], fileErrors: ['The file is empty.'], ignoredColumns: [] };

  const header = splitCsvLine(lines[headerIdx]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
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

    const cells = splitCsvLine(raw);
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
    const skip = !!addr && existing.has(key);
    if (skip) warnings.push('Already managed. Skipped.');

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

/** A starter file, offered as a download so people do not have to guess the columns. */
export const CSV_TEMPLATE = [
  'name,ip_address,type,preset,notes',
  'core-sw-01,10.0.0.2,switch,Default,Rack A',
  'edge-rtr-01,10.0.0.1,router,Default,',
  '# Without a preset, supply username and password columns instead.',
  '# Optional: ssh_username, ssh_password, ssh_port. Blank means SSH uses the API login.',
].join('\n') + '\n';
