/**
 * Secrets kept inside otherwise readable settings, encrypted with the same key
 * as device passwords (outside review S7). A sealed value is the ciphertext
 * with a marker, so plaintext saved before this existed is recognised and
 * sealed at startup, and a sealed value is never sealed twice.
 */
import { decrypt, encrypt } from './crypto';

export const SEALED_PREFIX = 'enc:';

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(SEALED_PREFIX);
}

/** Seal a plaintext secret; empty and already-sealed values are returned as they are. */
export function seal(v: string): string {
  return !v || isSealed(v) ? v : SEALED_PREFIX + encrypt(v);
}

/** The plaintext of a sealed value; plaintext (not yet sealed) passes through. */
export function unseal(v: string): string {
  return isSealed(v) ? decrypt(v.slice(SEALED_PREFIX.length)) : v;
}

/** The ciphertext inside a sealed value, for key-rotation bookkeeping. */
export function sealedCiphertext(v: string): string | null {
  return isSealed(v) ? v.slice(SEALED_PREFIX.length) : null;
}
