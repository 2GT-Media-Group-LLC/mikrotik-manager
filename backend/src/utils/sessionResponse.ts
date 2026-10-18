/**
 * The token and user returned by every sign-in: password, two-factor and SSO.
 */
import { signToken } from '../middleware/auth';
import { loadSiteRoles } from './siteRoles';

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
  // Including those reached through groups (#306); an account limited to an
  // empty group gets {} (nothing), not fleet-wide access.
  const siteRoles = (await loadSiteRoles(user.id).catch(() => null)) ?? undefined;
  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, must_change_password: mustChange, ...(siteRoles ? { siteRoles } : {}) },
  };
}
