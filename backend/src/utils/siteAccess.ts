/**
 * Can this account act on this device? (outside review P1-7)
 *
 * A fleet-wide account has its role on every device. A site-scoped account has,
 * on a device, the role it holds in that device's site, and no access at all to
 * devices in other sites. Routes answer "not found" for a device the account
 * can't see, so it can't learn which ids exist elsewhere.
 */
import type { Request, Response, NextFunction, Router } from 'express';
import { decodedPath } from './requestPath';
import { query, queryOne } from '../config/database';
import type { AuthPayload } from '../middleware/auth';

export type Role = 'admin' | 'operator' | 'viewer';
const RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  return (RANK[role ?? ''] ?? -1) >= RANK[min];
}

/** Largest value of a Postgres integer id. */
const MAX_ID = 2_147_483_647;

/**
 * An id as the database stores it: a positive whole number, or a string of
 * digits only. Anything else (" 20", "+20", "0x14", "20x", 20.5, an array) is
 * null. Postgres and parseInt would each read some of those as 20, so a site
 * check and a handler that parse an id differently could look at different
 * devices (GHSA-j9x4-qwcj-p8v8). Every check and handler reads ids through this.
 */
export function strictId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 && raw <= MAX_ID ? raw : null;
  if (typeof raw === 'string' && /^\d{1,10}$/.test(raw)) {
    const n = Number(raw);
    return n > 0 && n <= MAX_ID ? n : null;
  }
  return null;
}

/** A list of strict ids, or null if it isn't an array or any entry isn't one. */
export function strictIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: number[] = [];
  for (const v of raw) {
    const id = strictId(v);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * Answer "not found" for any of the named route parameters that isn't a strict
 * id, before a handler can read it another way (GHSA-j9x4-qwcj-p8v8).
 */
export function guardIdParams(router: Router, names: string[], notFound = 'Not found'): void {
  for (const name of names) {
    router.param(name, (_req, res, next, value) => {
      if (strictId(String(value)) === null) { res.status(404).json({ error: notFound }); return; }
      next();
    });
  }
}

/**
 * A site-scoped account's role for this request. The first site check sets it;
 * a later check on the same request can only lower it, never raise it, so a
 * second id (a ?deviceId= next to a path id) can't lift the role the first one
 * set (GHSA-j9x4-qwcj-p8v8).
 */
const narrowed = new WeakSet<Request>();
function narrowRole(req: Request, role: string): void {
  const user = req.user!;
  if (!narrowed.has(req) || !roleAtLeast(role, user.role as Role)) user.role = role as typeof user.role;
  narrowed.add(req);
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
export async function devicesDenied(user: AuthPayload, ids: readonly unknown[], min: Role): Promise<unknown[]> {
  // An entry that isn't a strict id is refused, not skipped: dropped, it left
  // nothing to check while the handler still found the device (GHSA-j9x4-qwcj-p8v8).
  const malformed = ids.filter((v) => strictId(v) === null);
  const wanted = [...new Set(ids.map(strictId).filter((n): n is number => n !== null))];
  if (wanted.length === 0) return malformed;
  const rows = await query<{ id: number; site_id: number | null }>(
    `SELECT id, site_id FROM devices WHERE id = ANY($1::int[])`, [wanted]);
  const siteOf = new Map(rows.map((r) => [r.id, r.site_id]));
  return [...malformed, ...wanted.filter((id) => !siteOf.has(id) || !roleAtLeast(roleInSite(user, siteOf.get(id) ?? null), min))];
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
    if (Number.isNaN(deviceId)) { res.status(400).json({ error: 'Malformed request path' }); return; }
    if (!deviceId) { next(); return; }
    try {
      const role = await roleOnDevice(user, deviceId);
      if (!role) { res.status(404).json({ error: 'Device not found' }); return; }
      narrowRole(req, role);
      next();
    } catch {
      res.status(503).json({ error: 'Could not check access to the device.' });
    }
  };
}

/**
 * Device id from `/:id/...` on the devices and wireless routers (any method),
 * read from the decoded path so it is the id the route handler receives
 * (GHSA-6xq3-q9m5-7hxp). NaN for a path that can't be decoded: the caller
 * refuses it rather than treating it as a route with no device.
 */
export function deviceIdParam(req: Request): number | null {
  const path = decodedPath(req);
  if (path === null) return NaN;
  const first = path.split('/')[1] ?? '';
  // A first segment that starts like a number but isn't a plain id ("+20",
  // "0x14", "20x") is refused, not treated as a route with no device.
  if (!/^[+-]?\d/.test(first)) return null;
  return strictId(first) ?? NaN;
}

/**
 * Device id from ?deviceId= or body.deviceId; null when neither is given.
 * NaN (refused) when either isn't a strict id, or when both are given and
 * differ, so the id checked is the one any handler reads (GHSA-j9x4-qwcj-p8v8).
 */
export function deviceIdQuery(req: Request): number | null {
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  const q = req.query.deviceId;
  const b = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  const qId = given(q) ? strictId(q) : null;
  const bId = given(b) ? strictId(b) : null;
  if ((given(q) && qId === null) || (given(b) && bId === null)) return NaN;
  if (qId !== null && bId !== null && qId !== bId) return NaN;
  return qId ?? bId;
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
      narrowRole(req, lowest!);
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
  // `==` joined by `or` rather than contains(), which InfluxDB can't push down
  // to storage (see the Traffic site filter, PR #179).
  return `|> filter(fn: (r) => ${rows.map((r) => `r.device_id == "${r.id}"`).join(' or ')})`;
}
