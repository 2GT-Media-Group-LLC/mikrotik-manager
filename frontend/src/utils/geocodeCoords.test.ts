import { describe, it, expect } from 'vitest';
import { parseCoords, formatCoords } from './geocode';

describe('parseCoords (#362)', () => {
  it('reads a latitude and longitude as map sites copy them', () => {
    expect(parseCoords('51.5072, -0.1276')).toEqual({ lat: 51.5072, lng: -0.1276 });
    expect(parseCoords(' -33.8688 151.2093 ')).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(parseCoords('14.5995,120.9842')).toEqual({ lat: 14.5995, lng: 120.9842 });
  });
  it('treats an empty field as clearing the pin', () => {
    expect(parseCoords('  ')).toEqual({ empty: true });
  });
  it('refuses anything else, and values out of range', () => {
    for (const bad of ['51.5', 'London', '91, 0', '0, 181', '1,2,3', '51.5N 0.12W']) expect(parseCoords(bad)).toBeNull();
  });
  it('formats to six decimals without trailing zeros', () => {
    expect(formatCoords(51.50721234, -0.12)).toBe('51.507212, -0.12');
  });
});
