/**
 * Secret values for commands (#259): `{{secret:name}}` in a bulk command, a
 * template or a rollout's post-upgrade commands, filled in on the server just
 * before the command goes to the device.
 *
 * The point is that a password in a command (creating a dedicated user for
 * the manager, say) never shows: not in the template, the run's stored
 * command, its history, its output or the manager's logs. The value is stored
 * encrypted, never returned by the API, and masked if a device echoes it.
 *
 * Only fleet admins may run commands that use secrets: a command can print a
 * value in pieces, which masking can't catch, so whoever writes the command
 * has to be someone who could see the secret anyway.
 */
import { randomBytes } from 'crypto';
import { query } from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';

export const SECRET_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_REF = /\{\{\s*secret:([A-Za-z0-9_-]{1,64})\s*\}\}/g;
export const MASK = '••••';

/** The secret names a command refers to, in order, without repeats. */
export function secretNames(command: string): string[] {
  return [...new Set([...command.matchAll(SECRET_REF)].map((m) => m[1]))];
}

/** Names a command uses that don't exist. */
export async function missingSecrets(command: string): Promise<string[]> {
  const names = secretNames(command);
  if (!names.length) return [];
  const rows = await query<{ name: string }>(`SELECT name FROM command_secrets WHERE name = ANY($1::text[])`, [names]);
  const have = new Set(rows.map((r) => r.name));
  return names.filter((n) => !have.has(n));
}

/**
 * The command with its secrets filled in, and the values, for masking what
 * comes back. Throws when one no longer exists, so a command never runs with
 * a placeholder in place of a password.
 */
export async function fillSecrets(command: string): Promise<{ text: string; values: string[] }> {
  const names = secretNames(command);
  if (!names.length) return { text: command, values: [] };
  const rows = await query<{ name: string; value_encrypted: string }>(
    `SELECT name, value_encrypted FROM command_secrets WHERE name = ANY($1::text[])`, [names]);
  const byName = new Map(rows.map((r) => [r.name, decrypt(r.value_encrypted)]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`Secret${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}`);
  const text = command.replace(SECRET_REF, (_m, n: string) => byName.get(n)!);
  return { text, values: [...byName.values()].filter((v) => v.length > 0) };
}

/** Text with any secret value replaced by the mask, longest first. */
export function maskSecrets(text: string | null | undefined, values: string[]): string | null {
  if (text == null) return null;
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join(MASK);
  return out;
}

/** A random value for "generate", from characters RouterOS takes in a quoted string. */
export function generateSecret(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function listSecrets() {
  return query<{ id: number; name: string; created_by: string | null; updated_at: string }>(
    `SELECT id, name, created_by, updated_at FROM command_secrets ORDER BY name`);
}

export async function saveSecret(name: string, value: string, user: string | null): Promise<void> {
  await query(
    `INSERT INTO command_secrets (name, value_encrypted, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()`,
    [name, encrypt(value), user]);
}
