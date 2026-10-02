/**
 * Translating the manager's wireless-style keys to the wifi package's
 * dot-notation (outside review C6).
 *
 * Country, tx-power, antenna gain, installation and the cipher settings used
 * to be dropped for the wifi package while the change was reported as a
 * success, so a regulatory or power change did nothing. They are mapped now,
 * and what has no wifi-package equivalent is refused, not dropped.
 */

const FIELD_MAP: Record<string, string> = {
  'ssid':                   'configuration.ssid',
  'mode':                   'configuration.mode',
  'country':                'configuration.country',
  'tx-power':               'configuration.tx-power',
  'antenna-gain':           'configuration.antenna-gain',
  'installation':           'configuration.installation',
  'band':                   'channel.band',
  'frequency':              'channel.frequency',
  'channel-width':          'channel.width',
  'passphrase':             'security.passphrase',
  'wpa2-pre-shared-key':    'security.passphrase',
  'wpa-pre-shared-key':     'security.passphrase',
  'authentication-types':   'security.authentication-types',
  'encryption':             'security.encryption',
  'unicast-ciphers':        'security.encryption',
  'group-ciphers':          'security.group-encryption',
  'management-protection':  'security.management-protection',
  'security-profile':       'security',   // old pkg "security-profile" → new pkg "security"
  'disabled':               'disabled',
  'master-interface':       'master-interface',
  'name':                   'name',
};

/** Legacy cipher names → wifi package names. */
const CIPHERS: Record<string, string> = { 'aes-ccm': 'ccmp', 'tkip': 'tkip' };

function mapCiphers(key: string, value: string): string {
  return value.split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
    const mapped = CIPHERS[c];
    if (!mapped) throw new Error(`${key}=${c} has no equivalent on the wifi package.`);
    return mapped;
  }).join(',');
}

export function translateToWifiParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  // Virtual APs (master-interface set) inherit mode from their master — RouterOS rejects
  // configuration.mode if it is sent explicitly for a virtual interface.
  const isVirtualAp = !!params['master-interface'];
  for (const [k, raw] of Object.entries(params)) {
    if (k === 'mode' && isVirtualAp) continue;
    if (k === 'tx-power-mode') {
      // The wifi package has only a tx-power limit; "default" is what it does anyway.
      if (raw === 'default') continue;
      throw new Error(`tx-power-mode=${raw} isn't available on the wifi package. Set tx-power (a limit in dBm) instead.`);
    }
    // Both keys carry the same passphrase; the WPA2 one wins if they differ.
    if (k === 'wpa-pre-shared-key' && params['wpa2-pre-shared-key'] !== undefined) continue;
    const v = k === 'unicast-ciphers' || k === 'group-ciphers' ? mapCiphers(k, raw) : raw;
    out[FIELD_MAP[k] ?? k] = v;
  }
  return out;
}
