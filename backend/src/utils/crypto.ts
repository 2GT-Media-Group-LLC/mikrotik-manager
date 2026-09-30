/**
 * AES-256-GCM helpers for encrypting device credentials at rest in PostgreSQL.
 *
 * Key material: set `ENCRYPTION_KEY` in the environment (see README). If unset,
 * a development-only default is used — production deployments must set a
 * strong secret. Key rotation / recovery is documented under README
 * "Credential encryption (ENCRYPTION_KEY)".
 */
import * as crypto from 'crypto';
import { encryptionKey, decryptionKeys, encryptionKeyMissing } from './secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export function encrypt(text: string): string {
  // Writing under a key that isn't the one the stored data needs would mix two
  // keys, and restoring the original would then lose the new values (P2-29).
  if (encryptionKeyMissing()) {
    throw new Error('The encryption key is missing, so new credentials cannot be saved. Restore the original key first (Settings → General → Encryption key).');
  }
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv:tag:encrypted (all hex)
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  // Try the current key first, then every legacy key, so ciphertext written
  // under an older (or default) key keeps decrypting after a key rotation.
  let lastErr: unknown;
  for (const key of decryptionKeys()) {
    try {
      return decryptWith(key, iv, tag, encrypted);
    } catch (e) {
      lastErr = e;
    }
  }
  // OpenSSL's own wording ("unable to authenticate data") means nothing to
  // someone looking at a failed poll.
  throw new Error(
    'A stored credential could not be decrypted with the current encryption key. ' +
    'See Settings → General → Encryption key.',
    { cause: lastErr },
  );
}

/** Which known key opens this ciphertext: 'current', 'old', or 'none'. */
export function ciphertextKeyState(encryptedText: string): 'current' | 'old' | 'none' {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return 'none';
  const [iv, tag, data] = parts.map((x) => Buffer.from(x, 'hex'));
  const current = encryptionKey();
  for (const key of decryptionKeys()) {
    try {
      decryptWith(key, iv, tag, data);
      return key.equals(current) ? 'current' : 'old';
    } catch { /* try the next */ }
  }
  return 'none';
}

/**
 * True if the ciphertext does NOT decrypt under the current key (i.e. it was
 * written with a legacy key and should be re-encrypted forward).
 */
export function needsReencryption(encryptedText: string): boolean {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return false;
  try {
    decryptWith(encryptionKey(), Buffer.from(parts[0], 'hex'), Buffer.from(parts[1], 'hex'), Buffer.from(parts[2], 'hex'));
    return false;
  } catch {
    return true;
  }
}
