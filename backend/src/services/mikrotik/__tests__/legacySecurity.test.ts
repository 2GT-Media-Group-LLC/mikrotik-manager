import { legacyAuthTypes, legacyProfileParams, legacyProfileName, guestSsidTag } from '../legacySecurity';

describe('legacySecurity', () => {
  it('defaults to WPA2-PSK and keeps WPA/WPA2', () => {
    expect(legacyAuthTypes(undefined)).toBe('wpa2-psk');
    expect(legacyAuthTypes('wpa-psk, wpa2-psk')).toBe('wpa-psk,wpa2-psk');
  });
  it.each(['wpa3-psk', 'wpa2-psk,wpa3-psk', 'owe'])('refuses %s', (t) => expect(() => legacyAuthTypes(t)).toThrow());
  it('sets AES and the key for each type asked for', () => {
    expect(legacyProfileParams('12345678', 'wpa2-psk')).toEqual({
      mode: 'dynamic-keys', 'authentication-types': 'wpa2-psk', 'unicast-ciphers': 'aes-ccm', 'group-ciphers': 'aes-ccm',
      'wpa2-pre-shared-key': '12345678',
    });
    expect(legacyProfileParams('12345678', 'wpa-psk,wpa2-psk')['wpa-pre-shared-key']).toBe('12345678');
  });
  it.each(['short', 'x'.repeat(64)])('refuses a passphrase of the wrong length', (p) => expect(() => legacyProfileParams(p, 'wpa2-psk')).toThrow(/8 to 63/));
  it('names the manager\'s own profile and guest tag', () => {
    expect(legacyProfileName('wlan2')).toBe('mtm-wlan2');
    expect(guestSsidTag('cafe')).toBe('mtm-guest:cafe');
  });
});
