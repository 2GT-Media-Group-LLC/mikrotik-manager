import type { Request } from 'express';

/**
 * The request path with each segment decoded, as Express decodes route
 * parameters (GHSA-6xq3-q9m5-7hxp). Access checks that read an id from the
 * path must see the same value the route handler will, or a differently
 * spelled path could be checked as one thing and handled as another.
 * Returns null for a segment that can't be decoded, which callers refuse.
 *
 * Lower-cased, with one trailing slash dropped: Express routes `/ROLLOUTS/4/start`
 * and `/channel/` to the same handlers as `/rollouts/4/start` and `/channel`,
 * so a check that only knew the plain spelling let the others through
 * (GHSA-4rjj-7mfg-vrpg). Every caller matches lower-case words, ids and MAC
 * hex, which lower-casing leaves the same.
 */
export function decodedPath(req: Pick<Request, 'path'>): string | null {
  try {
    const path = req.path.split('/').map((seg) => decodeURIComponent(seg)).join('/').toLowerCase();
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  } catch {
    return null;
  }
}
