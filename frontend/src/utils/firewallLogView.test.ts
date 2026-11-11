import { describe, expect, it } from 'vitest';
import { pageItems, zoneColor } from './firewallLogView';

describe('pageItems', () => {
  it('lists every page when there are few', () => {
    expect(pageItems(0, 1)).toEqual([0]);
    expect(pageItems(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('shows the first pages, a gap and the last near the start', () => {
    expect(pageItems(0, 181)).toEqual([0, 1, 2, 3, 4, 'gap', 180]);
    expect(pageItems(3, 181)).toEqual([0, 1, 2, 3, 4, 'gap', 180]);
  });

  it('shows the neighbours of a page in the middle', () => {
    expect(pageItems(50, 181)).toEqual([0, 'gap', 49, 50, 51, 'gap', 180]);
  });

  it('shows the last pages near the end', () => {
    expect(pageItems(180, 181)).toEqual([0, 'gap', 176, 177, 178, 179, 180]);
    expect(pageItems(177, 181)).toEqual([0, 'gap', 176, 177, 178, 179, 180]);
  });

  it('always includes the current page', () => {
    for (let c = 0; c < 20; c++) expect(pageItems(c, 20)).toContain(c);
  });
});

describe('zoneColor', () => {
  it('gives the usual names the usual colours', () => {
    expect(zoneColor('UNTRUST', false)).toContain('red');
    expect(zoneColor('WAN', false)).toContain('red');
    expect(zoneColor('TRUST', false)).toContain('green');
    expect(zoneColor('LAN', false)).toContain('green');
    expect(zoneColor('DMZ', false)).toContain('amber');
    expect(zoneColor('Guest-WiFi', false)).toContain('amber');
  });

  it('keeps the router neutral', () => {
    expect(zoneColor('Router', true)).toContain('gray');
  });

  it('gives another zone the same colour every time', () => {
    expect(zoneColor('cameras', false)).toBe(zoneColor('cameras', false));
    expect(zoneColor('cameras', false)).not.toMatch(/red|green|amber|gray/);
  });
});
