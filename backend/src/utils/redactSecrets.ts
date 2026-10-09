import type { Request, Response, NextFunction } from 'express';

/**
 * Keep device secrets away from read-only accounts.
 *
 * Several pages read live device configuration, and RouterOS returns secrets
 * in it: Wi-Fi passphrases, WireGuard private keys, SNMP communities, hotspot
 * user passwords. Viewers and read-scope API tokens have no use for them (they
 * cannot edit anything), and everywhere else the product treats secrets as
 * privileged, so they are masked before the response leaves the server.
 *
 * Operators and admins still receive them, because the edit forms show and
 * resend the current values.
 */

export const SECRET_MASK = '••••••••';

/** Attribute names that hold a secret, in RouterOS form and in our own. */
const SECRET_KEYS = new Set([
  // Wi-Fi (wifi package, legacy wireless profiles, synthesised profiles)
  'passphrase', 'security.passphrase',
  'wpa-pre-shared-key', 'wpa2-pre-shared-key',
  'static-key-0', 'static-key-1', 'static-key-2', 'static-key-3',
  'static-sta-private-key', 'management-protection-key',
  // WireGuard
  'private-key', 'preshared-key',
  // Hotspot users, RADIUS, SNMPv3
  'password', 'secret', 'authentication-password', 'encryption-password',
  // SNMP v1/v2c: the community name is the credential
  'community_name',
]);

/**
 * Values that are flags rather than secrets. `/certificate/print` reports
 * `private-key=true` meaning "a key is present", which is fine to show.
 */
const NOT_SECRET = new Set(['', 'true', 'false', 'yes', 'no']);

/** Does this attribute name hold a secret (a passphrase, key or password)? */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

export function canSeeDeviceSecrets(user?: { role?: string }): boolean {
  return user?.role === 'admin' || user?.role === 'operator';
}

/** A copy of `value` with every secret-named string field masked, at any depth. */
export function maskSecrets<T>(value: T): T {
  return mask(value, 0) as T;
}

function mask(value: unknown, depth: number): unknown {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === 'string' && !NOT_SECRET.has(v)
      ? SECRET_MASK
      : mask(v, depth + 1);
  }
  return out;
}

/**
 * Router middleware: for anyone who may not see device secrets, mask them in
 * every JSON response the router sends. Mount it after requireAuth.
 */
export function maskSecretsForReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (canSeeDeviceSecrets(req.user)) return next();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => send(maskSecrets(body))) as Response['json'];
  next();
}
