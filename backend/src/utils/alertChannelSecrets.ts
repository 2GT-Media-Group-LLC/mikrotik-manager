/**
 * Secrets in alert channel settings: which fields are masked in responses, how
 * an update that sends the mask back keeps the saved value, and (outside
 * review S7) how they are stored encrypted and opened only to send.
 */
import { isSealed, seal, unseal } from './sealed';

export const SENSITIVE_KEYS: Record<string, string[]> = {
  email:    ['smtp_pass'],
  // For Slack and Discord the incoming-webhook URL is itself the credential:
  // anyone holding it can post into that channel.
  slack:    ['webhook_url'],
  discord:  ['webhook_url'],
  telegram: ['bot_token'],
  // ntfy accepts either an access token or basic auth; both are secrets.
  ntfy:     ['token', 'password'],
  gotify:   ['app_token'],
};

export function maskConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (masked[key]) masked[key] = '••••••••';
  }
  return masked;
}

/**
 * Where each channel type delivers to. A saved secret is only ever sent to the
 * destination it was saved with: if one of these changes, the secret must be
 * typed again. Otherwise anyone who could edit a channel could point it at a
 * server they run, keep the masked token, press Test, and receive the token.
 */
const DESTINATION_KEYS: Record<string, string[]> = {
  email:  ['smtp_host', 'smtp_port'],
  ntfy:   ['server_url'],
  gotify: ['server_url'],
};

/**
 * When updating, a sensitive field sent back as the mask placeholder keeps its
 * saved value, unless the destination changed (see DESTINATION_KEYS).
 */
export function mergeConfig(
  type: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): { merged: Record<string, unknown> } | { error: string } {
  const merged = { ...existing, ...incoming };
  const destinationChanged = (DESTINATION_KEYS[type] ?? []).some(
    (k) => k in incoming && String(incoming[k] ?? '') !== String(existing[k] ?? '')
  );
  for (const key of SENSITIVE_KEYS[type] ?? []) {
    if (incoming[key] === '••••••••') {
      if (destinationChanged && existing[key]) {
        return { error: 'The server changed, so re-enter the password or token. A saved secret is only sent to the server it was saved for.' };
      }
      merged[key] = existing[key]; // restore original
    }
  }
  return { merged };
}


const SENSITIVE = new Map(Object.entries(SENSITIVE_KEYS));

/** The secret field names for a channel type. */
export function sensitiveKeys(type: string): Set<string> {
  return new Set(SENSITIVE.get(type) ?? []);
}

/** Encrypt the secret fields of a channel's settings for storage (S7). */
export function sealConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const keys = sensitiveKeys(type);
  return Object.fromEntries(Object.entries(config).map(([k, v]) =>
    [k, keys.has(k) && typeof v === 'string' && v && !isSealed(v) ? seal(v) : v]));
}

/**
 * The settings with their secrets decrypted, for sending only. A secret that
 * can't be decrypted (lost key) is left out, so the send fails on its own
 * rather than with ciphertext as the password.
 */
export function openConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const keys = sensitiveKeys(type);
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(config)) {
    if (!keys.has(k) || !isSealed(v)) { out.push([k, v]); continue; }
    try { out.push([k, unseal(v)]); } catch { /* left out */ }
  }
  return Object.fromEntries(out);
}

/** True when a channel's settings still hold a plaintext secret. */
export function hasPlaintextSecret(type: string, config: Record<string, unknown>): boolean {
  const keys = sensitiveKeys(type);
  return Object.entries(config).some(([k, v]) => keys.has(k) && typeof v === 'string' && !!v && !isSealed(v));
}
