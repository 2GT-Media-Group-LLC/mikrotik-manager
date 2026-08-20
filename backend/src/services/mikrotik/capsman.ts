/**
 * CAPsMAN awareness.
 *
 * When a MikroTik AP is managed by CAPsMAN, its own configuration is not local:
 * `/interface/wifi/print` returns rows with the `configuration.*` and `security.*`
 * fields simply absent, because the controller owns them. Code that reads those
 * fields therefore stores nulls, and the UI renders an access point with no SSID,
 * no security and no band — looking broken rather than delegated
 * (github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/94).
 *
 * What RouterOS does expose, verified on 7.23:
 *
 *   /interface/wifi/capsman/print  → { enabled }        is this device a controller
 *   /interface/wifi/cap/print      → { enabled }        is this device a CAP
 *   /interface/wifi/radio/print    → radio-mac, local, interface, hw-type, …
 *
 * `radio-mac` is the useful part. A controller lists **every** radio it manages
 * through `/interface/wifi/radio`, remote ones included, each with its MAC. Since
 * interface MACs are already collected for every managed device, CAPs can be joined
 * to devices directly on that MAC — no neighbour traversal, no resolving addresses
 * within a segment, and none of the cross-segment ambiguity that made topology
 * unreliable (see services/topology/buildTopology.ts).
 *
 * Everything here is pure so it can be tested without a CAPsMAN deployment, which
 * matters because we do not have one.
 */

export type WifiRole = 'none' | 'standalone' | 'cap' | 'controller' | 'controller_cap';

export interface CapsmanStatus {
  /** MAC of the controller managing this radio, when it could be read. */
  controllerMac: string | null;
  /** Interface or VLAN the CAP reaches its controller over, e.g. `management_vlan`. */
  controllerInterface: string | null;
  /** SSID the controller provisioned, when RouterOS reports it in the status text. */
  ssid: string | null;
  /** Raw channel spec, e.g. `5280/ax/eCee`. */
  channel: string | null;
  mode: string | null;
}

const isYes = (v: string | undefined): boolean => v === 'yes' || v === 'true';

/**
 * Classify a device from the two feature toggles. Both can be on: MikroTik
 * explicitly supports a controller that also runs its own radios, and the reporter
 * of #94 calls that case out, so it gets its own role rather than being folded into
 * one of the others.
 */
export function classifyWifiRole(
  capsman: Record<string, string>[] | null,
  cap: Record<string, string>[] | null,
  hasWifiInterfaces: boolean
): WifiRole {
  const isController = !!capsman?.some((r) => isYes(r['enabled']));
  const isCap = !!cap?.some((r) => isYes(r['enabled']));

  if (isController && isCap) return 'controller_cap';
  if (isController) return 'controller';
  if (isCap) return 'cap';
  return hasWifiInterfaces ? 'standalone' : 'none';
}

/**
 * Pull what we can out of RouterOS's human-readable CAPsMAN status line, e.g.
 *
 *   managed by CAPsMAN 02:F8:E3:80:10:97%management_vlan, traffic processing on CAP,
 *   mode: AP, SSID: HomeAccessPoint, channel: 5280/ax/eCee
 *
 * Every value on the row is scanned rather than a specific field being read,
 * because which field carries this text is not documented and has moved between
 * releases. Searching is cheap and survives it moving again.
 */
/**
 * Pull a `<mac>%<interface>` reference out of a status line, given the phrase that
 * introduces it.
 *
 * Deliberately not one combined regular expression: the pattern needed to express
 * "literal, whitespace, MAC, optional %interface" trips ReDoS linters, and this
 * input is device-supplied text. Slicing at fixed offsets is linear by construction
 * and needs no reasoning about backtracking.
 */
function parseNodeRef(text: string, marker: RegExp): { mac: string | null; iface: string | null } {
  const m = marker.exec(text);
  if (!m) return { mac: null, iface: null };

  const rest = text.slice(m.index + m[0].length).trimStart();
  const mac = rest.slice(0, 17);
  if (!/^[0-9A-Fa-f:]{17}$/.test(mac)) return { mac: null, iface: null };

  let iface: string | null = null;
  if (rest[17] === '%') {
    const tail = rest.slice(18);
    const end = tail.search(/[,\s]/);
    iface = (end === -1 ? tail : tail.slice(0, end)) || null;
  }
  return { mac: mac.toUpperCase(), iface };
}

/** Value of a `Key: value` pair up to the next comma. */
function labelled(text: string, label: string): string | null {
  const i = text.toLowerCase().indexOf(`${label.toLowerCase()}:`);
  if (i === -1) return null;
  const after = text.slice(i + label.length + 1);
  const end = after.indexOf(',');
  return (end === -1 ? after : after.slice(0, end)).trim() || null;
}

/**
 * Pull what we can out of RouterOS's human-readable CAPsMAN status line, e.g.
 *
 *   managed by CAPsMAN 02:F8:E3:80:10:97%management_vlan, traffic processing on CAP,
 *   mode: AP, SSID: HomeAccessPoint, channel: 5280/ax/eCee
 *
 * Every value on the row is scanned rather than a specific field being read,
 * because which field carries this text is not documented and has moved between
 * releases. Searching is cheap and survives it moving again.
 */
export function parseCapsmanStatus(row: Record<string, string>): CapsmanStatus | null {
  const text = Object.values(row).find(
    (v) => typeof v === 'string' && /managed by CAPsMAN/i.test(v)
  );
  if (!text) return null;

  const ref = parseNodeRef(text, /managed by CAPsMAN/i);
  return {
    controllerMac: ref.mac,
    controllerInterface: ref.iface,
    ssid: labelled(text, 'SSID'),
    channel: labelled(text, 'channel'),
    mode: labelled(text, 'mode'),
  };
}

/**
 * The controller-side counterpart: `operated by CAP <mac>%<interface>`. Used to
 * label radios on a controller that physically live on a remote AP.
 */
export function parseCapStatus(row: Record<string, string>): { capMac: string | null; capInterface: string | null } | null {
  const text = Object.values(row).find(
    (v) => typeof v === 'string' && /operated by CAP/i.test(v)
  );
  if (!text) return null;
  const ref = parseNodeRef(text, /operated by CAP/i);
  return { capMac: ref.mac, capInterface: ref.iface };
}

/**
 * True when this wifi interface's configuration is owned by a controller.
 *
 * The device's role is the reliable signal; the absence of a local SSID confirms
 * it per-interface. A CAP can still hold locally-configured interfaces alongside
 * provisioned ones, so this is not simply "the device is a CAP".
 */
export function isCapsmanManaged(row: Record<string, string>, role: WifiRole): boolean {
  if (parseCapsmanStatus(row)) return true;
  if (role !== 'cap' && role !== 'controller_cap') return false;
  // Provisioned interfaces carry no local configuration.
  return !row['configuration.ssid'] && !row['ssid'];
}

export interface RadioRow {
  radioMac: string | null;
  interfaceName: string | null;
  local: boolean;
  hwType: string | null;
  currentChannel: string | null;
  raw: Record<string, string>;
}

/** Normalise `/interface/wifi/radio/print` rows. */
export function normalizeRadios(rows: Record<string, string>[]): RadioRow[] {
  return rows.map((r) => ({
    radioMac: (r['radio-mac'] || '').toUpperCase() || null,
    interfaceName: r['interface'] || null,
    local: isYes(r['local']),
    hwType: r['hw-type'] || null,
    currentChannel: r['current-channels'] || r['current-channel'] || null,
    raw: r,
  }));
}

/**
 * Attribute each radio a controller reports to a managed device, by MAC.
 *
 * `macToDevice` should hold every interface MAC known across the fleet. Matching is
 * on hardware identity alone: a MAC is globally unique, so unlike an address it
 * cannot mean two different devices on two different segments.
 */
export function matchRadiosToDevices(
  radios: RadioRow[],
  macToDevice: Map<string, number>,
  controllerDeviceId: number
): { radio: RadioRow; deviceId: number | null }[] {
  return radios.map((radio) => {
    if (radio.local) return { radio, deviceId: controllerDeviceId };
    const hit = radio.radioMac ? macToDevice.get(radio.radioMac.toUpperCase()) : undefined;
    return { radio, deviceId: hit ?? null };
  });
}

/**
 * A radio MAC is usually the interface MAC with the low bits of the last octet
 * varying per radio, so an exact lookup can miss by one. Callers build the index
 * with this so a near-miss still resolves, while keeping the OUI and the first five
 * octets exact — enough to stay unambiguous within a fleet.
 */
export function macIndexKeys(mac: string): string[] {
  const norm = mac.toUpperCase();
  const parts = norm.split(':');
  if (parts.length !== 6) return [norm];
  return [norm, parts.slice(0, 5).join(':')];
}

/** Look up a device for a radio MAC, falling back to the five-octet prefix. */
export function lookupDeviceForMac(
  mac: string | null,
  index: Map<string, number>
): number | null {
  if (!mac) return null;
  for (const key of macIndexKeys(mac)) {
    const hit = index.get(key);
    if (hit !== undefined) return hit;
  }
  return null;
}
