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

/**
 * Look up a device for a radio MAC, falling back to the five-octet prefix.
 *
 * `excludeOnPrefix` refuses a *prefix* match against a given device — used to stop a
 * remote CAP being attributed to the controller when the two happen to share the
 * first five octets. An exact match is still honoured, since that is hardware
 * identity rather than a near-miss. Reported on #94, where a CAP's radio was grouped
 * under the controller instead of its access point.
 */
export function lookupDeviceForMac(
  mac: string | null,
  index: Map<string, number>,
  excludeOnPrefix?: number
): number | null {
  if (!mac) return null;
  const keys = macIndexKeys(mac);

  const exact = index.get(keys[0]);
  if (exact !== undefined) return exact;

  for (const key of keys.slice(1)) {
    const hit = index.get(key);
    if (hit === undefined) continue;
    if (excludeOnPrefix !== undefined && hit === excludeOnPrefix) continue;
    return hit;
  }
  return null;
}

export interface RadioLiveState {
  state: string | null;
  /** Operating channel, e.g. `5500/ax/Ceee/D`. */
  channel: string | null;
  registeredPeers: number | null;
  authorizedPeers: number | null;
  txPower: number | null;
}

/**
 * Read live radio state from a `/interface/wifi/monitor ... once` row.
 *
 * This exists because `/interface/wifi/radio`'s `current-channels` is the list of
 * channels the radio *supports* — kilobytes of text on a multi-band radio — not the
 * channel it is using. Monitor reports the operating channel, and it also carries
 * the peer counts, which under CAPsMAN the controller knows and the CAP does not.
 */
export function parseRadioMonitor(row: Record<string, string> | undefined): RadioLiveState {
  const num = (v: string | undefined): number | null => {
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  return {
    state: row?.['state'] || null,
    channel: row?.['channel'] || null,
    registeredPeers: num(row?.['registered-peers']),
    authorizedPeers: num(row?.['authorized-peers']),
    txPower: num(row?.['tx-power']),
  };
}

/**
 * Resolve which bridge and VLAN a wifi interface lands on.
 *
 * A CAPsMAN-provisioned interface is not a local bridge port, so looking it up in
 * the AP's own bridge port table finds nothing and the UI ends up claiming the
 * interface has no network at all. The answer lives in the datapath — either inline
 * on the interface row or in a named datapath the interface references.
 */
export function resolveDatapath(
  iface: Record<string, string>,
  datapaths: Record<string, string>[]
): { bridge: string | null; vlanId: string | null } {
  const inlineBridge = iface['datapath.bridge'];
  const inlineVlan = iface['datapath.vlan-id'];
  if (inlineBridge || inlineVlan) {
    return { bridge: inlineBridge || null, vlanId: inlineVlan || null };
  }

  const name = iface['datapath'];
  if (name && !name.startsWith('*')) {
    const dp = datapaths.find((d) => d['name'] === name);
    if (dp) return { bridge: dp['bridge'] || null, vlanId: dp['vlan-id'] || null };
  }
  // `.id` reference rather than a name.
  if (name) {
    const dp = datapaths.find((d) => d['.id'] === name);
    if (dp) return { bridge: dp['bridge'] || null, vlanId: dp['vlan-id'] || null };
  }
  return { bridge: null, vlanId: null };
}

/**
 * Count registered clients per radio.
 *
 * Clients do not register on the physical radio — they register on the virtual AP
 * carrying the SSID. `/interface/wifi/monitor` on a physical radio therefore reports
 * zero even when the access point is busy, and `/interface/wifi/radio` lists only the
 * physical radios. Measured on a wAP ax with ten clients: wifi1 and wifi2 reported
 * `registered-peers=0`, while wifi3–wifi6 held all ten.
 *
 * So the registration table is the source of truth, and each entry is attributed to
 * its radio by following `master-interface` up to the interface that owns a
 * `radio-mac`. Requires `/interface/wifi/print detail` — the field is absent without it.
 */
export function clientsPerRadio(
  interfaces: Record<string, string>[],
  registrations: Record<string, string>[]
): Map<string, number> {
  const byName = new Map(interfaces.filter((i) => i['name']).map((i) => [i['name'], i]));

  /** Walk up to the interface that owns a radio, guarding against a cyclic chain. */
  const radioOf = (name: string): string | null => {
    let cur = byName.get(name);
    for (let hops = 0; cur && hops < 8; hops++) {
      const mac = cur['radio-mac'];
      if (mac) return mac.toUpperCase();
      const parent = cur['master-interface'];
      if (!parent || parent === cur['name']) return null;
      cur = byName.get(parent);
    }
    return null;
  };

  const counts = new Map<string, number>();
  for (const reg of registrations) {
    const iface = reg['interface'];
    if (!iface) continue;
    const mac = radioOf(iface);
    if (!mac) continue;
    counts.set(mac, (counts.get(mac) ?? 0) + 1);
  }
  return counts;
}
