import { useAuthStore } from '../store/authStore';
import { useSiteStore } from '../store/siteStore';

/**
 * Whether write controls should be offered. For an account limited to
 * particular sites this follows the site in view: an operator in one site and
 * a viewer in another gets read-only controls in the second (P1-7). The server
 * enforces the same rule per device either way.
 */
export function useCanWrite(): boolean {
  const user = useAuthStore((state) => state.user);
  const siteId = useSiteStore((state) => state.currentSiteId);
  if (user?.siteRoles && siteId != null) {
    const role = user.siteRoles[String(siteId)];
    return role === 'operator' || role === 'admin';
  }
  return user?.role !== 'viewer';
}

/** An account limited to particular sites (P1-7). */
export function useIsSiteScoped(): boolean {
  return useAuthStore((state) => !!state.user?.siteRoles);
}

/** A fleet administrator: the only kind that sees platform settings. */
export function useIsFleetAdmin(): boolean {
  return useAuthStore((state) => state.user?.role === 'admin' && !state.user?.siteRoles);
}

/**
 * An admin where it counts: in `siteId` (a device's site) for an account
 * limited to particular sites, otherwise the account's own role. The web
 * terminal is offered only to admins (#411); the server checks the same.
 */
export function useIsAdminIn(siteId: number | null | undefined): boolean {
  const user = useAuthStore((state) => state.user);
  const current = useSiteStore((state) => state.currentSiteId);
  if (user?.siteRoles) {
    const id = siteId ?? current;
    // "All my sites": an admin somewhere; the server checks each device.
    if (id == null) return Object.values(user.siteRoles).includes('admin');
    return user.siteRoles[String(id)] === 'admin';
  }
  return user?.role === 'admin';
}
