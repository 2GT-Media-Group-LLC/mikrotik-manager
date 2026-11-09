/**
 * Address → coordinates via Nominatim.
 *
 * Extracted from DeviceLocationSection so device locations and site locations
 * share one implementation (issue #130). Callers must check the `maps_enabled`
 * setting before calling: geocoding is a third-party request that discloses
 * where your hardware is, and issue #106 exists to let operators refuse it.
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { Accept: 'application/json' } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch {
    // Geocoding is best-effort: a site without coordinates simply has no pin.
  }
  return null;
}

/**
 * Said after a save when the address couldn't be placed, instead of quietly
 * leaving the site or device off the map (#362).
 */
export const NOT_ON_MAP =
  "Saved, but that address couldn't be found on the map (or the lookup didn't answer), so there's no pin. A simpler form, such as street, town and country, usually works.";

/** The tile source used by every map in the app, so attribution stays consistent. */
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Coordinates typed by hand (#362): "51.5072, -0.1276" as copied from most
 * map sites, with a comma, spaces or both between. Null when it isn't a
 * latitude and longitude in range; empty input is `{ empty: true }`.
 */
export function parseCoords(text: string): { lat: number; lng: number } | { empty: true } | null {
  const t = text.trim();
  if (!t) return { empty: true };
  const parts = t.length > 64 ? [] : t.split(/[\s,]+/);
  const num = /^-?\d+(?:\.\d+)?$/;
  const m = parts.length === 2 && num.test(parts[0]!) && num.test(parts[1]!) ? [t, parts[0]!, parts[1]!] : null;
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Coordinates as shown in the field: six decimals is about 10 cm. */
export function formatCoords(lat: number, lng: number): string {
  return `${Number(lat.toFixed(6))}, ${Number(lng.toFixed(6))}`;
}
