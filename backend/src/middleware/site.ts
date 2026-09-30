import { Request, Response, NextFunction } from 'express';
import { resolveSiteId, type SiteScope } from '../utils/siteScope';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Active site; null for the whole fleet (all-sites view); or, for a
       * site-scoped account with no site chosen, the list of its sites (P1-7).
       */
      siteId?: number | number[] | null;
    }
  }
}

/**
 * Reads the active site from the X-Site-Id header (issue #130).
 *
 * An absent, empty or 'all' header means unscoped. That default is what keeps
 * every pre-existing API consumer -- scripts, API tokens, the docs' curl
 * examples -- behaving exactly as it did before sites existed.
 *
 * A query-string ?site_id= is also honoured, for links and for anything that
 * cannot set headers.
 */
export function siteContext(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['x-site-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  req.siteId = resolveSiteId(raw ?? req.query.site_id);
  next();
}

/**
 * The site scope for queries: one site, a site-scoped account's list of sites,
 * or null for the whole fleet. Pass it to the siteScope helpers.
 */
export function activeSite(req: Request): SiteScope {
  return req.siteId ?? null;
}

/**
 * The site a device being created should join (P1-7).
 *
 * Fleet-wide accounts: the active site, or null for the default site, as
 * before. A site-scoped account must land it in one of its own sites, where it
 * is at least an operator: the chosen site, or its only site. With several
 * sites and none chosen, the caller is asked to pick one.
 */
export function targetSite(req: Request): { ok: true; siteId: number | null } | { ok: false; status: number; error: string } {
  const scope = req.siteId ?? null;
  const roles = req.user?.siteRoles;
  if (!roles) return { ok: true, siteId: typeof scope === 'number' ? scope : null };
  const site = typeof scope === 'number' ? scope : (Array.isArray(scope) && scope.length === 1 ? scope[0] : null);
  if (site === null) {
    return { ok: false, status: 400, error: 'Choose which site the device belongs to with the site switcher first.' };
  }
  const role = roles[site];
  if (role !== 'admin' && role !== 'operator') {
    return { ok: false, status: 403, error: 'You need operator access to that site to add devices to it.' };
  }
  return { ok: true, siteId: site };
}

/**
 * The site scope for a write that covers every device in view (apply SNMP to
 * all, bulk-delete backups...). A site-scoped account can hold different roles
 * in different sites, so only sites where it is at least an operator are
 * included; a viewer site is never written to by an "all" (P1-7).
 */
export function writableScope(req: Request): SiteScope {
  const roles = req.user?.siteRoles;
  if (!roles) return activeSite(req);
  const scope = req.siteId;
  const sites = typeof scope === 'number' ? [scope] : Array.isArray(scope) ? scope : [];
  return sites.filter((id) => roles[id] === 'admin' || roles[id] === 'operator');
}
