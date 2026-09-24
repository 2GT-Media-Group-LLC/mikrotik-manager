import { query } from '../config/database';
import { effectiveLocation, type EffectiveLocation } from '../utils/effectiveLocation';

type SiteLoc = { id: number; address: string | null; location_lat: number | null; location_lng: number | null };

/**
 * Attach `effective_location` to device rows (#167). One query for all sites,
 * rather than a join, because the device queries select bare column names that
 * sites shares (id, name, notes, location_*).
 */
export async function withEffectiveLocation<T extends {
  site_id?: number | null;
  location_address?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
}>(rows: T[]): Promise<(T & { effective_location: EffectiveLocation | null })[]> {
  const sites = await query<SiteLoc>(
    `SELECT id, address, location_lat::float8 AS location_lat, location_lng::float8 AS location_lng FROM sites`
  ).catch(() => [] as SiteLoc[]);
  const byId = new Map(sites.map((s) => [s.id, s]));
  return rows.map((r) => ({
    ...r,
    effective_location: effectiveLocation(r, r.site_id != null ? byId.get(r.site_id) : null),
  }));
}
