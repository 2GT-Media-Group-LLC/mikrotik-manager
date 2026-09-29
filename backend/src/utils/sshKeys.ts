/**
 * Per-device SSH keypairs: generation, fingerprints, and the naming that ties a
 * key on the manager to a key on the device.
 *
 * Keys are per device rather than per fleet. A shared key turns any single
 * compromise into fleet-wide compromise, and makes rotating one device
 * impossible without touching every other one — the blast radius should match
 * the thing that failed (#110).
 */
import * as crypto from 'crypto';
import { utils as sshUtils } from 'ssh2';
import { compareRosVersions, parseRosVersion } from './rosVersion';

export type SshKeyType = 'ed25519' | 'rsa';

export interface GeneratedKeyPair {
  keyType: SshKeyType;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  /** The comment RouterOS will show as key-owner; unique per key. */
  comment: string;
}

/**
 * Comment embedded in the public key, and the filename used on the device.
 *
 * Both carry the device id so an operator reading `/user/ssh-keys/print` on the
 * hardware can tell which manager entry a key belongs to. A key nobody can
 * attribute is a key nobody dares remove.
 */
export function keyComment(deviceId: number, suffix?: string): string {
  const base = `mikrotik-manager-device-${deviceId}`;
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * A short, unique tag per generated key.
 *
 * Every key for a device once shared one comment, and RouterOS matches on it —
 * so removing "the old key" during a rotation removed the new one too, taking
 * SSH access with it. Comments must identify a *key*, not a device.
 */
export function newKeySuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function keyFileName(deviceId: number): string {
  return `mm-device-${deviceId}.pub`;
}

/** OpenSSH-style SHA256 fingerprint of a public key, for display and audit. */
export function fingerprintPublicKey(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const b64 = parts.length > 1 ? parts[1] : parts[0];
  const hash = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

/** RouterOS accepts Ed25519 user keys from this release on. */
export const ED25519_MIN_ROS = '7.12';

/**
 * The key type a device can authenticate with.
 *
 * RouterOS only accepts Ed25519 user keys from 7.12. Older releases, including
 * all of v6, import an Ed25519 key without complaint and then refuse to log in
 * with it, which is what a v6.49 user saw: "installed but would not
 * authenticate". RSA works on every release, so it is used for anything older
 * than 7.12 and for a device whose version isn't known yet.
 */
export function keyTypeForVersion(rosVersion: string | null | undefined): SshKeyType {
  if (!parseRosVersion(rosVersion)) return 'rsa';
  return compareRosVersions(rosVersion, ED25519_MIN_ROS) >= 0 ? 'ed25519' : 'rsa';
}

/**
 * Why RouterOS refused `/user ssh-keys import`, or null if it didn't.
 *
 * The command exits 0 either way; the only signal is what it prints. That
 * includes the CLI's own parse errors ("expected command name", "syntax
 * error"), which are easy to miss: RouterOS 6 answered the v7-style
 * `/user/ssh-keys/import` with one, the old check did not recognise it, and a
 * key that was never imported was reported as installed.
 */
export function importRejection(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  return /failure|error|no such|expected|bad command|invalid|does not match|not allowed|denied/i.test(text)
    ? text.slice(0, 200)
    : null;
}

/**
 * Generate a keypair for one device: Ed25519 where the device supports it
 * (shorter and faster), RSA otherwise (see keyTypeForVersion). The private
 * half never leaves the manager and is never returned by the API.
 */
export function generateDeviceKeyPair(
  deviceId: number, suffix = newKeySuffix(), keyType: SshKeyType = 'ed25519'
): GeneratedKeyPair {
  const comment = keyComment(deviceId, suffix);
  const kp = keyType === 'rsa'
    ? sshUtils.generateKeyPairSync('rsa', { bits: 3072, comment })
    : sshUtils.generateKeyPairSync('ed25519', { comment });
  // generateKeyPairSync already appends the comment; appending it again produced
  // keys tagged twice, which is harmless but reads like a bug on the device.
  const generated = kp.public.trim();
  const publicKey = generated.endsWith(comment) ? generated : `${generated} ${comment}`;
  return {
    keyType,
    publicKey,
    privateKey: kp.private,
    fingerprint: fingerprintPublicKey(kp.public),
    comment,
  };
}

/** Is this a private key ssh2 can actually authenticate with? */
export function isUsablePrivateKey(privateKey: string): boolean {
  const parsed = sshUtils.parseKey(privateKey);
  return !(parsed instanceof Error);
}

export type KeyStatus = 'pending' | 'deployed' | 'verified' | 'failed';

/**
 * Which credential should an SSH connection use?
 *
 * There is no password fallback once a key is installed. RouterOS binds a key to
 * a user and then refuses password authentication for that user entirely —
 * verified on hardware: removing the authorised key restored password login
 * immediately. So a verified key is not merely preferred, it is the only thing
 * that will work, and treating the password as a safety net would be fiction.
 *
 * The real recovery path is the binary API, which is unaffected by any of this
 * and can always remove the key.
 *
 * Only a *verified* key counts. One that was generated or pushed but never
 * authenticated is not evidence the device will accept it, and 'deployed' is a
 * transient state on the way to being proved. This function previously admitted
 * it, which disagreed with the resolver that actually ran -- the disagreement
 * went unnoticed because nothing outside these tests ever called this (#133).
 */
export function preferredAuth(
  status: KeyStatus | null,
  hasPrivateKey: boolean,
  hasPassword: boolean,
): 'key' | 'password' | 'none' {
  if (hasPrivateKey && status === 'verified') return 'key';
  if (hasPassword) return 'password';
  return 'none';
}
