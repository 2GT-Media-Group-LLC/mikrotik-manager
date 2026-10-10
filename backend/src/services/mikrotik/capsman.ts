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

/**
 * Roles with radios of their own. 'standalone' is a device running its own
 * Wi-Fi, which includes all-in-one routers such as the hAP ac² (RBD52G): added
 * as a router, it is still an access point.
 */
export const RADIO_ROLES: readonly WifiRole[] = ['standalone', 'cap', 'controller_cap'];
/** Roles the wireless pages cover: radios of its own, or a CAPsMAN controller. */
export const WIRELESS_ROLES: readonly WifiRole[] = [...RADIO_ROLES, 'controller'];

/**
 * Which wireless package drives this device, from how many interfaces each
 * menu lists (null: the menu doesn't exist).
 *
 * Since RouterOS 7.13 the /interface/wifi menu is in the base system on every
 * device, for CAPsMAN, so it answers even with no Wi-Fi package installed. A
 * hAP ac² (RBD52G) on the legacy wireless package lists its radios under
 * /interface/wireless and nothing under /interface/wifi. So the menu with
 * radios wins; without radios, an existing wifi menu still means the device
 * can be a CAPsMAN controller.
 */
export function chooseWifiPackage(wifiCount: number | null, wirelessCount: number | null): 'wifi' | 'wireless' | 'none' {
  if (wifiCount !== null && wifiCount > 0) return 'wifi';
  if (wirelessCount !== null && wirelessCount > 0) return 'wireless';
  if (wifiCount !== null) return 'wifi';
  if (wirelessCount !== null) return 'wireless';
  return 'none';
}

/** Does this device have radios, whatever type it was added as? */
export function hasRadios(d: { device_type?: string; wifi_role?: string | null }): boolean {
  return d.device_type === 'wireless_ap' || RADIO_ROLES.includes((d.wifi_role ?? 'none') as WifiRole);
}

/** SQL: a device the wireless pages cover. `alias` is the devices table alias, if any. */
export function wirelessDeviceSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}device_type = 'wireless_ap' OR ${a}wifi_role IN (${WIRELESS_ROLES.map((r) => `'${r}'`).join(',')}))`;
}

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
/**
 * Index every known interface MAC to the device(s) carrying it.
 *
 * Multi-valued deliberately. A CAPsMAN controller mirrors each CAP's interfaces
 * locally, so a CAP's radio MAC legitimately appears under both the CAP and the
 * controller. A single-valued first-wins index picked whichever row the database
 * returned first, which attributed half a fleet's radios to the controller and
 * shuffled between polls (#94).
 */
export function buildMacIndex(
  rows: { device_id: number; mac_address: string | null }[]
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.mac_address) continue;
    for (const key of macIndexKeys(row.mac_address)) {
      const list = index.get(key) ?? [];
      if (!list.includes(row.device_id)) list.push(row.device_id);
      index.set(key, list);
    }
  }
  return index;
}

/**
 * Attribute each radio a controller reports to a managed device, by MAC.
 *
 * A radio the controller flags `local: false` physically lives on a CAP, so the
 * controller is never the answer — even when its mirror of that interface makes the
 * MAC look like its own. Matching is on hardware identity: a MAC is globally unique,
 * so unlike an address it cannot mean two devices on two segments.
 */
export function matchRadiosToDevices(
  radios: RadioRow[],
  macToDevice: Map<string, number[]>,
  controllerDeviceId: number
): { radio: RadioRow; deviceId: number | null }[] {
  return radios.map((radio) => {
    if (radio.local) return { radio, deviceId: controllerDeviceId };
    return { radio, deviceId: lookupDeviceForMac(radio.radioMac, macToDevice, controllerDeviceId) };
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
 * `excludeDeviceId` is rejected at both exact and prefix strength. That is not a
 * tie-break heuristic: the caller passes the controller for a radio the controller
 * itself reported as remote, so the controller is known to be the wrong answer, and
 * an exact match against it only means the controller mirrors that CAP's interface.
 */
export function lookupDeviceForMac(
  mac: string | null,
  index: Map<string, number[]>,
  excludeDeviceId?: number
): number | null {
  if (!mac) return null;
  for (const key of macIndexKeys(mac)) {
    const candidates = index.get(key);
    if (!candidates) continue;
    const hit = candidates.find((id) => id !== excludeDeviceId);
    if (hit !== undefined) return hit;
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

// ─── Legacy CAPsMAN (/caps-man, the "wireless" package) — #250 ───────────────
//
// RouterOS 6 and the legacy wireless package on 7 run the original CAPsMAN under
// its own menu tree. Older 802.11n/ac wave 1 access points (RB951, hAP ac lite,
// cAP ac) can only be CAPs of this one. Field names below are as a CHR on 7.24.5
// reports them (reporter's output in #250):
//
//   /caps-man/manager           → enabled
//   /caps-man/remote-cap        → identity, address, board, base-mac, version, state
//   /caps-man/interface         → radio-mac, master-interface ("none" on a radio),
//                                 configuration, current-state,
//                                 current-channel "2412/20/gn(30dBm)",
//                                 current-registered-clients, current-authorized-clients
//   /caps-man/registration-table → interface, ssid, mac-address, comment
//   /interface/wireless/cap      → enabled, interfaces (on the CAP)
//
// Under legacy CAPsMAN the CAP's own registration table stays empty: clients are
// listed on the controller only.

/** Is legacy CAPsMAN switched on? `/caps-man/manager/print` returns one row. */
export function legacyManagerEnabled(rows: Record<string, string>[] | null): boolean {
  return !!rows?.some((r) => isYes(r['enabled']));
}

/** The interfaces a legacy CAP hands to its controller, from `/interface/wireless/cap/print`. */
export function legacyCapInterfaces(rows: Record<string, string>[] | null): string[] {
  const row = rows?.find((r) => isYes(r['enabled']));
  if (!row) return [];
  return (row['interfaces'] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** "2412/20/gn(30dBm)" → channel "2412/20/gn", 30 dBm. */
export function parseLegacyChannel(v: string | undefined): { channel: string | null; txPower: number | null } {
  const s = (v || '').trim();
  if (!s) return { channel: null, txPower: null };
  const open = s.indexOf('(');
  if (open < 0) return { channel: s, txPower: null };
  const power = parseInt(s.slice(open + 1), 10);
  return { channel: s.slice(0, open).trim() || null, txPower: Number.isFinite(power) ? power : null };
}

export interface LegacyRadio {
  radioMac: string;
  interfaceName: string | null;
  state: string | null;
  channel: string | null;
  txPower: number | null;
  registeredPeers: number | null;
  authorizedPeers: number | null;
  ssid: string | null;
  /** Identity of the AP the radio lives on, when the controller says. */
  capIdentity: string | null;
  raw: Record<string, string>;
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const isRadioRow = (r: Record<string, string>): boolean => {
  const master = (r['master-interface'] || '').trim();
  return !!r['radio-mac'] && (master === '' || master === 'none');
};

/**
 * The radios a legacy controller manages, one per physical radio (virtual APs
 * carry a master-interface and are folded into their radio's client count).
 *
 * The AP a radio lives on comes from /caps-man/radio when it was read, or else
 * from /caps-man/remote-cap by MAC: a CAP's base MAC and its radio MACs share
 * their first five octets (base D4:CA:6D:BB:0E:52, radio …:0E:57 in #250). That
 * is only used when exactly one CAP matches.
 */
export function legacyRadios(
  interfaces: Record<string, string>[],
  radios: Record<string, string>[] | null,
  remoteCaps: Record<string, string>[] | null,
  configurations: Record<string, string>[] | null,
  registrations: Record<string, string>[] | null,
): LegacyRadio[] {
  const counts = registrations ? clientsPerRadio(interfaces, registrations) : null;
  const ssidOfConfig = new Map((configurations ?? []).filter((c) => c['name']).map((c) => [c['name'], c['ssid'] || null]));
  const ssidSeen = new Map<string, string>();
  for (const r of registrations ?? []) if (r['interface'] && r['ssid']) ssidSeen.set(r['interface'], r['ssid']);
  const prefix = (mac: string) => mac.toUpperCase().split(':').slice(0, 5).join(':');

  return interfaces.filter(isRadioRow).map((r) => {
    const radioMac = r['radio-mac'].toUpperCase();
    const { channel, txPower } = parseLegacyChannel(r['current-channel']);
    const radio = radios?.find((x) => (x['radio-mac'] || '').toUpperCase() === radioMac);
    let capIdentity = radio?.['remote-cap-identity'] || radio?.['remote-cap-name'] || null;
    if (!capIdentity && remoteCaps) {
      const hits = remoteCaps.filter((c) => c['base-mac'] && prefix(c['base-mac']) === prefix(radioMac));
      if (hits.length === 1) capIdentity = hits[0]['identity'] || hits[0]['name'] || null;
    }
    const name = r['name'] || null;
    return {
      radioMac,
      interfaceName: name,
      state: r['current-state'] || null,
      channel,
      txPower,
      registeredPeers: counts ? (counts.get(radioMac) ?? 0) : num(r['current-registered-clients']),
      authorizedPeers: num(r['current-authorized-clients']),
      ssid: r['configuration.ssid'] || ssidOfConfig.get(r['configuration'] || '') || (name ? ssidSeen.get(name) : undefined) || null,
      capIdentity,
      raw: r,
    };
  });
}
