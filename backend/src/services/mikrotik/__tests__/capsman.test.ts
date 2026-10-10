import {
  classifyWifiRole, parseCapsmanStatus, parseCapStatus, isCapsmanManaged,
  normalizeRadios, matchRadiosToDevices, lookupDeviceForMac, macIndexKeys, buildMacIndex,
  hasRadios, wirelessDeviceSql,
} from '../capsman';

describe('classifyWifiRole', () => {
  const on = [{ enabled: 'yes' }];
  const off = [{ enabled: 'no' }];

  it('reads the two toggles independently', () => {
    expect(classifyWifiRole(off, off, true)).toBe('standalone');
    expect(classifyWifiRole(on, off, true)).toBe('controller');
    expect(classifyWifiRole(off, on, true)).toBe('cap');
  });

  // Explicitly called out in #94: a device can be the controller and still run
  // its own radios under that same controller.
  it('gives a controller with local radios its own role', () => {
    expect(classifyWifiRole(on, on, true)).toBe('controller_cap');
  });

  it('reports none when there is no wireless hardware at all', () => {
    expect(classifyWifiRole(off, off, false)).toBe('none');
    expect(classifyWifiRole(null, null, false)).toBe('none');
  });

  it('treats a controller with no local radios as a controller, not none', () => {
    expect(classifyWifiRole(on, off, false)).toBe('controller');
  });

  it('accepts "true" as well as "yes"', () => {
    expect(classifyWifiRole([{ enabled: 'true' }], off, true)).toBe('controller');
  });
});

describe('parseCapsmanStatus', () => {
  // Verbatim from the issue.
  const line = 'managed by CAPsMAN 02:F8:E3:80:10:97%management_vlan, traffic processing on CAP, mode: AP, SSID: HomeAccessPoint, channel: 5280/ax/eCee';

  it('extracts controller, interface, SSID, mode and channel', () => {
    const s = parseCapsmanStatus({ status: line })!;
    expect(s.controllerMac).toBe('02:F8:E3:80:10:97');
    expect(s.controllerInterface).toBe('management_vlan');
    expect(s.ssid).toBe('HomeAccessPoint');
    expect(s.mode).toBe('AP');
    expect(s.channel).toBe('5280/ax/eCee');
  });

  // Which field carries this text is undocumented, so the parser searches values
  // rather than trusting a field name.
  it('finds the status text under any field name', () => {
    expect(parseCapsmanStatus({ 'some-future-field': line })?.ssid).toBe('HomeAccessPoint');
  });

  it('copes with a status line that omits the optional parts', () => {
    const s = parseCapsmanStatus({ status: 'managed by CAPsMAN 02:F8:E3:80:10:97, traffic processing on CAP' })!;
    expect(s.controllerMac).toBe('02:F8:E3:80:10:97');
    expect(s.controllerInterface).toBeNull();
    expect(s.ssid).toBeNull();
  });

  it('returns null for a locally configured interface', () => {
    expect(parseCapsmanStatus({ name: 'wifi1', 'configuration.ssid': 'TestNet' })).toBeNull();
  });
});

describe('parseCapStatus', () => {
  it('extracts the CAP identity from the controller side', () => {
    const r = parseCapStatus({ status: 'operated by CAP 02:F8:E1:50:13:5F%management_vlan, traffic processing on CAP' })!;
    expect(r.capMac).toBe('02:F8:E1:50:13:5F');
    expect(r.capInterface).toBe('management_vlan');
  });

  it('returns null when the radio is local', () => {
    expect(parseCapStatus({ interface: 'wifi1' })).toBeNull();
  });
});

describe('isCapsmanManaged', () => {
  it('trusts an explicit status line whatever the role', () => {
    const row = { status: 'managed by CAPsMAN 02:F8:E3:80:10:97%mgmt, mode: AP' };
    expect(isCapsmanManaged(row, 'standalone')).toBe(true);
  });

  it('treats a CAP interface with no local SSID as provisioned', () => {
    expect(isCapsmanManaged({ name: 'wifi1' }, 'cap')).toBe(true);
  });

  // A CAP may still carry locally-configured interfaces alongside provisioned
  // ones, so the role alone must not be the test.
  it('leaves a locally configured interface on a CAP alone', () => {
    expect(isCapsmanManaged({ name: 'wifi1', 'configuration.ssid': 'Local' }, 'cap')).toBe(false);
  });

  it('never claims a standalone AP is managed', () => {
    expect(isCapsmanManaged({ name: 'wifi1' }, 'standalone')).toBe(false);
  });
});

describe('normalizeRadios', () => {
  // Real rows from a RouterOS 7.23 wAP ax.
  const rows = [
    { '.id': '*1', 'radio-mac': 'd0:ea:11:0a:de:78', interface: 'wifi1', local: 'true', 'hw-type': 'QCA5018' },
    { '.id': '*2', 'radio-mac': 'D0:EA:11:0A:DE:79', interface: 'wifi2', local: 'true', 'hw-type': 'QCN6122' },
  ];

  it('upper-cases MACs so lookups are case-stable', () => {
    expect(normalizeRadios(rows).map((r) => r.radioMac))
      .toEqual(['D0:EA:11:0A:DE:78', 'D0:EA:11:0A:DE:79']);
  });

  it('reads the local flag', () => {
    expect(normalizeRadios(rows).every((r) => r.local)).toBe(true);
    expect(normalizeRadios([{ 'radio-mac': 'AA:BB:CC:DD:EE:FF', local: 'false' }])[0].local).toBe(false);
  });
});

describe('matchRadiosToDevices', () => {
  const index = buildMacIndex([{ device_id: 7, mac_address: 'AA:BB:CC:00:00:01' }]);

  it('attributes a local radio to the controller itself', () => {
    const radios = normalizeRadios([{ 'radio-mac': 'FF:FF:FF:00:00:09', local: 'true' }]);
    expect(matchRadiosToDevices(radios, index, 3)[0].deviceId).toBe(3);
  });

  it('attributes a remote radio to the managed device owning that MAC', () => {
    const radios = normalizeRadios([{ 'radio-mac': 'aa:bb:cc:00:00:01', local: 'false' }]);
    expect(matchRadiosToDevices(radios, index, 3)[0].deviceId).toBe(7);
  });

  it('leaves an unmanaged CAP unattributed rather than guessing', () => {
    const radios = normalizeRadios([{ 'radio-mac': '11:22:33:44:55:66', local: 'false' }]);
    expect(matchRadiosToDevices(radios, index, 3)[0].deviceId).toBeNull();
  });
});

describe('lookupDeviceForMac', () => {
  it('matches exactly when the MAC is known', () => {
    const idx = buildMacIndex([{ device_id: 5, mac_address: 'AA:BB:CC:00:00:01' }]);
    expect(lookupDeviceForMac('aa:bb:cc:00:00:01', idx)).toBe(5);
  });

  /**
   * A radio MAC commonly differs from the device's interface MAC in the final
   * octet, so an exact-only lookup would leave real CAPs unattributed.
   */
  it('falls back to the five-octet prefix when the last octet differs', () => {
    const idx = buildMacIndex([{ device_id: 5, mac_address: 'AA:BB:CC:00:00:01' }]);
    expect(lookupDeviceForMac('AA:BB:CC:00:00:07', idx)).toBe(5);
  });

  it('does not match a different device sharing only an OUI', () => {
    const idx = buildMacIndex([{ device_id: 5, mac_address: 'AA:BB:CC:00:00:01' }]);
    expect(lookupDeviceForMac('AA:BB:CC:99:99:99', idx)).toBeNull();
  });

  it('returns null for a missing MAC', () => {
    expect(lookupDeviceForMac(null, new Map<string, number[]>())).toBeNull();
  });
});

// ── live radio state and datapath (issue #94 follow-up) ──────────────────────

import { parseRadioMonitor, resolveDatapath, clientsPerRadio } from '../capsman';

describe('parseRadioMonitor', () => {
  // Shape reported by the issue author from `/interface/wifi/monitor wifi1 once`.
  const row = {
    state: 'running',
    channel: '5500/ax/Ceee/D',
    'registered-peers': '10',
    'authorized-peers': '10',
    'tx-power': '24',
  };

  it('reads the operating channel and peer counts', () => {
    const s = parseRadioMonitor(row);
    expect(s.state).toBe('running');
    expect(s.channel).toBe('5500/ax/Ceee/D');
    expect(s.registeredPeers).toBe(10);
    expect(s.authorizedPeers).toBe(10);
    expect(s.txPower).toBe(24);
  });

  it('returns nulls rather than zeros when monitor gave nothing', () => {
    const s = parseRadioMonitor(undefined);
    expect(s.channel).toBeNull();
    expect(s.registeredPeers).toBeNull();   // absent must not read as "0 clients"
  });

  it('treats an empty peer count as unknown, not zero', () => {
    expect(parseRadioMonitor({ 'registered-peers': '' }).registeredPeers).toBeNull();
  });
});

describe('resolveDatapath', () => {
  const datapaths: Record<string, string>[] = [
    { '.id': '*3', name: 'guest-dp', bridge: 'bridge1', 'vlan-id': '20' },
    { '.id': '*4', name: 'mgmt-dp', bridge: 'bridge1' },
  ];

  it('prefers inline datapath fields on the interface', () => {
    expect(resolveDatapath({ 'datapath.bridge': 'bridge9', 'datapath.vlan-id': '99' }, datapaths))
      .toEqual({ bridge: 'bridge9', vlanId: '99' });
  });

  it('follows a named datapath reference', () => {
    expect(resolveDatapath({ datapath: 'guest-dp' }, datapaths))
      .toEqual({ bridge: 'bridge1', vlanId: '20' });
  });

  it('follows an .id datapath reference', () => {
    expect(resolveDatapath({ datapath: '*3' }, datapaths))
      .toEqual({ bridge: 'bridge1', vlanId: '20' });
  });

  it('reports a datapath with no VLAN as untagged rather than inventing one', () => {
    expect(resolveDatapath({ datapath: 'mgmt-dp' }, datapaths))
      .toEqual({ bridge: 'bridge1', vlanId: null });
  });

  it('returns nulls when the interface has no datapath at all', () => {
    expect(resolveDatapath({ name: 'wifi1' }, datapaths))
      .toEqual({ bridge: null, vlanId: null });
  });
});

describe('clientsPerRadio', () => {
  // Shape taken from a live wAP ax: virtual APs carry the clients and reference
  // their physical radio through master-interface.
  const interfaces: Record<string, string>[] = [
    { name: 'wifi1', 'radio-mac': 'D0:EA:11:0A:DE:78', master: 'true' },
    { name: 'wifi2', 'radio-mac': 'D0:EA:11:0A:DE:79', master: 'true' },
    { name: 'wifi3', 'master-interface': 'wifi1', master: 'false' },
    { name: 'wifi5', 'master-interface': 'wifi1', master: 'false' },
    { name: 'wifi6', 'master-interface': 'wifi2', master: 'false' },
  ];

  it('attributes clients on a virtual AP to its physical radio', () => {
    const counts = clientsPerRadio(interfaces, [
      { interface: 'wifi3' }, { interface: 'wifi3' }, { interface: 'wifi3' },
      { interface: 'wifi5' }, { interface: 'wifi5' },
      { interface: 'wifi6' },
    ]);
    expect(counts.get('D0:EA:11:0A:DE:78')).toBe(5);   // wifi3 + wifi5
    expect(counts.get('D0:EA:11:0A:DE:79')).toBe(1);   // wifi6
  });

  it('counts clients registered directly on a physical radio', () => {
    const counts = clientsPerRadio(interfaces, [{ interface: 'wifi1' }]);
    expect(counts.get('D0:EA:11:0A:DE:78')).toBe(1);
  });

  it('ignores registrations on an interface it cannot resolve', () => {
    expect(clientsPerRadio(interfaces, [{ interface: 'ghost' }]).size).toBe(0);
  });

  it('does not hang on a cyclic master-interface chain', () => {
    const cyclic: Record<string, string>[] = [
      { name: 'a', 'master-interface': 'b' },
      { name: 'b', 'master-interface': 'a' },
    ];
    expect(clientsPerRadio(cyclic, [{ interface: 'a' }]).size).toBe(0);
  });

  it('returns an empty map when nothing is connected', () => {
    expect(clientsPerRadio(interfaces, []).size).toBe(0);
  });
});

describe('lookupDeviceForMac — a remote radio never belongs to the controller (#94)', () => {
  it('refuses a prefix match against the excluded device', () => {
    const idx = buildMacIndex([{ device_id: 3, mac_address: 'AA:BB:CC:00:00:01' }]);
    expect(lookupDeviceForMac('AA:BB:CC:00:00:09', idx, 3)).toBeNull();
  });

  /**
   * The case that survived the first fix. A controller mirrors each CAP interface
   * locally, so the CAP's radio MAC is an *exact* match against the controller too.
   * Excluding only prefix matches left half a fleet's radios on the controller.
   */
  it('refuses an exact match against the excluded device', () => {
    const idx = buildMacIndex([{ device_id: 12, mac_address: '04:F4:1C:A2:C4:66' }]);
    expect(lookupDeviceForMac('04:F4:1C:A2:C4:66', idx, 12)).toBeNull();
  });

  it('picks the real access point when both it and the controller carry the MAC', () => {
    // Exactly the shape reported: the controller mirrors the CAP's interface, so
    // both devices index the same radio MAC.
    const idx = buildMacIndex([
      { device_id: 12, mac_address: '04:F4:1C:A2:C4:66' },   // controller's mirror
      { device_id: 22, mac_address: '04:F4:1C:A2:C4:66' },   // the CAP itself
    ]);
    expect(lookupDeviceForMac('04:F4:1C:A2:C4:66', idx, 12)).toBe(22);
  });

  it('is order-independent — the CAP wins whichever row was indexed first', () => {
    const idx = buildMacIndex([
      { device_id: 22, mac_address: '04:F4:1C:A2:C4:66' },
      { device_id: 12, mac_address: '04:F4:1C:A2:C4:66' },
    ]);
    expect(lookupDeviceForMac('04:F4:1C:A2:C4:66', idx, 12)).toBe(22);
  });

  it('still prefix-matches a different device', () => {
    const idx = buildMacIndex([{ device_id: 7, mac_address: 'AA:BB:CC:00:00:01' }]);
    expect(lookupDeviceForMac('AA:BB:CC:00:00:09', idx, 3)).toBe(7);
  });

  it('prefers an exact match over a prefix match', () => {
    const idx = buildMacIndex([
      { device_id: 7, mac_address: 'AA:BB:CC:00:00:01' },
      { device_id: 9, mac_address: 'AA:BB:CC:00:00:09' },
    ]);
    expect(lookupDeviceForMac('AA:BB:CC:00:00:09', idx)).toBe(9);
  });
});

/**
 * The reporter's fleet: a router acting purely as controller, mirroring six CAP
 * interfaces. Before the fix these resolved to the controller or the CAP depending
 * on database row order, so the same AP appeared in both places between polls.
 */
describe('matchRadiosToDevices — controller mirrors (#94 field report)', () => {
  const CONTROLLER = 12;
  const index = buildMacIndex([
    { device_id: CONTROLLER, mac_address: '04:F4:1C:A2:C4:65' },   // mirrors
    { device_id: CONTROLLER, mac_address: '04:F4:1C:A2:C4:66' },
    { device_id: 22, mac_address: '04:F4:1C:A2:C4:65' },           // bathroom AP
    { device_id: 22, mac_address: '04:F4:1C:A2:C4:66' },
  ]);

  it('puts both radios of one AP on that AP, not the controller', () => {
    const radios = normalizeRadios([
      { 'radio-mac': '04:F4:1C:A2:C4:65', interface: 'wifi-legacy-bathroom-ap-001-main-5g', local: 'false' },
      { 'radio-mac': '04:F4:1C:A2:C4:66', interface: 'wifi-legacy-bathroom-ap-001-main-2g', local: 'false' },
    ]);
    expect(matchRadiosToDevices(radios, index, CONTROLLER).map((m) => m.deviceId)).toEqual([22, 22]);
  });

  it('still keeps a genuinely local radio on the controller', () => {
    const radios = normalizeRadios([{ 'radio-mac': 'FF:FF:FF:00:00:01', local: 'true' }]);
    expect(matchRadiosToDevices(radios, index, CONTROLLER)[0].deviceId).toBe(CONTROLLER);
  });

  it('leaves a CAP that is not in the fleet unattributed rather than on the controller', () => {
    const radios = normalizeRadios([{ 'radio-mac': '04:F4:1C:99:99:99', local: 'false' }]);
    expect(matchRadiosToDevices(radios, index, CONTROLLER)[0].deviceId).toBeNull();
  });
});

// ── Legacy CAPsMAN (#250), from the reporter's CHR and RB951 on 7.24.5 ───────

import { legacyManagerEnabled, legacyCapInterfaces, parseLegacyChannel, legacyRadios } from '../capsman';
import { legacyFixture } from '../__fixtures__/legacyCapsman';


describe('legacy CAPsMAN (#250)', () => {
  it('recognises an enabled controller and a CAP', () => {
    expect(legacyManagerEnabled(legacyFixture.manager)).toBe(true);
    expect(legacyManagerEnabled([{ enabled: 'false' }])).toBe(false);
    expect(legacyManagerEnabled(null)).toBe(false);
    expect(legacyCapInterfaces(legacyFixture.cap)).toEqual(['wlan1']);
    expect(legacyCapInterfaces([{ enabled: 'false', interfaces: 'wlan1' }])).toEqual([]);
  });

  it('splits the channel from the transmit power', () => {
    expect(parseLegacyChannel('2412/20/gn(30dBm)')).toEqual({ channel: '2412/20/gn', txPower: 30 });
    expect(parseLegacyChannel('5180/20-Ceee/ac')).toEqual({ channel: '5180/20-Ceee/ac', txPower: null });
    expect(parseLegacyChannel('')).toEqual({ channel: null, txPower: null });
  });

  it("reads the reporter's controller: one radio on BonusRoom with three clients", () => {
    const [r, ...rest] = legacyRadios(legacyFixture.interface, null, legacyFixture.remoteCap, null, legacyFixture.registrations);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      radioMac: 'D4:CA:6D:BB:0E:57', interfaceName: 'BonusRoom 2.4Ghz', state: 'running-ap',
      channel: '2412/20/gn', txPower: 30, registeredPeers: 3, authorizedPeers: 3,
      ssid: 'Laney Legacy', capIdentity: 'BonusRoom',
    });
  });

  it('takes the SSID from the named configuration when it was read', () => {
    const [r] = legacyRadios(legacyFixture.interface, null, null, [{ name: 'Laney Legacy 2.4Ghz', ssid: 'From Config' }], []);
    expect(r.ssid).toBe('From Config');
    expect(r.registeredPeers).toBe(0);
  });

  it('leaves the AP unnamed when two CAPs could own the radio', () => {
    const twin = { ...legacyFixture.remoteCap[0], identity: 'Twin', 'base-mac': 'D4:CA:6D:BB:0E:50' };
    const [r] = legacyRadios(legacyFixture.interface, null, [...legacyFixture.remoteCap, twin], null, null);
    expect(r.capIdentity).toBeNull();
    expect(r.registeredPeers).toBe(3); // from the interface when the table wasn't read
  });

  it('prefers /caps-man/radio for the AP, and counts clients on virtual APs toward their radio', () => {
    const virtual = { name: 'BonusRoom Guest', 'radio-mac': '', 'master-interface': 'BonusRoom 2.4Ghz' };
    const [r] = legacyRadios(
      [...legacyFixture.interface, virtual],
      [{ 'radio-mac': 'D4:CA:6D:BB:0E:57', 'remote-cap-identity': 'BonusRoom-radio' }],
      null, null,
      [...legacyFixture.registrations, { interface: 'BonusRoom Guest', 'mac-address': '00:11:22:33:44:55' }],
    );
    expect(r.capIdentity).toBe('BonusRoom-radio');
    expect(r.registeredPeers).toBe(4);
  });
});

describe('radios on any device type (hAP ac² added as a router)', () => {
  it('counts a standalone router as having radios, and a controller as wireless only', () => {
    expect(hasRadios({ device_type: 'router', wifi_role: 'standalone' })).toBe(true);
    expect(hasRadios({ device_type: 'router', wifi_role: 'controller' })).toBe(false);
    expect(hasRadios({ device_type: 'router', wifi_role: 'none' })).toBe(false);
    expect(hasRadios({ device_type: 'wireless_ap', wifi_role: null })).toBe(true);
    expect(wirelessDeviceSql('d')).toBe("(d.device_type = 'wireless_ap' OR d.wifi_role IN ('standalone','cap','controller_cap','controller'))");
  });
  it('calls a device standalone only when it lists radios', () => {
    expect(classifyWifiRole(null, null, true)).toBe('standalone');
    expect(classifyWifiRole(null, null, false)).toBe('none');
  });
});
