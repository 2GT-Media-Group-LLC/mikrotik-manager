// CAPsMAN quick set (#438): the checks the server makes, shown as you type.

export function capsmanSsidError(ssid: string): string | null {
  if (!ssid.trim()) return 'Enter the SSID.';
  if (new TextEncoder().encode(ssid).length > 32) return 'An SSID is at most 32 bytes.';
  return null;
}

/** `canKeep`: the setup exists, so an empty password keeps the current one. */
export function capsmanPassphraseError(passphrase: string, canKeep: boolean): string | null {
  if (!passphrase) return canKeep ? null : 'Enter the Wi-Fi password.';
  if (/^[0-9a-fA-F]{64}$/.test(passphrase)) return null;
  if (!/^[\x20-\x7e]{8,63}$/.test(passphrase)) return 'The password is 8 to 63 plain characters (letters, digits, punctuation).';
  return null;
}

export function capsmanCountryError(country: string): string | null {
  const c = country.trim().toLowerCase();
  if (c && !/^[a-z0-9 .()-]{2,40}$/.test(c)) return 'Enter the country as RouterOS names it, e.g. "united states", or leave it empty.';
  return null;
}
