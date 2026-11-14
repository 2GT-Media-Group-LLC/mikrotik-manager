import { describe, it, expect } from 'vitest';
import { siteMapView } from './siteMapView';

const sites = [
  { id: 1, map_zoom: 17, location_lat: '14.5995', location_lng: '120.9842' },
  { id: 2, map_zoom: null, location_lat: 1, location_lng: 2 },
  { id: 3, map_zoom: 12 },
];

describe('siteMapView (#362)', () => {
  it('opens on the site\'s pin at its zoom', () => {
    expect(siteMapView([{ site_id: 1 }, { site_id: 1 }], sites)).toEqual({ zoom: 17, center: [14.5995, 120.9842] });
  });
  it('ignores devices without a site (Ron)', () => {
    expect(siteMapView([{ site_id: 1 }, { site_id: null }, {}], sites)).toEqual({ zoom: 17, center: [14.5995, 120.9842] });
  });
  it('centres on the devices when the site has a zoom but no pin', () => {
    expect(siteMapView([{ site_id: 3 }], sites)).toEqual({ zoom: 12, center: null });
  });
  it('fits the map as before for several sites, a site without a zoom, or no sites', () => {
    expect(siteMapView([{ site_id: 1 }, { site_id: 3 }], sites)).toBeNull();
    expect(siteMapView([{ site_id: 2 }], sites)).toBeNull();
    expect(siteMapView([{ site_id: null }], sites)).toBeNull();
    expect(siteMapView([{ site_id: 9 }], sites)).toBeNull();
  });
});
