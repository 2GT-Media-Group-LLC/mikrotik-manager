import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { query } from '../config/database';
import { jwtSigningSecret, jwtVerifierSecrets } from '../utils/secrets';
import { validateSession } from '../utils/sessionState';

export interface AuthPayload {
  userId: number;
  username: string;
  role: string;
  /** Set when the request authenticated with an API token instead of a session. */
  tokenAuth?: boolean;
  /**
   * The account still has the default password. The session can only reach
   * the endpoints needed to change it (PASSWORD_CHANGE_PATHS).
   */
  mustChangePassword?: boolean;
  /** The account's session version when this token was issued (P2-1). */
  sv?: number;
  /** Token id, so one session can be revoked by logging out. */
  jti?: string;
  /** Standard JWT times, present on a verified token. */
  exp?: number;
  iat?: number;
  /**
   * Per-site roles for a site-scoped account (P1-7), loaded from the account on
   * every request, never from the token. Absent for fleet-wide accounts. When
   * set, `role` is the role that applies to this request (see applySiteAccess).
   */
  siteRoles?: Record<number, string>;
}

/** All a must-change-password session may call. */
const PASSWORD_CHANGE_PATHS = new Set([
  '/api/auth/me', '/api/auth/password', '/api/auth/logout', '/api/auth/security-status',
]);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Sign a session. `sv` must be the account's current session version, or the
 * token is refused on first use.
 */
export function signToken(payload: AuthPayload & { sv: number }): string {
  const claims: AuthPayload = { ...payload, jti: randomBytes(12).toString('hex') };
  delete claims.exp;
  delete claims.iat;
  return jwt.sign(claims, jwtSigningSecret(), { expiresIn: '24h' });
}

const SESSION_ROLES = new Set(['admin', 'operator', 'viewer']);

/**
 * True only for a full session payload. The same secret also signs the short
 * "password accepted, now enter your code" token, which carries `partial: true`
 * and no role. A valid signature is therefore not enough: without this check
 * that token worked as a session and passed requireWrite, so a password alone
 * got past two-factor login.
 */
function isSessionPayload(p: unknown): p is AuthPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return o['partial'] === undefined
    && typeof o['userId'] === 'number'
    && typeof o['username'] === 'string' && o['username'] !== ''
    && typeof o['role'] === 'string' && SESSION_ROLES.has(o['role']);
}

export function verifyToken(token: string): AuthPayload {
  // Accept the current signing secret plus any prior strong secret, so a secret
  // rotation doesn't invalidate sessions already issued under the previous one.
  const secrets = jwtVerifierSecrets();
  let lastErr: unknown;
  for (const secret of secrets) {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, secret);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (!isSessionPayload(decoded)) throw new Error('not a session token');
    return decoded;
  }
  throw lastErr instanceof Error ? lastErr : new Error('invalid token');
}

/** Sign a short-lived token (e.g. the partial 2FA token) with the current secret. */
export function signRawToken(payload: object, options: jwt.SignOptions): string {
  return jwt.sign(payload, jwtSigningSecret(), options);
}

/** Verify a token that was signed with signRawToken, honoring rotated secrets. */
export function verifyRawToken<T>(token: string): T {
  const secrets = jwtVerifierSecrets();
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('invalid token');
}

// API tokens ("mtm_…") are hashed at rest; scope maps onto the existing role
// model (read → viewer, write → operator) so requireWrite/requireAdmin keep
// working unchanged. Admin actions always need a real session.
async function authenticateApiToken(token: string): Promise<AuthPayload | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await query<{ id: number; name: string; scope: string; expires_at: string | null }>(
    `SELECT id, name, scope, expires_at FROM api_tokens WHERE token_hash = $1`, [hash]
  ).catch(() => []);
  const t = rows[0];
  if (!t) return null;
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) return null;
  // Fire-and-forget usage tracking
  void query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
  return {
    userId: -t.id,
    username: `token:${t.name}`,
    role: t.scope === 'write' ? 'operator' : 'viewer',
    tokenAuth: true,
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.slice(7);

  if (token.startsWith('mtm_')) {
    authenticateApiToken(token)
      .then((payload) => {
        if (!payload) { res.status(401).json({ error: 'Invalid or expired API token' }); return; }
        req.user = payload;
        next();
      })
      .catch(() => res.status(401).json({ error: 'Invalid or expired API token' }));
    return;
  }

  let signed: AuthPayload;
  try {
    signed = verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // A valid signature isn't enough: the account may have been deleted, demoted
  // or had its password changed, or this session logged out (P2-1).
  validateSession(signed)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: 'This session has ended. Please sign in again.', code: 'session_ended' });
        return;
      }
      if (user.mustChangePassword) {
        const path = (req.originalUrl || req.url || '').split('?')[0];
        if (!PASSWORD_CHANGE_PATHS.has(path)) {
          res.status(403).json({ error: 'Change the default password before continuing.', code: 'password_change_required' });
          return;
        }
      }
      if (!applySiteAccess(req, res, user)) return;
      req.user = user;
      next();
    })
    .catch(() => res.status(503).json({ error: 'Could not check the session. Try again in a moment.' }));
}

const ROLE_RANK = new Map<string, number>([['viewer', 0], ['operator', 1], ['admin', 2]]);

/** The highest of a set of roles. */
export function highestRole(roles: string[]): string {
  return roles.reduce((a, b) => ((ROLE_RANK.get(b) ?? -1) > (ROLE_RANK.get(a) ?? -1) ? b : a), 'viewer');
}

/**
 * Site-scoped accounts (P1-7). The site a request asks for (X-Site-Id) must be
 * one of the account's, and the role that applies is its role there. With no
 * site asked for, the request covers all of its sites, under its highest role;
 * routes that act on a particular device then narrow the role to that device's
 * site (deviceSiteAccess). Fleet-wide accounts are untouched.
 *
 * Returns false after sending a response when the request is refused.
 */
function applySiteAccess(req: Request, res: Response, user: AuthPayload): boolean {
  if (!user.siteRoles) return true;
  const allowed = Object.keys(user.siteRoles).map(Number);
  // The account's own endpoints (who am I, log out, change password) aren't
  // about a site. A stale site selection left in the browser by another
  // account must not lock this one out of them, including the /auth/me call
  // the interface uses to notice and drop that selection.
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const requested = path.startsWith('/api/auth/') ? undefined : req.siteId;
  if (typeof requested === 'number') {
    const role = new Map(Object.entries(user.siteRoles)).get(String(requested));
    if (!role) {
      res.status(403).json({ error: 'You do not have access to that site.', code: 'site_forbidden' });
      return false;
    }
    user.role = role;
  } else {
    req.siteId = allowed;
    user.role = highestRole(Object.values(user.siteRoles));
  }
  return true;
}

/** True for an account limited to particular sites. */
export function isSiteScoped(user: AuthPayload | undefined): boolean {
  return !!user?.siteRoles;
}

/**
 * A fleet admin: role admin and not limited to particular sites. Fleet-wide
 * settings (users, SSO, alerting, API tokens, encryption...) all use this, so a
 * site admin can never reach them by accident (P1-7).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin' || isSiteScoped(req.user)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * An admin for the device or site the request is about: a fleet admin, or a
 * site admin whose role deviceSiteAccess has already narrowed to that site.
 */
export function requireSiteAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  // An allow-list, not "anything but viewer": a token with no role or an
  // unexpected one must not be treated as a writer.
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'operator')) {
    res.status(403).json({ error: 'Write access denied for viewer role' });
    return;
  }
  next();
}

/**
 * Refuse site-scoped accounts: for features that act on the whole fleet or on
 * configuration shared by every site (P1-7).
 */
export function fleetOnly(req: Request, res: Response, next: NextFunction): void {
  if (isSiteScoped(req.user)) {
    res.status(403).json({ code: 'fleet_only', error: 'This is fleet-wide, so it is not available to accounts limited to particular sites.' });
    return;
  }
  next();
}
