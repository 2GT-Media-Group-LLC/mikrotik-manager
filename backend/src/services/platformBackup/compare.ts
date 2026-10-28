/**
 * What restoring a platform backup would change, without changing anything.
 *
 * Reads the backup (the passphrase is needed, as for a restore) and compares
 * it with this server, table by table:
 *
 *   - configuration tables, row by row on their primary key: what the backup
 *     would add, what it would remove, and what it would change, field by field;
 *   - history tables (in a configuration + database backup): row counts only,
 *     since a full restore replaces them wholesale.
 *
 * Only what someone configured counts as a change. Timestamps and the state
 * polling keeps up to date (status, versions, health, last seen) are left out,
 * or every device would always differ. Encrypted values are compared after
 * decryption, each side with its own keys (every encryption uses a fresh IV, so
 * the stored text always differs), and so are alert channels' sealed secrets.
 * The result names tables, rows and fields, never values.
 */
import { pool } from '../../config/database';
import { decrypt } from '../../utils/crypto';
import { setExtraDecryptionKeys } from '../../utils/secrets';
import { openConfig } from '../../utils/alertChannelSecrets';
import { encryptedColumns } from '../encryptedData';
import { readHeader, readRecords, type BackupContents } from './format';
import { publicTables, primaryKey, tableColumns, qi } from './engine';
import { CONFIG_TABLES, NEVER_RESTORED, APP_SETTINGS_STATE_KEYS } from './tables';

const SAMPLE_LIMIT = 25;

/** Columns that polling or the app keep up to date: not configuration. */
const RUNTIME_COLUMNS: Record<string, string[]> = {
  devices: [
    'model', 'serial_number', 'firmware_version', 'ros_version', 'status', 'firmware_update_available',
    'latest_ros_version', 'ip_addresses_jsonb', 'routerboard_upgrade_available', 'upgrade_firmware_version',
    'wifi_role', 'wifi_package', 'has_lte', 'time_zone_name', 'gmt_offset', 'reported_update_channel',
    'health_status', 'health_issues', 'architecture', 'installed_packages', 'capsman_flavor', 'wifi_role_probe', 'wifi_role_checked_at',
    'user_manager', 'ros_identity', 'api_check_error',
  ],
  users: ['session_version'],
  managed_device_certs: ['last_error'],
};
/** Timestamps that are settings rather than bookkeeping: everything else timestamped is ignored. */
const SETTING_TIMESTAMPS = new Set(['expires_at', 'start_at', 'end_at', 'not_before', 'not_after']);
const isVolatile = (table: string, column: string, timestamps: Set<string>) =>
  (timestamps.has(column) && !SETTING_TIMESTAMPS.has(column)) || column.startsWith('last_')
  || (RUNTIME_COLUMNS[table]?.includes(column) ?? false);

/** Hashes and secrets: compared, never shown, and named plainly. */
const SECRET_COLUMNS = new Set(['password_hash', 'token_hash', 'totp_secret', 'totp_pending_secret']);

const TABLE_LABEL: Record<string, string> = {
  sites: 'Sites', users: 'Users', tags: 'Tags', credential_presets: 'Credential presets', devices: 'Devices',
  device_ca: 'Certificate authority', managed_device_certs: 'Device certificates', user_site_roles: 'Site roles', site_groups: 'Groups', user_group_roles: 'Group roles', romon_settings: 'RoMON settings',
  api_tokens: 'API tokens', device_tags: 'Device tags', device_ssh_keys: 'Device SSH keys',
  device_identity_pins: 'Pinned device identities', alert_channels: 'Alert channels', alert_rules: 'Alert rules',
  app_settings: 'Settings', webhooks: 'Webhooks', report_schedules: 'Report schedules',
  maintenance_windows: 'Maintenance windows', command_templates: 'Command templates', command_secrets: 'Command secrets',
  config_templates: 'Config templates', firmware_mirrors: 'Firmware mirrors', firmware_mirror_clients: 'Firmware mirror assignments',
  lte_data_cap_rules: 'LTE data cap rules', security_check_suppressions: 'Muted security checks',
  insight_dismissals: 'Dismissed insights', topology_nodes: 'Topology nodes', topology_positions: 'Topology layout',
  topology_hand_links: 'Hand-drawn links', topology_hidden_links: 'Hidden links',
  topology_neighbour_overrides: 'Renamed neighbours', topology_edge_anchors: 'Link anchors',
};

export interface TableDiff {
  table: string;
  label: string;
  added: number;
  removed: number;
  changed: number;
  samples: { added: string[]; removed: string[]; changed: { row: string; fields: string[] }[] };
}

export interface HistoryCount { table: string; current: number; backup: number }

export interface CompareResult {
  contents: BackupContents;
  appVersion: string;
  createdAt: string;
  /** Configuration tables with differences, in restore order. */
  tables: TableDiff[];
  /** History tables whose row counts differ (configuration + database backups only). */
  history: HistoryCount[];
  /** Tables in the backup this server doesn't have (an older or newer schema). */
  skippedTables: string[];
  /** No configuration differences (history aside). */
  identical: boolean;
}

type Row = Record<string, unknown>;

/** A readable name for a row: its name, username, key... or its primary key. */
function rowLabel(table: string, row: Row, pk: string[], deviceNames: Map<string, string>): string {
  const name = (k: string) => (typeof row[k] === 'string' && (row[k] as string).trim() ? (row[k] as string).trim() : null);
  const dev = row['device_id'] != null ? deviceNames.get(String(row['device_id'])) : undefined;
  if (table === 'device_ca') return 'The certificate authority';
  // Layout rows are keyed by node: a bare number is a device.
  const node = name('node_key');
  if (node && /^\d+$/.test(node)) return deviceNames.get(node) ?? `device ${node}`;
  const own = name('name') ?? name('username') ?? name('title') ?? name('key') ?? name('event_type') ?? node ?? name('edge_key');
  if (table === 'devices' && own) return `${own}${row['ip_address'] ? ` (${row['ip_address']})` : ''}`;
  if (own) return dev ? `${dev}: ${own}` : own;
  if (dev) return pk.length > 1 ? `${dev} (${pk.filter((k) => k !== 'device_id').map((k) => String(row[k])).join(', ')})` : dev;
  return pk.map((k) => String(row[k])).join(' / ');
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare a backup with this server. Throws on a wrong passphrase or a
 * damaged file, as a restore would; reads only.
 */
export async function compareWithFile(path: string, passphrase: string): Promise<CompareResult> {
  const { header } = await readHeader(path);
  const configSet = new Set<string>(CONFIG_TABLES);
  const backupRows = new Map<string, { columns: string[]; rows: Row[] }>();
  const backupCounts = new Map<string, number>();
  let backupKeys: Buffer[] = [];
  let table: string | null = null;
  let sawEnd = false;

  for await (const rec of readRecords(path, passphrase)) {
    if (rec.type === 'keys') backupKeys = ((rec.all as string[]) ?? []).map((k) => Buffer.from(k, 'base64'));
    else if (rec.type === 'table') {
      table = String(rec.name);
      if (configSet.has(table)) backupRows.set(table, { columns: (rec.columns as string[]) ?? [], rows: [] });
      else backupCounts.set(table, 0);
    } else if (rec.type === 'row' && table && typeof rec.raw === 'string') {
      const bucket = backupRows.get(table);
      if (bucket) bucket.rows.push(JSON.parse(rec.raw) as Row);
      else backupCounts.set(table, (backupCounts.get(table) ?? 0) + 1);
    } else if (rec.type === 'end') sawEnd = true;
  }
  // Reaching here means the file's integrity tag verified.
  if (!sawEnd) throw new Error('The backup file is incomplete.');

  const encrypted = new Map<string, Set<string>>();
  for (const c of encryptedColumns()) {
    if (!encrypted.has(c.table)) encrypted.set(c.table, new Set());
    encrypted.get(c.table)!.add(c.column);
  }

  const client = await pool.connect();
  // The backup's keys open its encrypted values; this server's open its own.
  setExtraDecryptionKeys(backupKeys);
  try {
    const present = new Set(await publicTables(client));
    const deviceRows = await client.query<{ id: number; name: string }>(`SELECT id, name FROM devices`);
    const tsRows = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'`);
    const timestampsOf = new Map<string, Set<string>>();
    for (const r of tsRows.rows) {
      if (!timestampsOf.has(r.table_name)) timestampsOf.set(r.table_name, new Set());
      timestampsOf.get(r.table_name)!.add(r.column_name);
    }
    const deviceNames = new Map(deviceRows.rows.map((d) => [String(d.id), d.name.trim()]));
    for (const d of backupRows.get('devices')?.rows ?? []) {
      if (d['id'] != null && typeof d['name'] === 'string') deviceNames.set(String(d['id']), d['name'].trim());
    }
    const open = (v: unknown): unknown => {
      if (typeof v !== 'string' || !v) return v;
      try { return decrypt(v); } catch { return `unreadable:${v}`; }
    };

    const tables: TableDiff[] = [];
    for (const t of CONFIG_TABLES) {
      const b = backupRows.get(t);
      if (!b || !present.has(t)) continue;
      const pk = await primaryKey(client, t);
      if (!pk.length) continue;
      const have = new Set(await tableColumns(client, t));
      const ts = timestampsOf.get(t) ?? new Set<string>();
      const compared = b.columns.filter((c) => have.has(c) && !pk.includes(c) && !isVolatile(t, c, ts));
      const current = (await client.query<{ j: Row }>(`SELECT row_to_json(mtm_row.*) AS j FROM ${qi(t)} mtm_row`)).rows.map((r) => r.j);
      const keep = (r: Row) => t !== 'app_settings' || !APP_SETTINGS_STATE_KEYS.has(String(r['key']));
      const keyOf = (r: Row) => JSON.stringify(pk.map((k) => r[k]));
      const cur = new Map(current.filter(keep).map((r) => [keyOf(r), r]));
      const bak = new Map(b.rows.filter(keep).map((r) => [keyOf(r), r]));
      const enc = encrypted.get(t) ?? new Set<string>();
      const valueOf = (r: Row, c: string) => {
        if (enc.has(c)) return open(r[c]);
        if (t === 'alert_channels' && c === 'config' && r['config'] && typeof r['config'] === 'object') {
          try { return openConfig(String(r['type'] ?? ''), r['config'] as Record<string, unknown>); } catch { return r['config']; }
        }
        return r[c];
      };

      const diff: TableDiff = { table: t, label: TABLE_LABEL[t] ?? t, added: 0, removed: 0, changed: 0, samples: { added: [], removed: [], changed: [] } };
      for (const [k, row] of bak) {
        const now = cur.get(k);
        if (!now) {
          diff.added++;
          if (diff.samples.added.length < SAMPLE_LIMIT) diff.samples.added.push(rowLabel(t, row, pk, deviceNames));
          continue;
        }
        const fields = compared.filter((c) => !same(valueOf(row, c), valueOf(now, c)));
        if (fields.length) {
          diff.changed++;
          if (diff.samples.changed.length < SAMPLE_LIMIT) {
            diff.samples.changed.push({
              row: rowLabel(t, row, pk, deviceNames),
              fields: fields.map((c) => (enc.has(c) || SECRET_COLUMNS.has(c) ? `${c.replace(/_encrypted$|_hash$/, '')} (secret)` : c)),
            });
          }
        }
      }
      for (const [k, row] of cur) {
        if (bak.has(k)) continue;
        diff.removed++;
        if (diff.samples.removed.length < SAMPLE_LIMIT) diff.samples.removed.push(rowLabel(t, row, pk, deviceNames));
      }
      if (diff.added || diff.removed || diff.changed) tables.push(diff);
    }

    const history: HistoryCount[] = [];
    if (header.contents === 'config+database') {
      for (const [t, backupCount] of backupCounts) {
        if (!present.has(t) || NEVER_RESTORED.has(t)) continue;
        const n = Number((await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${qi(t)}`)).rows[0]?.n ?? 0);
        if (n !== backupCount) history.push({ table: t, current: n, backup: backupCount });
      }
      history.sort((a, b) => Math.abs(b.current - b.backup) - Math.abs(a.current - a.backup));
    }

    const skippedTables = [...backupRows.keys(), ...backupCounts.keys()].filter((t) => !present.has(t));
    return {
      contents: header.contents, appVersion: header.app_version, createdAt: header.created_at,
      tables, history, skippedTables, identical: tables.length === 0,
    };
  } finally {
    setExtraDecryptionKeys([]);
    client.release();
  }
}
