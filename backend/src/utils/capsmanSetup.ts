/**
 * CAPsMAN quick set (#438): one SSID and password, and a device becomes a
 * CAPsMAN controller, optionally serving its own radios as well.
 *
 * Two CAPsMANs exist and neither manages the other's access points:
 *
 *   wifi    /interface/wifi/{configuration,provisioning,capsman,cap}, in the
 *           base system since RouterOS 7.13, for wifi-package (ax, ac wave2) APs.
 *   legacy  /caps-man/{configuration,provisioning,manager} and
 *           /interface/wireless/cap, with the legacy wireless package.
 *
 * What it sets up, either way: one configuration named `mtm-capsman` with the
 * SSID, WPA2 (and WPA3 on wifi) PSK and the bridge, one provisioning rule
 * (commented `mtm capsman`) that gives it to every radio, and the manager on.
 * "Controller and AP" also turns on the device's own CAP pointed at
 * 127.0.0.1, which is how RouterOS has a controller manage its own radios.
 * Running it again updates the same items.
 *
 * Pure, so it can be tested without a CAPsMAN deployment.
 */

export type CapsmanFlavor = 'wifi' | 'legacy';
type Row = Record<string, string>;

export const MTM_CAPSMAN = 'mtm-capsman';
export const MTM_CAPSMAN_COMMENT = 'mtm capsman';
const LOOPBACK = '127.0.0.1';

export const CAPSMAN_PATHS: Record<CapsmanFlavor, { configuration: string; provisioning: string; manager: string; cap: string }> = {
  wifi: {
    configuration: '/interface/wifi/configuration',
    provisioning: '/interface/wifi/provisioning',
    manager: '/interface/wifi/capsman',
    cap: '/interface/wifi/cap',
  },
  legacy: {
    configuration: '/caps-man/configuration',
    provisioning: '/caps-man/provisioning',
    manager: '/caps-man/manager',
    cap: '/interface/wireless/cap',
  },
};

/** What the device has now, for one flavor. */
export interface CapsmanLive {
  flavor: CapsmanFlavor;
  bridges: string[];
  configurations: Row[];
  provisioning: Row[];
  manager: Row | null;
  cap: Row | null;
  /** The device's own radios that its CAP would hand over (legacy: wlan names). */
  radios: string[];
}

export interface CapsmanSetupInput {
  flavor: CapsmanFlavor;
  ssid: string;
  /** Empty keeps the passphrase already set, when the setup exists. */
  passphrase: string;
  bridge: string;
  country: string | null;
  /** The controller's own radios join it too ("controller and AP"). */
  localRadios: boolean;
}

export interface CapsmanStep {
  /** RouterOS API command, e.g. /interface/wifi/configuration/add. */
  command: string;
  params: Row;
  description: string;
}

const yes = (v: string | undefined) => v === 'true' || v === 'yes';

/** The configuration and provisioning rule a previous run left. */
export function ownItems(live: Pick<CapsmanLive, 'configurations' | 'provisioning'>): { configuration: Row | null; rule: Row | null } {
  return {
    configuration: live.configurations.find((c) => c.name === MTM_CAPSMAN) ?? null,
    rule: live.provisioning.find((p) => p.comment === MTM_CAPSMAN_COMMENT || p['master-configuration'] === MTM_CAPSMAN) ?? null,
  };
}

/** The CAP is pointed at the device itself. */
export function capIsLocal(cap: Row | null): boolean {
  return !!cap && yes(cap.enabled) && (cap['caps-man-addresses'] ?? '').split(',').map((s) => s.trim()).includes(LOOPBACK);
}

/** Checks a request the way the UI does; returns the input or the first problem. */
export function parseCapsmanSetup(body: unknown, live: CapsmanLive): { input: CapsmanSetupInput } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const ssid = typeof b.ssid === 'string' ? b.ssid : '';
  const passphrase = typeof b.passphrase === 'string' ? b.passphrase : '';
  const bridge = typeof b.bridge === 'string' ? b.bridge : '';
  const country = typeof b.country === 'string' && b.country.trim() ? b.country.trim().toLowerCase() : null;
  const localRadios = b.localRadios === true;
  const existing = ownItems(live).configuration;

  const ssidError = capsmanSsidError(ssid);
  if (ssidError) return { error: ssidError };
  const passError = capsmanPassphraseError(passphrase, !!existing);
  if (passError) return { error: passError };
  if (!bridge) return { error: 'Choose the bridge the Wi-Fi clients join.' };
  if (!live.bridges.includes(bridge)) return { error: `${bridge} isn't a bridge on this device.` };
  if (country && !/^[a-z0-9 .()-]{2,40}$/.test(country)) return { error: 'Enter the country as RouterOS names it, e.g. "united states", or leave it empty.' };
  if (localRadios && live.radios.length === 0) {
    return { error: `This device has no ${live.flavor === 'wifi' ? 'wifi' : 'legacy wireless'} radios of its own. Choose controller only.` };
  }
  return { input: { flavor: live.flavor, ssid, passphrase, bridge, country, localRadios } };
}

export function capsmanSsidError(ssid: string): string | null {
  if (!ssid.trim()) return 'Enter the SSID.';
  if (Buffer.byteLength(ssid, 'utf8') > 32) return 'An SSID is at most 32 bytes.';
  return null;
}

export function capsmanPassphraseError(passphrase: string, canKeep: boolean): string | null {
  if (!passphrase) return canKeep ? null : 'Enter the Wi-Fi password.';
  if (/^[0-9a-fA-F]{64}$/.test(passphrase)) return null;
  if (!/^[\x20-\x7e]{8,63}$/.test(passphrase)) return 'The password is 8 to 63 plain characters (letters, digits, punctuation).';
  return null;
}

/** The writes, in order, and what to tell the user before they apply. */
export function planCapsman(input: CapsmanSetupInput, live: CapsmanLive): { steps: CapsmanStep[]; warnings: string[] } {
  const p = CAPSMAN_PATHS[input.flavor];
  const steps: CapsmanStep[] = [];
  const warnings: string[] = [];
  const { configuration, rule } = ownItems(live);

  // The configuration first: if RouterOS refuses a value (a country it
  // doesn't know, say), nothing else has changed yet.
  const settings: Row = input.flavor === 'wifi'
    ? {
      ssid: input.ssid,
      'security.authentication-types': 'wpa2-psk,wpa3-psk',
      ...(input.passphrase ? { 'security.passphrase': input.passphrase } : {}),
      'datapath.bridge': input.bridge,
    }
    : {
      ssid: input.ssid,
      mode: 'ap',
      'security.authentication-types': 'wpa2-psk',
      'security.encryption': 'aes-ccm',
      ...(input.passphrase ? { 'security.passphrase': input.passphrase } : {}),
      'datapath.bridge': input.bridge,
      // Each CAP bridges its own clients, rather than tunnelling them to the controller.
      'datapath.local-forwarding': 'yes',
    };
  if (input.country) settings.country = input.country;
  // Unchanged, and no new password: nothing to send. A password given is
  // always sent, since the device never shows it to compare.
  const current = new Map(Object.entries(configuration ?? {}));
  const unchanged = !!configuration && !input.passphrase
    && Object.entries(settings).every(([k, v]) => (current.get(k) ?? '') === v);
  if (unchanged) {
    // Nothing to do for the configuration.
  } else if (configuration) {
    steps.push({ command: `${p.configuration}/set`, params: { '.id': configuration['.id'], ...settings }, description: `Update the ${MTM_CAPSMAN} configuration (SSID ${input.ssid})` });
  } else {
    steps.push({ command: `${p.configuration}/add`, params: { name: MTM_CAPSMAN, ...settings }, description: `Add the ${MTM_CAPSMAN} configuration (SSID ${input.ssid})` });
  }

  if (!rule) {
    steps.push({
      command: `${p.provisioning}/add`,
      params: { action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT },
      description: 'Provision every radio that connects with it',
    });
  } else if (rule['master-configuration'] !== MTM_CAPSMAN || rule.action !== 'create-dynamic-enabled' || yes(rule.disabled)) {
    steps.push({
      command: `${p.provisioning}/set`,
      params: { '.id': rule['.id'], action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, disabled: 'no' },
      description: 'Point the provisioning rule at it',
    });
  }
  const others = live.provisioning.filter((r) => r !== rule && !yes(r.disabled));
  if (others.length) {
    warnings.push(`The device already has ${others.length === 1 ? 'a provisioning rule' : `${others.length} provisioning rules`} of its own. `
      + 'RouterOS uses the first rule that matches a radio, so radios those match keep their configuration.');
  }

  if (!yes(live.manager?.enabled)) {
    steps.push({ command: `${p.manager}/set`, params: { enabled: 'yes' }, description: 'Turn on CAPsMAN' });
  }

  const cap = live.cap;
  if (input.localRadios) {
    const params: Row = { enabled: 'yes', 'caps-man-addresses': LOOPBACK };
    if (input.flavor === 'legacy') {
      params.interfaces = live.radios.join(',');
      params.bridge = input.bridge;
    }
    const capNow = new Map(Object.entries(cap ?? {}));
    const same = capIsLocal(cap) && Object.entries(params).every(([k, v]) => k === 'enabled' || (capNow.get(k) ?? '') === v);
    if (!same) {
      steps.push({ command: `${p.cap}/set`, params, description: `Have its own radios (${live.radios.join(', ')}) join it` });
      if (yes(cap?.enabled) && !capIsLocal(cap)) {
        warnings.push('This device is a CAP of another controller now. Its radios will be managed by itself instead.');
      }
      warnings.push(`Its own radios (${live.radios.join(', ')}) switch to ${input.ssid}. Clients on their current networks reconnect to it.`);
    }
  } else if (capIsLocal(cap)) {
    // Controller only, after "controller and AP": its radios go back to their own settings.
    steps.push({ command: `${p.cap}/set`, params: { enabled: 'no' }, description: 'Stop managing its own radios' });
    warnings.push('Its own radios stop taking the controller\'s SSID and go back to their own settings.');
  }

  return { steps, warnings };
}

/** The flavor to offer first: the one the device's own radios use. */
export function defaultFlavor(available: CapsmanFlavor[], wifiPackage: string | null | undefined): CapsmanFlavor | null {
  if (available.includes('legacy') && wifiPackage === 'wireless') return 'legacy';
  if (available.includes('wifi')) return 'wifi';
  return available[0] ?? null;
}
