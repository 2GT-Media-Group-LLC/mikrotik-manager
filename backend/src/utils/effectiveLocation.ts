/**
 * Where a device is, for display and templating (#167).
 *
 * Devices and sites each had a location and the two never met: a site's
 * address was only used on the Sites map, and a device without its own
 * location showed nowhere, even inside a site with an address.
 *
 * The rule: a device's own location wins when it has one; otherwise it uses
 * its site's. It is all-or-nothing per source. A device address paired with the
 * site's coordinates would put a pin somewhere the address does not describe.
 *
 * Computed at read time and never copied into the device, so editing a site's
 * address moves every device that inherits it.
 */

export interface LocationFields {
  location_address?: string | null;
  location_lat?: number | string | null;
  location_lng?: number | string | null;
}

export interface SiteLocationFields {
  address?: string | null;
  location_lat?: number | string | null;
  location_lng?: number | string | null;
}

export interface EffectiveLocation {
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: 'device' | 'site';
}

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** Coordinates only count as a pair. */
function coords(lat: number | string | null | undefined, lng: number | string | null | undefined) {
  const a = num(lat);
  const b = num(lng);
  return a !== null && b !== null ? { lat: a, lng: b } : { lat: null, lng: null };
}

export function effectiveLocation(
  device: LocationFields,
  site: SiteLocationFields | null | undefined
): EffectiveLocation | null {
  const own = coords(device.location_lat, device.location_lng);
  const ownAddress = text(device.location_address);
  if (ownAddress || own.lat !== null) {
    return { address: ownAddress, ...own, source: 'device' };
  }
  if (site) {
    const sc = coords(site.location_lat, site.location_lng);
    const siteAddress = text(site.address);
    if (siteAddress || sc.lat !== null) {
      return { address: siteAddress, ...sc, source: 'site' };
    }
  }
  return null;
}
