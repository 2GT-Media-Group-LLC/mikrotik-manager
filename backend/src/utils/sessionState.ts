/**
 * Is a signed session still allowed? (outside review P2-1)
 *
 * A session token used to be trusted for its whole 24 hours: a deleted,
 * demoted or password-reset user kept full access, including to create another
 * admin, and logging out only threw away the browser's copy. Now every use of a
 * session checks the account as it is:
 *
 *   - the account must still exist;
 *   - the token's session version must match the account's. It goes up when the
 *     role or password changes, which ends every session issued before;
 *   - the role and default-password flag come from the account, not the token;
 *   - a token revoked by logging out is refused until it would have expired.
 *
 * Accounts are cached for a few seconds, and the cache entry is dropped the
 * moment the account changes, so revocation is immediate on this server.
 */
import { query, queryOne } from '../config/database';
import { redis } from '../config/redis';
import type { AuthPayload } from '../middleware/auth';

interface SessionAccount {
  username: string;
  role: string;
  sessionVersion: number;
  mustChangePassword: boolean;
  /** Per-site roles (P1-7); null for a fleet-wide account. */
  siteRoles: Record<number, string> | null;
}

const CACHE_MS = 10_000;
const REDIS_TIMEOUT_MS = 1_500;
const cache = new Map<number, { at: number; account: SessionAccount | null }>();

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis timeout')), REDIS_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function loadAccount(userId: number): Promise<SessionAccount | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.account;
  const row = await queryOne<{ username: string; role: string; session_version: number; must_change_password: boolean }>(
    `SELECT username, role, session_version, must_change_password FROM users WHERE id = $1`, [userId]);
  let siteRoles: Record<number, string> | null = null;
  if (row) {
    const sites = await query<{ site_id: number; role: string }>(
      `SELECT site_id, role FROM user_site_roles WHERE user_id = $1`, [userId]);
    if (sites.length > 0) siteRoles = Object.fromEntries(sites.map((r) => [r.site_id, r.role]));
  }
  const account = row
    ? { username: row.username, role: row.role, sessionVersion: row.session_version ?? 0, mustChangePassword: !!row.must_change_password, siteRoles }
    : null;
  cache.set(userId, { at: Date.now(), account });
  return account;
}

/** Forget a cached account, e.g. after it was deleted. */
export function forgetSessionAccount(userId: number): void {
  cache.delete(userId);
}

/** End every session the account has; the next request with one is refused. */
export async function endAllSessions(userId: number): Promise<number> {
  const row = await queryOne<{ session_version: number }>(
    `UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version`, [userId]);
  cache.delete(userId);
  return row?.session_version ?? 0;
}

/** The account's current session version, to put in a new session token. */
export async function currentSessionVersion(userId: number): Promise<number> {
  const rows = await query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]);
  return rows[0]?.session_version ?? 0;
}

const revokedKey = (jti: string): string => `auth:revoked:${jti}`;

/** Revoke one session token (logout) until it would have expired anyway. */
export async function revokeSessionToken(payload: AuthPayload): Promise<void> {
  if (!payload.jti) return; // issued before tokens carried an id; it expires by itself
  const ttl = payload.exp ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : 24 * 3600;
  await withTimeout(redis.set(revokedKey(payload.jti), '1', 'EX', ttl)).catch(() => {});
}

async function isRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  // If Redis can't answer, a logged-out token is not refused; the account
  // checks above still apply. Failing closed would log everyone out.
  return (await withTimeout(redis.exists(revokedKey(jti))).catch(() => 0)) === 1;
}

/**
 * The session as the account stands now, or null if it must be refused.
 * API tokens are not sessions and pass through unchanged.
 */
export async function validateSession(payload: AuthPayload): Promise<AuthPayload | null> {
  if (payload.tokenAuth) return payload;
  const account = await loadAccount(payload.userId);
  if (!account) return null;
  if ((payload.sv ?? 0) !== account.sessionVersion) return null;
  if (await isRevoked(payload.jti)) return null;
  const current: AuthPayload = { ...payload, username: account.username, role: account.role };
  if (account.mustChangePassword) current.mustChangePassword = true;
  else delete current.mustChangePassword;
  if (account.siteRoles) current.siteRoles = account.siteRoles;
  else delete current.siteRoles;
  return current;
}
