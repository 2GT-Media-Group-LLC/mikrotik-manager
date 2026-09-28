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
}

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
  encCurrent: Buffer;
  encDecryptors: Buffer[];
  info: SecretsInfo;
}

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
  const jwtVerifiers = [
    jwtCurrent,
    ...(persisted.jwtSecret ? [persisted.jwtSecret] : []),
    ...(history.prevJwtSecrets || []),
  ].filter((v, i, a) => isStrongJwt(v) && a.indexOf(v) === i);

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
  const encDecryptors = dedupeKeys([
    encMaterial,
    ...(persisted.encryptionKey ? [persisted.encryptionKey] : []),
    ...(history.prevEncryptionKeys || []),
    ...KNOWN_DEFAULT_ENC,
  ]);

  // ── Persist auto-managed secrets so they're stable across restarts ───────────
  let persistedOk = true;
  if (generatedJwt || generatedEnc) {
    // Record any superseded auto-managed secret in history for continuity.
    if (persisted.jwtSecret && persisted.jwtSecret !== jwtCurrent && isStrongJwt(persisted.jwtSecret)) {
      history.prevJwtSecrets = [...new Set([...(history.prevJwtSecrets || []), persisted.jwtSecret])];
    }
    if (persisted.encryptionKey && persisted.encryptionKey !== encMaterial) {
      history.prevEncryptionKeys = [...new Set([...(history.prevEncryptionKeys || []), persisted.encryptionKey])];
    }
    const toSave: PersistedSecrets = {
      // Only store secrets we manage ourselves — never write an env-provided secret to disk.
      jwtSecret: jwtSource === 'env' ? persisted.jwtSecret : jwtCurrent,
      encryptionKey: encSource === 'env' ? persisted.encryptionKey : encMaterial,
      prevJwtSecrets: history.prevJwtSecrets,
      prevEncryptionKeys: history.prevEncryptionKeys,
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
    encCurrent: deriveKey(encMaterial),
    encDecryptors,
    info,
  };
  return info;
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
  return ensure().jwtVerifiers;
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
