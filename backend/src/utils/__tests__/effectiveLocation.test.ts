import { effectiveLocation } from '../effectiveLocation';

const site = { address: '1 Site Rd', location_lat: '52.1', location_lng: '4.3' };

describe('effectiveLocation (#167)', () => {
  it("uses the site's location when the device has none", () => {
    expect(effectiveLocation({}, site)).toEqual({ address: '1 Site Rd', lat: 52.1, lng: 4.3, source: 'site' });
  });

  it("uses the device's own location when set", () => {
    expect(effectiveLocation({ location_address: 'Building B', location_lat: 1, location_lng: 2 }, site))
      .toEqual({ address: 'Building B', lat: 1, lng: 2, source: 'device' });
  });

  it('never mixes a device address with site coordinates', () => {
    // Maps disabled: the device has an address but no coordinates.
    expect(effectiveLocation({ location_address: 'Remote cabinet' }, site))
      .toEqual({ address: 'Remote cabinet', lat: null, lng: null, source: 'device' });
  });

  it('treats blank and whitespace as unset', () => {
    expect(effectiveLocation({ location_address: '  ' }, site)?.source).toBe('site');
  });

  it('ignores half a coordinate pair', () => {
    expect(effectiveLocation({ location_lat: 5 }, site)?.source).toBe('site');
  });

  it('returns null when neither has anything', () => {
    expect(effectiveLocation({}, null)).toBeNull();
    expect(effectiveLocation({}, { address: '' })).toBeNull();
  });
});
