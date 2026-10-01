/**
 * WPA on the legacy wireless package (outside review P2-12).
 *
 * The newer wifi package takes a passphrase directly on the interface. The
 * legacy wireless package doesn't: security lives in a separate security
 * profile that the interface names. The manager used to drop the passphrase
 * on that package and create the SSID anyway, so a network the operator had
 * given a passphrase went on the air open, and a passphrase change on an
 * existing one did nothing.
 *
 * Now the manager gives each SSID it secures its own profile, `mtm-<interface>`,
 * creates or updates it first, and only then creates or points the interface
 * at it. Profiles shared with other SSIDs are never changed.
 */

/** The manager's own profile for an interface. */
export function legacyProfileName(iface: string): string {
  return `mtm-${iface}`;
}

/**
 * The authentication types to put on a legacy profile. The legacy package
 * supports WPA-PSK and WPA2-PSK only; asking for anything else is refused
 * rather than quietly downgraded.
 */
export function legacyAuthTypes(requested: string | undefined): string {
  const types = (requested ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (types.length === 0) return 'wpa2-psk';
  const unsupported = types.filter((t) => t !== 'wpa-psk' && t !== 'wpa2-psk');
  if (unsupported.length > 0) {
    throw new Error(
      `The legacy wireless package on this device supports only wpa-psk and wpa2-psk, not ${unsupported.join(', ')}. ` +
      'Choose WPA2, or upgrade the device to the wifi package for WPA3.'
    );
  }
  return types.join(',');
}

/** A WPA pre-shared key must be 8 to 63 characters. */
export function assertWpaPassphrase(passphrase: string): void {
  if (passphrase.length < 8 || passphrase.length > 63) {
    throw new Error('The passphrase must be 8 to 63 characters.');
  }
}

/** Everything a legacy security profile needs for WPA/WPA2-PSK with AES. */
export function legacyProfileParams(passphrase: string, authTypes: string): Record<string, string> {
  assertWpaPassphrase(passphrase);
  const params: Record<string, string> = {
    mode: 'dynamic-keys',
    'authentication-types': authTypes,
    'unicast-ciphers': 'aes-ccm',
    'group-ciphers': 'aes-ccm',
    'wpa2-pre-shared-key': passphrase,
  };
  if (authTypes.split(',').includes('wpa-psk')) params['wpa-pre-shared-key'] = passphrase;
  return params;
}

/** The comment the guest wizard puts on the SSIDs it creates, to know them again. */
export function guestSsidTag(guestName: string): string {
  return `mtm-guest:${guestName}`;
}
