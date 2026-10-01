/**
 * Everything encrypted with the manager's key, in one place (outside review
 * P2-29).
 *
 * The earlier sweep only re-encrypted device and preset passwords, so SSH
 * private keys, the OIDC client secret and encrypted backups stayed under the
 * old key forever, and the old key could never be retired. It also swallowed
 * every failure, so nothing said when data had become unreadable.
 *
 * This lists every encrypted value, reports which key opens each one, and
 * re-encrypts anything still under an older key.
 */
import { hasPlaintextSecret, sealConfig, sensitiveKeys } from '../utils/alertChannelSecrets';
import { SEALED_PREFIX, isSealed, seal, sealedCiphertext } from '../utils/sealed';
import * as fs from 'fs';
import { query } from '../config/database';
import { encrypt, decrypt, ciphertextKeyState } from '../utils/crypto';

export interface LocationStatus {
  location: string;
  current: number;
  old: number;
  unreadable: number;
}

/** Encrypted columns: table, row key, column, and a name for the UI. */
const COLUMNS: Array<{ table: string; id: string; column: string; label: string }> = [
  { table: 'devices', id: 'id', column: 'api_password_encrypted', label: 'Device API passwords' },
  { table: 'devices', id: 'id', column: 'ssh_password_encrypted', label: 'Device SSH passwords' },
  { table: 'credential_presets', id: 'id', column: 'api_password_encrypted', label: 'Credential preset API passwords' },
  { table: 'credential_presets', id: 'id', column: 'ssh_password_encrypted', label: 'Credential preset SSH passwords' },
  { table: 'device_ssh_keys', id: 'device_id', column: 'private_key_encrypted', label: 'Device SSH private keys' },
];

const OIDC_KEY = 'oidc_config';

type Row = { id: number; value: string };

async function columnRows(c: (typeof COLUMNS)[number]): Promise<Row[]> {
  // Identifiers come from the fixed list above, never from a request.
  return query<Row>(`SELECT ${c.id} AS id, ${c.column} AS value FROM ${c.table} WHERE ${c.column} IS NOT NULL AND ${c.column} <> ''`);
}

async function oidcSecret(): Promise<{ config: Record<string, unknown>; value: string } | null> {
  const rows = await query<{ value: Record<string, unknown> }>(`SELECT value FROM app_settings WHERE key = $1`, [OIDC_KEY]);
  const config = rows[0]?.value;
  const value = config?.['client_secret_encrypted'];
  return typeof value === 'string' && value ? { config, value } : null;
}

/** Alert channels whose settings hold secrets (sealed or not), with their type. */
async function alertChannels(): Promise<Array<{ id: number; type: string; config: Record<string, unknown> }>> {
  return query<{ id: number; type: string; config: Record<string, unknown> }>(`SELECT id, type, config FROM alert_channels`);
}

/** Sealed secret fields of one channel's settings: [key, ciphertext]. */
function sealedFields(type: string, config: Record<string, unknown>): Array<[string, string]> {
  const keys = sensitiveKeys(type);
  const out: Array<[string, string]> = [];
  for (const [key, v] of Object.entries(config ?? {})) {
    const c = keys.has(key) && typeof v === 'string' ? sealedCiphertext(v) : null;
    if (c) out.push([key, c]);
  }
  return out;
}

async function webhookSecrets(): Promise<Array<{ id: number; secret: string }>> {
  return query<{ id: number; secret: string }>(`SELECT id, secret FROM webhooks WHERE secret IS NOT NULL AND secret <> ''`);
}

/**
 * Seal alert channel and webhook secrets stored in plaintext before 0.24.50
 * (outside review S7). Run at startup once the key is confirmed; values
 * already sealed are left alone, so it is a no-op after the first run.
 */
export async function sealPlaintextSecrets(): Promise<number> {
  let sealed = 0;
  for (const ch of await alertChannels()) {
    if (!ch.config || !hasPlaintextSecret(ch.type, ch.config)) continue;
    await query(`UPDATE alert_channels SET config = $1 WHERE id = $2`, [JSON.stringify(sealConfig(ch.type, ch.config)), ch.id]);
    sealed++;
  }
  for (const w of await webhookSecrets()) {
    if (isSealed(w.secret)) continue;
    await query(`UPDATE webhooks SET secret = $1 WHERE id = $2`, [seal(w.secret), w.id]);
    sealed++;
  }
  if (sealed > 0) console.log(`[secrets] encrypted ${sealed} alert channel / webhook secret(s) that were stored in plaintext`);
  return sealed;
}

async function encryptedBackups(): Promise<Array<{ id: number; file_path: string }>> {
  return query<{ id: number; file_path: string }>(`SELECT id, file_path FROM backups WHERE encrypted = TRUE`);
}

function tally(location: string, states: Array<'current' | 'old' | 'none'>): LocationStatus {
  return {
    location,
    current: states.filter((s) => s === 'current').length,
    old: states.filter((s) => s === 'old').length,
    unreadable: states.filter((s) => s === 'none').length,
  };
}

/**
 * Which key opens each stored value, by location. Backups are read from disk,
 * so `includeFiles` can be turned off where that would be slow (startup).
 */
export async function encryptionStatus(includeFiles = true): Promise<LocationStatus[]> {
  const out: LocationStatus[] = [];
  for (const c of COLUMNS) {
    const rows = await columnRows(c);
    out.push(tally(c.label, rows.map((r) => ciphertextKeyState(r.value))));
  }
  const oidc = await oidcSecret();
  if (oidc) out.push(tally('SSO client secret', [ciphertextKeyState(oidc.value)]));
  const channelStates = (await alertChannels()).flatMap((ch) => sealedFields(ch.type, ch.config).map(([, c]) => ciphertextKeyState(c)));
  out.push(tally('Alert channel secrets', channelStates));
  const hookStates = (await webhookSecrets()).map((w) => sealedCiphertext(w.secret)).filter((c): c is string => !!c).map(ciphertextKeyState);
  out.push(tally('Webhook signing secrets', hookStates));
  if (includeFiles) {
    const states: Array<'current' | 'old' | 'none'> = [];
    for (const b of await encryptedBackups()) {
      try {
        states.push(ciphertextKeyState(fs.readFileSync(b.file_path, 'utf8').trim()));
      } catch {
        states.push('none'); // missing or unreadable file
      }
    }
    out.push(tally('Encrypted backups', states));
  }
  return out.filter((l) => l.current + l.old + l.unreadable > 0);
}

export interface ReencryptResult {
  rewritten: number;
  unreadable: number;
}

/** Re-encrypt every value still under an older key. Values no key opens are counted, not touched. */
export async function reencryptAll(): Promise<ReencryptResult> {
  let rewritten = 0;
  let unreadable = 0;

  for (const c of COLUMNS) {
    for (const row of await columnRows(c)) {
      const state = ciphertextKeyState(row.value);
      if (state === 'none') { unreadable++; continue; }
      if (state === 'current') continue;
      await query(`UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.id} = $2`, [encrypt(decrypt(row.value)), row.id]);
      rewritten++;
    }
  }

  const oidc = await oidcSecret();
  if (oidc) {
    const state = ciphertextKeyState(oidc.value);
    if (state === 'none') unreadable++;
    else if (state === 'old') {
      const config = { ...oidc.config, client_secret_encrypted: encrypt(decrypt(oidc.value)) };
      await query(`UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = $2`, [config, OIDC_KEY]);
      rewritten++;
    }
  }

  for (const ch of await alertChannels()) {
    const replaced = new Map<string, string>();
    for (const [key, c] of sealedFields(ch.type, ch.config)) {
      const state = ciphertextKeyState(c);
      if (state === 'none') { unreadable++; continue; }
      if (state === 'current') continue;
      replaced.set(key, SEALED_PREFIX + encrypt(decrypt(c)));
      rewritten++;
    }
    if (replaced.size > 0) {
      const config = Object.fromEntries(Object.entries(ch.config).map(([k, v]) => [k, replaced.get(k) ?? v]));
      await query(`UPDATE alert_channels SET config = $1 WHERE id = $2`, [JSON.stringify(config), ch.id]);
    }
  }

  for (const w of await webhookSecrets()) {
    const c = sealedCiphertext(w.secret);
    if (!c) continue;
    const state = ciphertextKeyState(c);
    if (state === 'none') { unreadable++; continue; }
    if (state === 'current') continue;
    await query(`UPDATE webhooks SET secret = $1 WHERE id = $2`, [SEALED_PREFIX + encrypt(decrypt(c)), w.id]);
    rewritten++;
  }

  for (const b of await encryptedBackups()) {
    let content: string;
    try {
      content = fs.readFileSync(b.file_path, 'utf8').trim();
    } catch {
      unreadable++;
      continue;
    }
    const state = ciphertextKeyState(content);
    if (state === 'none') { unreadable++; continue; }
    if (state === 'current') continue;
    // Write beside the original and rename over it, so a crash never leaves a half-written backup.
    const tmp = `${b.file_path}.reencrypt`;
    fs.writeFileSync(tmp, encrypt(decrypt(content)), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, b.file_path);
    rewritten++;
  }

  if (rewritten > 0) console.log(`[secrets] re-encrypted ${rewritten} stored value(s) under the current key`);
  if (unreadable > 0) console.error(`[secrets] ${unreadable} stored value(s) can't be decrypted with any known key`);
  return { rewritten, unreadable };
}

/** Stored values no known key opens, from the database only (quick enough for startup). */
export async function countUnreadable(): Promise<number> {
  const status = await encryptionStatus(false);
  return status.reduce((n, l) => n + l.unreadable, 0);
}
