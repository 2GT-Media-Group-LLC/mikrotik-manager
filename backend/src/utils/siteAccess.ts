/**
 * Can this account act on this device? (outside review P1-7)
 *
 * A fleet-wide account has its role on every device. A site-scoped account has,
 * on a device, the role it holds in that device's site, and no access at all to
 * devices in other sites. Routes answer "not found" for a device the account
 * can't see, so it can't learn which ids exist elsewhere.
 */
import type { Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../config/database';
import type { AuthPayload } from '../middleware/auth';

export type Role = 'admin' | 'operator' | 'viewer';
const RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  return (RANK[role ?? ''] ?? -1) >= RANK[min];
}

/** The account's role on a device in `siteId`, or null for no access. */
export function roleInSite(user: AuthPayload, siteId: number | null): string | null {
  if (!user.siteRoles) return user.role;
  if (siteId === null) return null;
  return user.siteRoles[siteId] ?? null;
}

/** The account's role on a device, or null if it can't see it (or it doesn't exist). */
export async function roleOnDevice(user: AuthPayload, deviceId: number): Promise<string | null> {
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return null;
  const row = await queryOne<{ site_id: number | null }>(`SELECT site_id FROM devices WHERE id = $1`, [deviceId]);
  if (!row) return null;
  return roleInSite(user, row.site_id);
}

/**
 * The devices in `ids` the account may not act on at `min`, including ids that
 * don't exist. Empty means all allowed.
 */
export async function devicesDenied(user: AuthPayload, ids: number[], min: Role): Promise<number[]> {
  const wanted = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (wanted.length === 0) return [];
  const rows = await query<{ id: number; site_id: number | null }>(
    `SELECT id, site_id FROM devices WHERE id = ANY($1::int[])`, [wanted]);
  const siteOf = new Map(rows.map((r) => [r.id, r.site_id]));
  return wanted.filter((id) => !siteOf.has(id) || !roleAtLeast(roleInSite(user, siteOf.get(id) ?? null), min));
}

/**
 * Express middleware for routers whose routes name one device. A site-scoped
 * account gets "not found" for a device outside its sites; otherwise its role
 * for the request becomes its role in that device's site, so requireWrite and
 * requireSiteAdmin judge the right site. Fleet-wide accounts pass untouched.
 */
export function deviceSiteAccess(getDeviceId: (req: Request) => number | null) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user?.siteRoles) { next(); return; }
    const deviceId = getDeviceId(req);
    if (!deviceId) { next(); return; }
    try {
      const role = await roleOnDevice(user, deviceId);
      if (!role) { res.status(404).json({ error: 'Device not found' }); return; }
      user.role = role;
      next();
    } catch {
      res.status(503).json({ error: 'Could not check access to the device.' });
    }
  };
}

/** Device id from `/:id/...` on the devices and wireless routers (any method). */
export function deviceIdParam(req: Request): number | null {
  const m = /^\/(\d+)(?:\/|$)/.exec(req.path);
  return m ? parseInt(m[1], 10) : null;
}

/** Device id from ?deviceId= or body.deviceId. */
export function deviceIdQuery(req: Request): number | null {
  const raw = req.query.deviceId ?? (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  const id = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Middleware for resources that belong to devices (a backup, a snapshot, a
 * rollout): `resolve` returns the device ids behind the request, or null when
 * it isn't about particular devices. A site-scoped account must be able to see
 * every one; its role for the request becomes the lowest it holds among them.
 */
export function resourceSiteAccess(resolve: (req: Request) => Promise<number[] | null>, notFound = 'Not found') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user?.siteRoles) { next(); return; }
    try {
      const ids = await resolve(req);
      if (!ids) { next(); return; }
      if (ids.length === 0) { res.status(404).json({ error: notFound }); return; }
      let lowest: string | null = null;
      for (const id of new Set(ids)) {
        const role = await roleOnDevice(user, id);
        if (!role) { res.status(404).json({ error: notFound }); return; }
        if (lowest === null || !roleAtLeast(role, lowest as Role)) lowest = role;
      }
      user.role = lowest!;
      next();
    } catch {
      res.status(503).json({ error: 'Could not check access.' });
    }
  };
}

/**
 * A Flux filter restricting series to devices in the scope (their device_id
 * tag), or '' when unscoped. An empty scope matches nothing.
 */
export async function fluxDeviceFilter(scope: number | number[] | null): Promise<string> {
  if (scope === null) return '';
  const sites = Array.isArray(scope) ? scope : [scope];
  const rows = await query<{ id: number }>(`SELECT id FROM devices WHERE site_id = ANY($1::int[])`, [sites]);
  if (rows.length === 0) return '|> filter(fn: (r) => false)';
  // Ids are integers from the database, so they are safe to inline as strings.
  return `|> filter(fn: (r) => contains(value: r.device_id, set: [${rows.map((r) => `"${r.id}"`).join(', ')}]))`;
}
