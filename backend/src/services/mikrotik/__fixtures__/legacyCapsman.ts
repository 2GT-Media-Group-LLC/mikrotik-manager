/**
 * Legacy CAPsMAN as the #250 reporter's setup returns it: a CHR controller and
 * an RB951Ui-2HnD CAP, both on RouterOS 7.24.5. Shaped as API rows (the field
 * names are the ones `print detail` showed).
 */
export const legacyFixture = {
  manager: [{ enabled: 'true', certificate: 'auto', 'package-path': '/capsman-routeros', 'upgrade-policy': 'suggest-same-version' }],
  remoteCap: [{ '.id': '*1', state: 'Run', name: 'CAP-D4CA6DBB0E52', radios: '1', address: '10.22.87.11/60383', board: 'RB951Ui-2HnD', serial: '45880299FB40', 'base-mac': 'D4:CA:6D:BB:0E:52', version: '7.24.5', identity: 'BonusRoom' }],
  interface: [{
    '.id': '*1', name: 'BonusRoom 2.4Ghz', 'mac-address': 'D4:CA:6D:BB:0E:57', 'radio-mac': 'D4:CA:6D:BB:0E:57',
    'master-interface': 'none', 'radio-name': 'D4CA6DBB0E57', configuration: 'Laney Legacy 2.4Ghz', 'l2mtu': '1600',
    'current-state': 'running-ap', 'current-channel': '2412/20/gn(30dBm)',
    'current-registered-clients': '3', 'current-authorized-clients': '3', master: 'true', bound: 'true', running: 'true',
  }],
  registrations: [
    { '.id': '*1', comment: 'BonusRoom FireTV Stick 4k Max', interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': '9C:C8:E9:53:BA:F0', 'eap-identity': '' },
    { '.id': '*2', comment: 'Brother Printer', interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': 'AC:D1:B8:78:52:BD', 'eap-identity': '' },
    { '.id': '*3', comment: "Matt's iPhone 15", interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': '38:9C:B2:3D:9B:19', 'eap-identity': '' },
  ],
  /** `/caps-man registration-table print stats`, as the reporter sent it (last-ip masked by them). */
  registrationsStats: [
    { '.id': '*1', comment: 'BonusRoom FireTV Stick 4k Max', interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': '9C:C8:E9:53:BA:F0', 'tx-rate': '130Mbps-20MHz/2S', 'rx-rate': '1Mbps', 'rx-signal': '-70', uptime: '2h29m56s240ms', packets: '143496,103425', bytes: '150684303,19365193', 'last-ip': '110.87.22.10' },
    { '.id': '*2', comment: 'Brother Printer', interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': 'AC:D1:B8:78:52:BD', 'tx-rate': '72.2Mbps-20MHz/1S/SGI', 'rx-rate': '39Mbps-20MHz/1S', 'rx-signal': '-62', uptime: '2h29m56s20ms', packets: '5427,9394', bytes: '614324,6763258', 'last-ip': '147.87.22.10' },
    { '.id': '*3', comment: "Matt's iPhone 15", interface: 'BonusRoom 2.4Ghz', ssid: 'Laney Legacy', 'mac-address': '38:9C:B2:3D:9B:19', 'tx-rate': '144.4Mbps-20MHz/2S/SGI', 'rx-rate': '1Mbps', 'rx-signal': '-64', uptime: '32m4s380ms', packets: '3200,2934', bytes: '2170576,1321015', 'last-ip': '120.87.22.10' },
  ],
  cap: [{ enabled: 'true', interfaces: 'wlan1', certificate: 'request', 'lock-to-caps-man': 'false', 'caps-man-addresses': '10.22.87.108', bridge: 'lan_bridge' }],
};
