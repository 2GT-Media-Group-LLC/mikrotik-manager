import { describe, it, expect } from 'vitest';
import { capsLabel } from './nodes';

describe('capsLabel (#260)', () => {
  it('calls a computer with a software bridge a computer, not a switch', () => {
    expect(capsLabel('bridge,station')).toBe('Computer');
  });
  it('calls an access point an AP although it bridges', () => {
    expect(capsLabel('bridge,wlan-ap')).toBe('AP');
  });
  it('keeps a layer-3 switch a switch', () => {
    expect(capsLabel('bridge,router')).toBe('Switch');
    expect(capsLabel('router')).toBe('Router');
    expect(capsLabel('')).toBe('');
  });
});
