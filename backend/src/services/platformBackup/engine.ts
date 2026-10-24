/**
 * Export and restore of MikroTik Manager's own data (platform backup).
 *
 * Tables are written as rows of JSON (row_to_json) from one consistent
 * snapshot, and read back by column name into whatever the current schema is,
 * so a backup from an older version restores after the schema has moved on:
 * columns it lacks take their defaults, columns it has that no longer exist
 * are ignored. No pg_dump binary, and no client/server version coupling.
 *
 * Restore runs in one transaction that only commits once the file's GCM tag
 * has verified, so a damaged or altered file changes nothing.
 */
import { compareMtmVersions } from '../../utils/mtmVersion';
import type { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { allDecryptionKeys, setExtraDecryptionKeys } from '../../utils/secrets';
import { reencryptAll } from '../encryptedData';
import { CONFIG_TABLES, NEVER_RESTORED, APP_SETTINGS_STATE_KEYS } from './tables';
import { readHeader, readRecords, type BackupContents, type BackupRecord } from './format';

const FETCH = 2000;
const INSERT_BATCH = 1000;

export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Is backup version a no newer than b? Release candidates sort before their
 * release ("1.0.0-rc.1" < "1.0.0"), so a 1.0.0 backup isn't restored into an RC.
 */
export function versionNotNewer(a: string, b: string): boolean {
  return compareMtmVersions(a, b) <= 0;
}

export async function publicTables(client: PoolClient): Promise<string[]> {
  const r = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
  return r.rows.map((x) => x.relname);
}

export async function tableColumns(client: PoolClient, table: string): Promise<string[]> {
  const r = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return r.rows.map((x) => x.column_name);
}

/**
 * NOT NULL json/jsonb columns, with their type. A JSON null value in one
 * reads back from row_to_json as null, which json_populate_recordset turns
 * into SQL NULL; in a column that can't be NULL it can only have been JSON
 * null, so it goes back in as that.
 */
async function jsonNotNullColumns(client: PoolClient): Promise<Map<string, Map<string, string>>> {
  const r = await client.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND is_nullable = 'NO' AND data_type IN ('json', 'jsonb')`);
  const out = new Map<string, Map<string, string>>();
  for (const x of r.rows) {
    if (!out.has(x.table_name)) out.set(x.table_name, new Map());
    out.get(x.table_name)!.set(x.column_name, x.data_type);
  }
  return out;
}

export async function primaryKey(client: PoolClient, table: string): Promise<string[]> {
  const r = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [qi(table)]);
  return r.rows.map((x) => x.attname);
}

/** The tables a backup of `contents` holds, in a restorable order. */
async function tablesFor(client: PoolClient, contents: BackupContents): Promise<string[]> {
  const present = new Set(await publicTables(client));
  const config = CONFIG_TABLES.filter((t) => present.has(t));
  if (contents === 'config') return config;
  const rest = [...present].filter((t) => !NEVER_RESTORED.has(t) && !(config as readonly string[]).includes(t)).sort();
  return [...config, ...rest];
}

/** The payload records of a backup, streamed from one consistent snapshot. */
export async function* exportRecords(contents: BackupContents, appVersion: string): AsyncGenerator<BackupRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await tablesFor(client, contents);
    yield { type: 'manifest', app_version: appVersion, contents, tables };
    // The keys go inside the encrypted payload: a restore on another server
    // reads the credentials with them and re-encrypts under its own key.
    const keys = allDecryptionKeys();
    yield { type: 'keys', current: keys.current.toString('base64'), all: keys.all.map((k) => k.toString('base64')) };
    for (const t of tables) {
      yield { type: 'table', name: t, columns: await tableColumns(client, t) };
      await client.query(`DECLARE mtm_export NO SCROLL CURSOR FOR SELECT row_to_json(mtm_row.*)::text AS j FROM ${qi(t)} mtm_row`);
      for (;;) {
        const r = await client.query<{ j: string }>(`FETCH ${FETCH} FROM mtm_export`);
        // Postgres's own JSON text, written as it is: parsing it in Node would
        // round big bigint and numeric values to a double.
        for (const row of r.rows) yield { type: 'row', raw: row.j };
        if (r.rows.length < FETCH) break;
      }
      await client.query('CLOSE mtm_export');
    }
    yield { type: 'end' };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type RestoreMode = 'config' | 'full';

export interface RestoreResult {
  mode: RestoreMode;
  tables: number;
  rows: number;
  reencrypted: number;
  /** Encrypted values neither this server's keys nor the backup's could open. */
  unreadable: number;
  skippedTables: string[];
}

async function resetSequences(client: PoolClient, table: string): Promise<void> {
  const r = await client.query<{ attname: string; seq: string | null }>(
    `SELECT a.attname, pg_get_serial_sequence($1, a.attname) AS seq FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [qi(table)]);
  for (const { attname, seq } of r.rows) {
    if (!seq) continue;
    await client.query(`SELECT setval($1, COALESCE((SELECT MAX(${qi(attname)}) FROM ${qi(table)}), 0) + 1, false)`, [seq]);
  }
}

/**
 * Restore `path`. `full` replaces every table (except NEVER_RESTORED);
 * `config` replaces the configuration tables only, keeping history for the
 * devices that remain. Throws, changing nothing, on a wrong passphrase, a
 * damaged file or a backup from a newer version.
 */
export async function restoreFromFile(
  path: string, passphrase: string, mode: RestoreMode, appVersion: string,
  onProgress: (msg: string) => void = () => {},
): Promise<RestoreResult> {
  const { header } = await readHeader(path);
  if (!versionNotNewer(header.app_version, appVersion)) {
    throw new Error(`This backup was made by MikroTik Manager ${header.app_version}, newer than this one (${appVersion}). Update first, then restore.`);
  }
  if (mode === 'full' && header.contents !== 'config+database') {
    throw new Error('This backup holds the configuration only, so it can only be restored as configuration.');
  }

  const client = await pool.connect();
  const result: RestoreResult = { mode, tables: 0, rows: 0, reencrypted: 0, unreadable: 0, skippedTables: [] };
  let backupKeys: Buffer[] = [];
  try {
    await client.query('BEGIN');
    const present = new Set(await publicTables(client));
    const columnsOf = new Map<string, string[]>();
    for (const t of present) columnsOf.set(t, await tableColumns(client, t));
    const jsonNotNull = await jsonNotNullColumns(client);
    const selectList = (t: string, columns: string[]) => columns.map((c) => {
      const type = jsonNotNull.get(t)?.get(c);
      return type ? `COALESCE(${qi(c)}, 'null'::${type})` : qi(c);
    }).join(', ');

    if (mode === 'full') {
      // Foreign keys are checked by the data itself, which came from one
      // consistent snapshot; loading table by table needs them off meanwhile.
      await client.query('SET LOCAL session_replication_role = replica');
      const wipe = [...present].filter((t) => !NEVER_RESTORED.has(t));
      if (wipe.length) await client.query(`TRUNCATE ${wipe.map(qi).join(', ')} RESTART IDENTITY`);
      onProgress('Cleared the current data');
    }

    // Rows stay as the JSON text they were written as (see exportRecords).
    const configRows = new Map<string, { columns: string[]; rows: string[] }>();
    const asArray = (rows: string[]) => `[${rows.join(',')}]`;
    let table: string | null = null;
    let cols: string[] = [];
    let batch: string[] = [];
    let sawEnd = false;

    const insertBatch = async () => {
      if (!table || !batch.length) return;
      const list = cols.map(qi).join(', ');
      await client.query(
        `INSERT INTO ${qi(table)} (${list}) OVERRIDING SYSTEM VALUE SELECT ${selectList(table, cols)} FROM json_populate_recordset(NULL::${qi(table)}, $1::json)`,
        [asArray(batch)]);
      result.rows += batch.length;
      batch = [];
    };

    for await (const rec of readRecords(path, passphrase)) {
      if (rec.type === 'keys') {
        backupKeys = ((rec.all as string[]) ?? []).map((k) => Buffer.from(k, 'base64'));
      } else if (rec.type === 'table') {
        await insertBatch();
        const name = String(rec.name);
        const wanted = mode === 'full'
          ? present.has(name) && !NEVER_RESTORED.has(name)
          : (CONFIG_TABLES as readonly string[]).includes(name) && present.has(name);
        if (!wanted) {
          if (!present.has(name)) result.skippedTables.push(name);
          table = null;
          continue;
        }
        const have = new Set(columnsOf.get(name) ?? []);
        cols = ((rec.columns as string[]) ?? []).filter((c) => have.has(c));
        table = name;
        result.tables++;
        if (mode === 'config') configRows.set(name, { columns: cols, rows: [] });
        else onProgress(`Restoring ${name}`);
      } else if (rec.type === 'row') {
        if (!table || typeof rec.raw !== 'string') continue;
        if (mode === 'config') {
          configRows.get(table)!.rows.push(rec.raw);
        } else {
          batch.push(rec.raw);
          if (batch.length >= INSERT_BATCH) await insertBatch();
        }
      } else if (rec.type === 'end') {
        sawEnd = true;
      }
    }
    // Reaching here means the GCM tag verified.
    await insertBatch();
    if (!sawEnd) throw new Error('The backup file is incomplete.');

    if (mode === 'config') {
      // Remove what the backup doesn't have, children first (removing a device
      // takes its history with it, as deleting it would), then add or update
      // the rest, parents first. Removing first frees unique names (a user
      // re-created under another id) before the backup's rows go in.
      const order = CONFIG_TABLES.filter((t) => configRows.has(t));
      for (const t of [...order].reverse()) {
        const pk = await primaryKey(client, t);
        // No key to match on (none today): replace the table outright.
        if (!pk.length) { await client.query(`DELETE FROM ${qi(t)}`); continue; }
        const match = pk.map((k) => `mtm_bak.${qi(k)} IS NOT DISTINCT FROM mtm_cur.${qi(k)}`).join(' AND ');
        const stateGuard = t === 'app_settings' ? ` AND mtm_cur.key <> ALL($2::text[])` : '';
        await client.query(
          `DELETE FROM ${qi(t)} mtm_cur WHERE NOT EXISTS (SELECT 1 FROM json_populate_recordset(NULL::${qi(t)}, $1::json) mtm_bak WHERE ${match})${stateGuard}`,
          t === 'app_settings' ? [asArray(configRows.get(t)!.rows), [...APP_SETTINGS_STATE_KEYS]] : [asArray(configRows.get(t)!.rows)]);
      }
      for (const t of order) {
        const { columns, rows } = configRows.get(t)!;
        const pk = await primaryKey(client, t);
        const list = columns.map(qi).join(', ');
        const updates = columns.filter((c) => !pk.includes(c)).map((c) => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ');
        // State kept in app_settings stays as it is here.
        const stateGuard = t === 'app_settings' ? ` WHERE key <> ALL($2::text[])` : '';
        const onConflict = pk.length ? ` ON CONFLICT (${pk.map(qi).join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}` : '';
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          const chunk = rows.slice(i, i + INSERT_BATCH);
          await client.query(
            `INSERT INTO ${qi(t)} (${list}) OVERRIDING SYSTEM VALUE SELECT ${selectList(t, columns)} FROM json_populate_recordset(NULL::${qi(t)}, $1::json)${stateGuard}${onConflict}`,
            t === 'app_settings' ? [asArray(chunk), [...APP_SETTINGS_STATE_KEYS]] : [asArray(chunk)]);
          result.rows += chunk.length;
        }
        await resetSequences(client, t);
        onProgress(`Restored ${t}`);
      }
    } else {
      for (const t of present) if (!NEVER_RESTORED.has(t)) await resetSequences(client, t);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The credentials came under the backup's key; put them under this
  // server's. Done straight after the commit, before the restart that follows.
  if (backupKeys.length) {
    setExtraDecryptionKeys(backupKeys);
    try {
      const r = await reencryptAll();
      result.reencrypted = r.rewritten;
      result.unreadable = r.unreadable;
    } finally {
      setExtraDecryptionKeys([]);
    }
  }
  return result;
}
