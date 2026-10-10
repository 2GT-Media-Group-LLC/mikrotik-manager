import { describe, it, expect } from 'vitest';
import { hasRadios, isWirelessDevice } from './wireless';

describe('hasRadios', () => {
  it('counts an all-in-one router with its own radios', () => {
    expect(hasRadios({ device_type: 'router', wifi_role: 'standalone' })).toBe(true);
    expect(hasRadios({ device_type: 'wireless_ap', wifi_role: null })).toBe(true);
    expect(hasRadios({ device_type: 'router', wifi_role: 'none' })).toBe(false);
    expect(hasRadios({ device_type: 'router' })).toBe(false);
  });
  it('treats a controller without radios as wireless but not as having radios', () => {
    expect(hasRadios({ device_type: 'router', wifi_role: 'controller' })).toBe(false);
    expect(isWirelessDevice({ device_type: 'router', wifi_role: 'controller' })).toBe(true);
  });
});
