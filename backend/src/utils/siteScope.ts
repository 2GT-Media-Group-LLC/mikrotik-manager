/**
 * Site scoping helpers (issue #130).
 *
 * Every device-derived table hangs off devices(id), so a single site_id on
 * devices scopes clients, events, topology, backups and the rest transitively.
 * These helpers turn an active site into the SQL predicate that does it.
 *
 * The site id is inlined rather than parameterised, and that is a deliberate
 * choice worth justifying: the collection routes build their WHERE clauses by
 * incrementing a shared $n counter, so injecting a parameter mid-build would
 * mean renumbering every filter in ~23 routes -- exactly the kind of manual
 * bookkeeping that produces silent off-by-one bugs. Inlining is safe here
 * because resolveSiteId() below admits nothing but a positive integer; a value
 * that is not one becomes null (unscoped), never text that reaches SQL.
 */

/**
 * Normalise an untrusted site id (header, query string) into either a positive
 * integer or null, where null means "no scoping -- show the whole fleet".
 *
 * 'all' is the explicit all-sites view. Anything unparseable is also treated as
 * unscoped rather than rejected, so an existing API consumer that knows nothing
 * about sites keeps working exactly as it did.
 */
export function resolveSiteId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'all') return null;
  // Matched as a literal digit string rather than via Number(), deliberately.
  // Number() would accept '1e3', '0x1' and even Arabic-Indic '\u0661\u0662' as
  // integers -- all harmless here, but it makes the safety of inlining rest on
  // coercion trivia. A digits-only regex makes it self-evident instead.
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Predicate for a query that selects from `devices` itself.
 * Returns null when unscoped, so callers can skip pushing a filter.
 */
export function siteScopeDevices(siteId: number | null, alias = ''): string | null {
  if (siteId === null) return null;
  const col = alias ? `${alias}.site_id` : 'site_id';
  return `${col} = ${siteId}`;
}

/**
 * Predicate for a query on any table carrying a device_id.
 * `column` is the fully-qualified device id column, e.g. 'c.device_id'.
 */
export function siteScopeByDevice(siteId: number | null, column = 'device_id'): string | null {
  if (siteId === null) return null;
  return `${column} IN (SELECT id FROM devices WHERE site_id = ${siteId})`;
}

/**
 * Same, but tolerant of a nullable device id. Rows not attached to any device
 * (fleet-wide events, for instance) belong to no site and are hidden while a
 * site is selected -- showing them in every site would misrepresent them as
 * that site's own.
 */
export function siteScopeByNullableDevice(siteId: number | null, column = 'device_id'): string | null {
  if (siteId === null) return null;
  return `(${column} IS NOT NULL AND ${column} IN (SELECT id FROM devices WHERE site_id = ${siteId}))`;
}

/**
 * Join a base WHERE clause with an optional site predicate.
 * Handles the empty-base case so routes don't each reinvent it.
 */
export function andSite(base: string, predicate: string | null): string {
  if (!predicate) return base;
  const trimmed = base.trim();
  if (!trimmed) return `WHERE ${predicate}`;
  return `${base} AND ${predicate}`;
}

/**
 * Which deduplicated client-count series to read for a site (issue #130).
 *
 * DeviceCollector writes a fleet-wide `_global` series and a per-site
 * `_site_<id>` series. The per-site one only accumulates from the upgrade
 * onward, so preferring it unconditionally would throw away the existing
 * history of every install that has one site.
 *
 * When a site holds every device, its total *is* the global total -- an
 * identity, not an approximation -- so `_global` is both correct and complete.
 */
export function clientSeriesTag(
  siteId: number | null,
  devicesInSite: number,
  devicesTotal: number
): string {
  if (siteId === null) return '_global';
  if (devicesTotal > 0 && devicesInSite === devicesTotal) return '_global';
  return `_site_${siteId}`;
}
