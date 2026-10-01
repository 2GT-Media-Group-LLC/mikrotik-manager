/**
 * Self-healing secret management for JWT signing and credential encryption.
 *
 * Goal: a deployment must never break on upgrade or require a manual migration.
 *  - If JWT_SECRET / ENCRYPTION_KEY are set to strong values in the environment,
 *    those win (operator stays in control).
 *  - Otherwise (unset or a well-known repo default), we auto-generate a strong
 *    secret ONCE and persist it to a file on a durable volume, reusing it on
 *    every subsequent boot so it's stable (no session/credential churn).
 *  - Old data keeps working: decryption tries the current key plus every legacy
 *    key (including the old built-in defaults), and JWTs verify against the
 *    current secret plus any prior *strong* secret. The public defaults are
 *    never accepted as a JWT verifier — that would keep the forgery hole open.
 *
 * Secrets live outside the database (in SECRETS_DIR) so a DB dump alone can't
 * reveal the key that protects the credentials stored in it.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Publicly known defaults shipped in this repo / compose files.
// The .env.example value is listed exactly: it is over 32 characters, so
// before it was listed a quick-start install signed sessions with a string
// anyone can read in the repo. Anything else starting "changeme" is treated as
// an unedited placeholder too.
const KNOWN_DEFAULT_JWT = [
  'changeme',
  'changeme_use_a_long_random_secret',
  'changeme_use_a_long_random_secret_at_least_32_chars',
];
const KNOWN_DEFAULT_ENC = ['defaultkey32byteslongencryptkey!', 'changeme32byteslongencryptionkey'];

interface PersistedSecrets {
  jwtSecret?: string;
  encryptionKey?: string;
  prevJwtSecrets?: string[];
  prevEncryptionKeys?: string[];
  /**
   * Secrets superseded by a JWT_SECRET set in the environment, accepted only
   * until `until` so sessions signed with them run out instead of being cut
   * off (outside review S8).
   */
  retiringJwtSecrets?: { secret: string; until: string }[];
}

/** How long a superseded JWT secret keeps verifying: the session lifetime. */
const JWT_RETIRE_MS = 24 * 3600 * 1000;

export interface SecretsInfo {
  jwtSource: 'env' | 'persisted' | 'generated';
  encSource: 'env' | 'persisted' | 'generated';
  persisted: boolean;
  /** True if a secret was generated but could NOT be persisted (won't survive restart). */
  ephemeral: boolean;
  /** JWT_SECRET is set in the environment but is a public placeholder, so it was ignored. */
  envJwtIgnored: boolean;
}

interface ResolvedSecrets {
  jwtCurrent: string;
  jwtVerifiers: string[];
  /** Superseded secrets and when they stop verifying (S8). */
  jwtRetiring: { secret: string; until: number }[];
  encCurrent: Buffer;
  encDecryptors: Buffer[];
  /** The current key as configured, kept so a rotation can move it to history. */
  encMaterial: string;
  /**
   * A key was generated this boot and is not saved yet: it is saved only once
   * startup confirms no stored data needs a key that is missing (P2-29).
   */
  encPendingSave: boolean;
  info: SecretsInfo;
}

/** Set at startup when stored credentials exist that no known key decrypts. */
let encryptionKeyLost = false;

let resolved: ResolvedSecrets | null = null;

function isPlaceholderJwt(v: string): boolean {
  return KNOWN_DEFAULT_JWT.includes(v) || /^changeme/i.test(v);
}

function isStrongJwt(v: string | undefined): v is string {
  return !!v && !isPlaceholderJwt(v) && v.length >= 32;
}

function deriveKey(material: string): Buffer {
  return material.length === 32
    ? Buffer.from(material, 'utf8')
    : crypto.createHash('sha256').update(material).digest();
}

function dedupeKeys(materials: string[]): Buffer[] {
  const seen = new Set<string>();
  const out: Buffer[] = [];
  for (const m of materials) {
    if (!m) continue;
    const key = deriveKey(m);
    const h = key.toString('hex');
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(key);
  }
  return out;
}

function secretsDir(): string {
  return process.env.SECRETS_DIR || '/app/data';
}

function secretsFile(): string {
  return path.join(secretsDir(), 'secrets.json');
}

function loadPersisted(): PersistedSecrets {
  try {
    const raw = fs.readFileSync(secretsFile(), 'utf8');
    return JSON.parse(raw) as PersistedSecrets;
  } catch {
    return {};
  }
}

/** Persist secrets with owner-only permissions. Returns whether it succeeded. */
function savePersisted(p: PersistedSecrets): boolean {
  try {
    const dir = secretsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = secretsFile();
    fs.writeFileSync(file, JSON.stringify(p, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

export function initSecrets(): SecretsInfo {
  if (resolved) return resolved.info;

  const persisted = loadPersisted();
  const history: PersistedSecrets = {
    prevJwtSecrets: persisted.prevJwtSecrets ? [...persisted.prevJwtSecrets] : [],
    prevEncryptionKeys: persisted.prevEncryptionKeys ? [...persisted.prevEncryptionKeys] : [],
  };

  // ── JWT secret ──────────────────────────────────────────────────────────────
  const envJwt = process.env.JWT_SECRET;
  let jwtCurrent: string;
  let jwtSource: SecretsInfo['jwtSource'];
  let generatedJwt = false;
  if (isStrongJwt(envJwt)) {
    jwtCurrent = envJwt;
    jwtSource = 'env';
  } else if (persisted.jwtSecret) {
    jwtCurrent = persisted.jwtSecret;
    jwtSource = 'persisted';
  } else {
    jwtCurrent = crypto.randomBytes(48).toString('base64url');
    jwtSource = 'generated';
    generatedJwt = true;
  }
  // Verifiers: current + any prior *strong* secrets (never the public defaults).
  //
  // A JWT_SECRET set in the environment is a rotation (outside review S8).
  // Setting one after secrets.json leaked used to leave the leaked secret a
  // verifier for good, so tokens forged with it kept working. Now every older
  // secret is retiring: accepted for one session lifetime from the moment the
  // new secret was first seen, then dropped, and removed from the file so that
  // unsetting JWT_SECRET later can't bring it back.
  const now = Date.now();
  let jwtVerifiers: string[];
  let jwtRetiring: { secret: string; until: number }[] = [];
  let jwtFileChanged = false;
  if (jwtSource === 'env') {
    const retiring = new Map<string, number>();
    for (const r of persisted.retiringJwtSecrets || []) {
      const until = Date.parse(r.until);
      if (r.secret !== jwtCurrent && isStrongJwt(r.secret) && until > now) retiring.set(r.secret, until);
    }
    for (const old of [persisted.jwtSecret, ...(history.prevJwtSecrets || [])]) {
      if (old && old !== jwtCurrent && isStrongJwt(old) && !retiring.has(old)) retiring.set(old, now + JWT_RETIRE_MS);
    }
    jwtRetiring = [...retiring].map(([secret, until]) => ({ secret, until }));
    jwtVerifiers = [jwtCurrent];
    jwtFileChanged = !!persisted.jwtSecret || (history.prevJwtSecrets || []).length > 0
      || (persisted.retiringJwtSecrets || []).length !== jwtRetiring.length;
  } else {
    jwtVerifiers = [
      jwtCurrent,
      ...(persisted.jwtSecret ? [persisted.jwtSecret] : []),
      ...(history.prevJwtSecrets || []),
    ].filter((v, i, a) => isStrongJwt(v) && a.indexOf(v) === i);
  }

  // ── Encryption key ──────────────────────────────────────────────────────────
  const envEnc = process.env.ENCRYPTION_KEY;
  let encMaterial: string;
  let encSource: SecretsInfo['encSource'];
  let generatedEnc = false;
  if (envEnc && !KNOWN_DEFAULT_ENC.includes(envEnc)) {
    encMaterial = envEnc;
    encSource = 'env';
  } else if (persisted.encryptionKey) {
    encMaterial = persisted.encryptionKey;
    encSource = 'persisted';
  } else {
    encMaterial = crypto.randomBytes(16).toString('hex'); // 32 chars, used verbatim
    encSource = 'generated';
    generatedEnc = true;
  }
  // Decryptors: current + prior keys + the known defaults, so any legacy
  // ciphertext still decrypts. Legacy defaults for decrypt-only are safe.
  // ENCRYPTION_KEY_PREVIOUS carries the outgoing key when an operator changes
  // ENCRYPTION_KEY in .env: an env key is never written to disk, so without it
  // the old key was simply gone (outside review P2-29).
  const envPrevious = (process.env.ENCRYPTION_KEY_PREVIOUS || '')
    .split(',').map((k) => k.trim()).filter(Boolean);
  const encDecryptors = dedupeKeys([
    encMaterial,
    ...(persisted.encryptionKey ? [persisted.encryptionKey] : []),
    ...(history.prevEncryptionKeys || []),
    ...envPrevious,
    ...KNOWN_DEFAULT_ENC,
  ]);

  // ── Persist auto-managed secrets so they're stable across restarts ───────────
  let persistedOk = true;
  if (jwtFileChanged && !generatedEnc) {
    // The env secret took over: drop the old JWT secrets from the file and
    // keep only the retiring list (S8). The env secret itself is never written.
    persistedOk = savePersisted({
      ...persisted,
      jwtSecret: undefined,
      prevJwtSecrets: [],
      retiringJwtSecrets: jwtRetiring.map((r) => ({ secret: r.secret, until: new Date(r.until).toISOString() })),
    });
  }
  if (generatedJwt || generatedEnc) {
    // Record any superseded auto-managed secret in history for continuity.
    if (persisted.jwtSecret && persisted.jwtSecret !== jwtCurrent && isStrongJwt(persisted.jwtSecret)) {
      history.prevJwtSecrets = [...new Set([...(history.prevJwtSecrets || []), persisted.jwtSecret])];
    }
    if (persisted.encryptionKey && persisted.encryptionKey !== encMaterial) {
      history.prevEncryptionKeys = [...new Set([...(history.prevEncryptionKeys || []), persisted.encryptionKey])];
    }
    const toSave: PersistedSecrets = {
      // Only store secrets we manage ourselves — never write an env-provided
      // secret to disk. Under an env secret, older ones are only retiring (S8).
      jwtSecret: jwtSource === 'env' ? undefined : jwtCurrent,
      // A generated encryption key waits for confirmEncryptionKey(): saving it
      // straight away made a lost key permanent, because new credentials were
      // then written under a key the old data can never be read with.
      encryptionKey: encSource === 'env' || generatedEnc ? persisted.encryptionKey : encMaterial,
      prevJwtSecrets: jwtSource === 'env' ? [] : history.prevJwtSecrets,
      prevEncryptionKeys: history.prevEncryptionKeys,
      retiringJwtSecrets: jwtSource === 'env'
        ? jwtRetiring.map((r) => ({ secret: r.secret, until: new Date(r.until).toISOString() }))
        : persisted.retiringJwtSecrets,
    };
    persistedOk = savePersisted(toSave);
  }

  const info: SecretsInfo = {
    jwtSource,
    encSource,
    persisted: persistedOk,
    ephemeral: (generatedJwt || generatedEnc) && !persistedOk,
    envJwtIgnored: !!envJwt && !isStrongJwt(envJwt),
  };

  resolved = {
    jwtCurrent,
    jwtVerifiers,
    jwtRetiring,
    encCurrent: deriveKey(encMaterial),
    encDecryptors,
    encMaterial,
    encPendingSave: generatedEnc,
    info,
  };
  return info;
}

/**
 * Called once the database is up. A key generated this boot is saved only if
 * nothing stored needs a different key. If encrypted data exists that no
 * known key opens, the key was lost (secrets.json deleted, app_data not moved
 * with the database, ENCRYPTION_KEY changed without ENCRYPTION_KEY_PREVIOUS):
 * the generated key is not saved, and saving new credentials is refused, so
 * restoring the original key still recovers everything (P2-29).
 */
export function confirmEncryptionKey(unreadableStoredValues: number): { saved: boolean; lost: boolean } {
  const r = ensure();
  if (unreadableStoredValues > 0) {
    encryptionKeyLost = true;
    return { saved: false, lost: true };
  }
  encryptionKeyLost = false;
  if (!r.encPendingSave) return { saved: false, lost: false };
  const p = loadPersisted();
  const ok = savePersisted({ ...p, encryptionKey: r.encMaterial });
  if (ok) r.encPendingSave = false;
  r.info.persisted = ok;
  r.info.ephemeral = !ok;
  return { saved: ok, lost: false };
}

/** True when stored credentials exist that no known key can decrypt. */
export function encryptionKeyMissing(): boolean {
  return encryptionKeyLost;
}

/** For the Settings page: where the key comes from and how many older keys are kept. */
export function encryptionKeyInfo(): {
  source: SecretsInfo['encSource']; keyId: string; savedPreviousKeys: number; envPreviousKeys: number;
} {
  const r = ensure();
  const envPrevious = (process.env.ENCRYPTION_KEY_PREVIOUS || '').split(',').map((k) => k.trim()).filter(Boolean);
  return {
    source: r.info.encSource,
    keyId: keyId(r.encCurrent),
    savedPreviousKeys: (loadPersisted().prevEncryptionKeys || []).length,
    envPreviousKeys: envPrevious.length,
  };
}

/** A short, non-secret identifier for a key, to tell keys apart in the UI. */
export function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * Switch to a newly generated key. The outgoing key is written to the history
 * in secrets.json first, and nothing changes if that write fails, so no
 * ciphertext is ever left without a key. Callers then re-encrypt stored data.
 * Only for a key the manager manages; one set in .env is rotated there.
 */
export function rotateEncryptionKey(): { keyId: string } {
  const r = ensure();
  if (r.info.encSource === 'env') {
    throw new Error('The encryption key is set by ENCRYPTION_KEY in .env. Rotate it there, with ENCRYPTION_KEY_PREVIOUS.');
  }
  if (encryptionKeyLost) throw new Error('The encryption key is missing; restore it before rotating.');
  const next = crypto.randomBytes(16).toString('hex');
  const p = loadPersisted();
  const history = [...new Set([...(p.prevEncryptionKeys || []), r.encMaterial])];
  if (!savePersisted({ ...p, encryptionKey: next, prevEncryptionKeys: history })) {
    throw new Error('Could not write the new key to secrets.json, so the key was not changed.');
  }
  const newKey = deriveKey(next);
  // The old current key stays a decryptor, behind the new one.
  r.encDecryptors = [newKey, ...r.encDecryptors.filter((k) => !k.equals(newKey))];
  r.encMaterial = next;
  r.encCurrent = newKey;
  r.encPendingSave = false;
  r.info.encSource = 'persisted';
  return { keyId: keyId(r.encCurrent) };
}

/**
 * Forget every key but the current one. Callers must first confirm nothing
 * stored still needs an older key; ENCRYPTION_KEY_PREVIOUS stays in use until
 * it is removed from .env.
 */
export function retireOldEncryptionKeys(): number {
  const r = ensure();
  const p = loadPersisted();
  const dropped = (p.prevEncryptionKeys || []).length;
  if (dropped > 0 && !savePersisted({ ...p, prevEncryptionKeys: [] })) {
    throw new Error('Could not update secrets.json.');
  }
  const envPrevious = (process.env.ENCRYPTION_KEY_PREVIOUS || '').split(',').map((k) => k.trim()).filter(Boolean);
  r.encDecryptors = dedupeKeys([r.encMaterial, ...envPrevious]);
  return dropped;
}

function ensure(): ResolvedSecrets {
  if (!resolved) initSecrets();
  return resolved!;
}

/** Current secret used to SIGN new JWTs. */
export function jwtSigningSecret(): string {
  return ensure().jwtCurrent;
}

/** Secrets a JWT may be verified against (current + prior strong secrets). */
export function jwtVerifierSecrets(): string[] {
  const r = ensure();
  // Retiring secrets stop verifying at their deadline, restart or not (S8).
  const now = Date.now();
  return [...r.jwtVerifiers, ...r.jwtRetiring.filter((x) => x.until > now).map((x) => x.secret)];
}

/** Current key used to ENCRYPT new data. */
export function encryptionKey(): Buffer {
  return ensure().encCurrent;
}

/** All keys a ciphertext may be decrypted with (current + legacy). */
export function decryptionKeys(): Buffer[] {
  return ensure().encDecryptors;
}

export function getSecretsInfo(): SecretsInfo {
  return ensure().info;
}

/** Test seam: forget resolved secrets so the next call re-reads env/disk. */
export function _resetSecretsForTest(): void {
  resolved = null;
}
