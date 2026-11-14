/**
 * A map's view from its site's saved pin and zoom (#362): when the devices on
 * the map that have a site are all in one, and that site has a zoom, the map
 * opens at that zoom, centred on the site's pin when it has one (else on the
 * devices). Devices without a site don't count. Null means fit the map to its
 * pins as before.
 */
export interface SiteViewSite { id: number; map_zoom?: number | null; location_lat?: number | string | null; location_lng?: number | string | null }

export function siteMapView(
  devices: { site_id?: number | null }[],
  sites: SiteViewSite[],
): { zoom: number; center: [number, number] | null } | null {
  const ids = new Set(devices.map((d) => d.site_id).filter((id): id is number => id != null));
  if (ids.size !== 1) return null;
  const site = sites.find((s) => s.id === [...ids][0]);
  if (site?.map_zoom == null) return null;
  const lat = site.location_lat == null || site.location_lat === '' ? NaN : Number(site.location_lat);
  const lng = site.location_lng == null || site.location_lng === '' ? NaN : Number(site.location_lng);
  return { zoom: site.map_zoom, center: Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null };
}
