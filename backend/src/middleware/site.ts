import { Request, Response, NextFunction } from 'express';
import { resolveSiteId } from '../utils/siteScope';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Active site, or null for the whole fleet (all-sites view). */
      siteId?: number | null;
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

/** Convenience accessor so routes don't repeat the `?? null`. */
export function activeSite(req: Request): number | null {
  return req.siteId ?? null;
}
