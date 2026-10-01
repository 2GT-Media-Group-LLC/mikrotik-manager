/**
 * The token and user returned by every sign-in: password, two-factor and SSO.
 */
import { query } from '../config/database';
import { signToken } from '../middleware/auth';

export async function sessionResponse(user: {
  id: number; username: string; role: string; must_change_password?: boolean; session_version?: number;
}) {
  const mustChange = !!user.must_change_password;
  const token = signToken({
    userId: user.id, username: user.username, role: user.role, sv: user.session_version ?? 0,
    ...(mustChange ? { mustChangePassword: true } : {}),
  });
  // Site roles with the session, so the interface is right from its first
  // render rather than after it next asks (P1-7). Never put in the token.
  const sites = await query<{ site_id: number; role: string }>(
    `SELECT site_id, role FROM user_site_roles WHERE user_id = $1`, [user.id]).catch(() => []);
  const siteRoles = sites.length ? Object.fromEntries(sites.map((r) => [r.site_id, r.role])) : undefined;
  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, must_change_password: mustChange, ...(siteRoles ? { siteRoles } : {}) },
  };
}
