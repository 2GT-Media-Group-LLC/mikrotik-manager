import { describe, it, expect } from 'vitest';
import { filterDevices } from './devicePicker';

const fleet = [
  { id: 1, name: 'AMS-core-01', ip_address: '10.2.0.1', site_name: 'Amsterdam', model: 'CCR2116' },
  { id: 2, name: 'AMS-sw-02', ip_address: '10.2.0.12', site_name: 'Amsterdam', model: 'CRS326' },
  { id: 3, name: 'RTM-core-01', ip_address: '10.3.0.1', site_name: 'Rotterdam', model: 'CCR2116' },
  { id: 4, name: 'lab-core', ip_address: '192.168.88.1', site_name: null, model: 'hAP ax3' },
];

describe('device picker matching (#304)', () => {
  it('returns everything for empty text', () => {
    expect(filterDevices(fleet, '  ')).toHaveLength(4);
  });

  it('matches every word anywhere: name, address, site, model', () => {
    expect(filterDevices(fleet, 'amsterdam crs').map((d) => d.id)).toEqual([2]);
    expect(filterDevices(fleet, '10.3').map((d) => d.id)).toEqual([3]);
    expect(filterDevices(fleet, 'ccr rotter').map((d) => d.id)).toEqual([3]);
  });

  it('is case-insensitive', () => {
    expect(filterDevices(fleet, 'HAP').map((d) => d.id)).toEqual([4]);
  });

  it('ranks names starting with the text first, then names containing it', () => {
    // 'a': AMS-* start with it, lab-core contains it, RTM matches only by site.
    expect(filterDevices(fleet, 'a').map((d) => d.id)).toEqual([1, 2, 4, 3]);
    // Ties keep the caller's order.
    expect(filterDevices(fleet, 'core').map((d) => d.id)).toEqual([1, 3, 4]);
  });
});
