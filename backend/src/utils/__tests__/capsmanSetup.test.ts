import {
  parseCapsmanSetup, planCapsman, defaultFlavor, capIsLocal, ruleBand, MTM_CAPSMAN, MTM_CAPSMAN_COMMENT, type CapsmanLive,
  MTM_CAPSMAN_5G, MTM_CAPSMAN_5G_COMMENT,
} from '../capsmanSetup';

const live = (over: Partial<CapsmanLive> = {}): CapsmanLive => ({
  flavor: 'wifi', bridges: ['bridge'], configurations: [], provisioning: [],
  manager: { enabled: 'false' }, cap: { enabled: 'false', 'caps-man-addresses': '' }, radios: ['wifi1', 'wifi2'], ...over,
});
const body = { ssid: 'Office', passphrase: 'correct horse', bridge: 'bridge', localRadios: false };
// Legacy only: a wifi controller can't serve its own radios (#438).
const local = { ...body, localRadios: true };
const input = (l: CapsmanLive, b: Record<string, unknown> = body) => {
  const r = parseCapsmanSetup(b, l);
  if ('error' in r) throw new Error(r.error);
  return r.input;
};

describe('CAPsMAN quick set (#438)', () => {
  it('sets up a wifi controller', () => {
    const l = live();
    const { steps } = planCapsman(input(l), l);
    expect(steps.map((s) => s.command)).toEqual([
      '/interface/wifi/configuration/add', '/interface/wifi/provisioning/add', '/interface/wifi/capsman/set',
    ]);
    expect(steps[0].params).toEqual({
      name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk',
      'security.passphrase': 'correct horse', 'datapath.bridge': 'bridge',
    });
    expect(steps[1].params).toEqual({ action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT });
    expect(steps[2].params).toEqual({ enabled: 'yes' });
  });

  it('refuses Controller and AP on wifi: its own CAP can\'t serve its radios, and the other way wipes them', () => {
    const r = parseCapsmanSetup(local, live());
    expect('error' in r && r.error).toMatch(/can't serve its own radios/);
  });

  it('sets up a legacy controller, handing its wlans to its own CAP', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1', 'wlan2'] });
    const { steps } = planCapsman(input(l, { ...local, country: 'Netherlands' }), l);
    expect(steps.map((s) => s.command)).toEqual([
      '/caps-man/configuration/add', '/caps-man/provisioning/add', '/caps-man/manager/set', '/interface/wireless/cap/set',
    ]);
    expect(steps[0].params).toMatchObject({
      mode: 'ap', 'security.authentication-types': 'wpa2-psk', 'security.encryption': 'aes-ccm',
      'datapath.local-forwarding': 'yes', country: 'netherlands',
    });
    expect(steps[3].params).toEqual({ enabled: 'yes', 'caps-man-addresses': '127.0.0.1', interfaces: 'wlan1,wlan2', bridge: 'bridge' });
  });

  it('updates what an earlier run left, keeping the password when none is given', () => {
    const l = live({
      configurations: [{ '.id': '*1', name: MTM_CAPSMAN, ssid: 'Old' }],
      provisioning: [{ '.id': '*2', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, disabled: 'false' }],
      manager: { enabled: 'true' },
    });
    const { steps, warnings } = planCapsman(input(l, { ...body, passphrase: '' }), l);
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toBe('/interface/wifi/configuration/set');
    expect(steps[0].params).not.toHaveProperty('security.passphrase');
    expect(steps[0].params['.id']).toBe('*1');
    expect(warnings).toEqual([]);
  });

  it('sends nothing when run again unchanged without a new password', () => {
    const l = live({
      configurations: [{ '.id': '*1', name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk', 'datapath.bridge': 'bridge' }],
      provisioning: [{ '.id': '*2', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, disabled: 'false' }],
      manager: { enabled: 'yes' },
    });
    expect(planCapsman(input(l, { ...body, passphrase: '' }), l).steps).toEqual([]);
    // A new password is always sent.
    expect(planCapsman(input(l), l).steps.map((s) => s.command)).toEqual(['/interface/wifi/configuration/set']);
  });

  it('turns its own CAP off when changed to controller only', () => {
    const l = live({ manager: { enabled: 'true' }, cap: { enabled: 'true', 'caps-man-addresses': '127.0.0.1' } });
    const { steps } = planCapsman(input(l, { ...body, localRadios: false }), l);
    expect(steps.at(-1)).toMatchObject({ command: '/interface/wifi/cap/set', params: { enabled: 'no' } });
  });

  it('warns about provisioning rules that come first and a CAP of another controller', () => {
    const l = live({
      flavor: 'legacy', radios: ['wlan1'],
      provisioning: [{ '.id': '*5', action: 'create-dynamic-enabled', 'master-configuration': 'theirs', disabled: 'false' }],
      cap: { enabled: 'true', 'caps-man-addresses': '10.0.0.1' },
    });
    const { warnings } = planCapsman(input(l, local), l);
    expect(warnings.join(' ')).toMatch(/a provisioning rule of its own/);
    expect(warnings.join(' ')).toMatch(/CAP of another controller/);
  });

  it('refuses what the UI refuses', () => {
    const l = live();
    const err = (b: Record<string, unknown>, x = l) => { const r = parseCapsmanSetup(b, x); return 'error' in r ? r.error : null; };
    expect(err({ ...body, ssid: '' })).toMatch(/SSID/);
    expect(err({ ...body, ssid: 'x'.repeat(33) })).toMatch(/32 bytes/);
    expect(err({ ...body, passphrase: 'short' })).toMatch(/8 to 63/);
    expect(err({ ...body, passphrase: '' })).toMatch(/password/);
    expect(err({ ...body, passphrase: 'a'.repeat(64) })).toBeNull();
    expect(err({ ...body, bridge: 'nope' })).toMatch(/isn't a bridge/);
    expect(err({ ...body, country: 'x;y' })).toMatch(/country/);
    expect(err(local, live({ flavor: 'legacy', radios: [] }))).toMatch(/Choose controller only/);
    expect(err({ ...body, localRadios: false }, live({ radios: [] }))).toBeNull();
  });

  it('offers the CAPsMAN the device\'s own radios use first', () => {
    expect(defaultFlavor(['wifi', 'legacy'], 'wireless')).toBe('legacy');
    expect(defaultFlavor(['wifi', 'legacy'], 'wifi')).toBe('wifi');
    expect(defaultFlavor(['legacy'], 'wifi')).toBe('legacy');
    expect(defaultFlavor([], 'wifi')).toBeNull();
    expect(capIsLocal({ enabled: 'true', 'caps-man-addresses': '10.0.0.1,127.0.0.1' })).toBe(true);
    expect(capIsLocal({ enabled: 'false', 'caps-man-addresses': '127.0.0.1' })).toBe(false);
  });
});

describe('one band only (Ron, #438)', () => {
  const theirs = { '.id': '*1', action: 'create-dynamic-enabled', 'master-configuration': 'home', disabled: 'false' };

  it('provisions only 5 GHz radios, ahead of the rules already there', () => {
    const l = live({ provisioning: [theirs] });
    const { steps, warnings } = planCapsman(input(l, { ...body, band: '5ghz' }), l);
    expect(steps[1]).toMatchObject({
      command: '/interface/wifi/provisioning/add',
      params: { 'supported-bands': '5ghz-a,5ghz-ac,5ghz-ax,5ghz-n', 'place-before': '*1' },
    });
    expect(warnings.join(' ')).toMatch(/5 GHz radios take Office, and the other band's radios keep matching it/);
  });

  it('matches legacy radios by their hardware modes', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1'], radioBands: { wlan1: '2ghz' } });
    const { steps } = planCapsman(input(l, { ...local, band: '2ghz' }), l);
    expect(steps[1].params).toMatchObject({ 'hw-supported-modes': 'b,g,gn' });
    expect(steps[1].params).not.toHaveProperty('place-before');   // nothing to go before
  });

  it('hands a legacy controller only the chosen band\'s radios, so the other keeps its own SSID (Ron, #438)', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1', 'wlan2'], radioBands: { wlan1: '2ghz', wlan2: '5ghz' } });
    const { steps, warnings } = planCapsman(input(l, { ...local, band: '5ghz' }), l);
    expect(steps.find((s) => s.command === '/interface/wireless/cap/set')!.params).toMatchObject({ interfaces: 'wlan2' });
    expect(warnings.join(' ')).toMatch(/5 GHz radio \(wlan2\) switches to Office/);
    expect(warnings.join(' ')).toMatch(/wlan1 keeps its own settings/);
    // Both bands again: both radios join.
    const both = planCapsman(input(l, { ...local, band: 'both' }), l).steps;
    expect(both.find((s) => s.command === '/interface/wireless/cap/set')!.params).toMatchObject({ interfaces: 'wlan1,wlan2' });
  });

  it('moves an existing legacy setup off the other band\'s radio', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1', 'wlan2'], radioBands: { wlan1: '2ghz', wlan2: '5ghz' },
      cap: { enabled: 'true', 'caps-man-addresses': '127.0.0.1', interfaces: 'wlan1,wlan2', bridge: 'bridge' } });
    const { steps } = planCapsman(input(l, { ...local, band: '5ghz' }), l);
    expect(steps.find((s) => s.command === '/interface/wireless/cap/set')!.params).toMatchObject({ interfaces: 'wlan2' });
  });

  it('refuses one band when the device has no radio of it', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1'], radioBands: { wlan1: '2ghz' } });
    const r = parseCapsmanSetup({ ...local, band: '5ghz' }, l);
    expect('error' in r && r.error).toMatch(/no 5 GHz radio/);
  });

  it('changes an earlier rule\'s band, moves it first, and takes the band off again', () => {
    const ours = { '.id': '*2', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, disabled: 'false' };
    const configured = { configurations: [{ '.id': '*9', name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk', 'datapath.bridge': 'bridge' }],
      manager: { enabled: 'true' } };
    let l = live({ ...configured, provisioning: [theirs, ours] });
    let steps = planCapsman(input(l, { ...body, passphrase: '', band: '5ghz' }), l).steps;
    expect(steps.map((s) => s.command)).toEqual(['/interface/wifi/provisioning/set', '/interface/wifi/provisioning/move']);
    expect(steps[1].params).toEqual({ numbers: '*2', destination: '*1' });

    // Already 5 GHz and first (RouterOS may list the bands its own way): nothing to do.
    l = live({ ...configured, provisioning: [{ ...ours, 'supported-bands': '5ghz-ax,5ghz-ac,5ghz-n,5ghz-a' }, theirs] });
    expect(planCapsman(input(l, { ...body, passphrase: '', band: '5ghz' }), l).steps).toEqual([]);

    // Both bands again: the match is unset, not set empty.
    steps = planCapsman(input(l, { ...body, passphrase: '', band: 'both' }), l).steps;
    expect(steps).toEqual([expect.objectContaining({ command: '/interface/wifi/provisioning/unset', params: { numbers: '*2', 'value-name': 'supported-bands' } })]);
  });

  it('reads the band back from a rule', () => {
    expect(ruleBand('wifi', { 'supported-bands': '2ghz-ax,2ghz-be,2ghz-g,2ghz-n' })).toBe('2ghz');
    expect(ruleBand('wifi', { 'supported-bands': '5ghz-ax' })).toBe('5ghz');
    expect(ruleBand('wifi', {})).toBe('both');
    expect(ruleBand('legacy', { 'hw-supported-modes': 'a,an,ac' })).toBe('5ghz');
    expect(ruleBand('legacy', { 'hw-supported-modes': 'gn,ac' })).toBe('both');
  });
});

describe('a 5 GHz SSID of its own (Ron, #438)', () => {
  const theirs = { '.id': '*1', action: 'create-dynamic-enabled', 'master-configuration': 'home', disabled: 'false' };

  it('adds a configuration and rule per band, both ahead of the device\'s own rules', () => {
    const l = live({ provisioning: [theirs] });
    const { steps, warnings } = planCapsman(input(l, { ...body, ssid5: 'Office-5G' }), l);
    expect(steps.map((s) => s.command)).toEqual([
      '/interface/wifi/configuration/add', '/interface/wifi/configuration/add',
      '/interface/wifi/provisioning/add', '/interface/wifi/provisioning/add',
      '/interface/wifi/capsman/set',
    ]);
    expect(steps[0].params).toMatchObject({ name: MTM_CAPSMAN, ssid: 'Office' });
    expect(steps[1].params).toMatchObject({ name: MTM_CAPSMAN_5G, ssid: 'Office-5G', 'security.passphrase': 'correct horse' });
    expect(steps[2].params).toMatchObject({ 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, 'supported-bands': '2ghz-ax,2ghz-g,2ghz-n', 'place-before': '*1' });
    expect(steps[3].params).toMatchObject({ 'master-configuration': MTM_CAPSMAN_5G, comment: MTM_CAPSMAN_5G_COMMENT, 'supported-bands': '5ghz-a,5ghz-ac,5ghz-ax,5ghz-n', 'place-before': '*1' });
    expect(warnings.join(' ')).toMatch(/2.4 GHz radios take Office and 5 GHz radios take Office-5G/);
  });

  it('works on legacy too', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1', 'wlan2'], radioBands: { wlan1: '2ghz', wlan2: '5ghz' } });
    const { steps } = planCapsman(input(l, { ...local, ssid5: 'Office-5G' }), l);
    expect(steps.filter((s) => s.command === '/caps-man/provisioning/add').map((s) => s.params['hw-supported-modes'])).toEqual(['b,g,gn', 'a,an,ac']);
    // Both bands: both wlans join.
    expect(steps.find((s) => s.command === '/interface/wireless/cap/set')!.params).toMatchObject({ interfaces: 'wlan1,wlan2' });
  });

  const configured = {
    manager: { enabled: 'true' },
    configurations: [
      { '.id': '*a', name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk', 'datapath.bridge': 'bridge' },
      { '.id': '*b', name: MTM_CAPSMAN_5G, ssid: 'Office-5G', 'security.authentication-types': 'wpa2-psk,wpa3-psk', 'datapath.bridge': 'bridge' },
    ],
    provisioning: [
      { '.id': '*2', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, 'supported-bands': '2ghz-ax,2ghz-g,2ghz-n', disabled: 'false' },
      { '.id': '*3', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN_5G, comment: MTM_CAPSMAN_5G_COMMENT, 'supported-bands': '5ghz-a,5ghz-ac,5ghz-ax,5ghz-n', disabled: 'false' },
    ],
  };

  it('sends nothing when run again unchanged, and renames only the 5 GHz SSID', () => {
    const l = live(configured);
    expect(planCapsman(input(l, { ...body, passphrase: '', ssid5: 'Office-5G' }), l).steps).toEqual([]);
    const { steps } = planCapsman(input(l, { ...body, passphrase: '', ssid5: 'Office-Fast' }), l);
    expect(steps).toEqual([expect.objectContaining({ command: '/interface/wifi/configuration/set', params: expect.objectContaining({ '.id': '*b', ssid: 'Office-Fast' }) })]);
  });

  it('goes back to one SSID: the first rule takes every radio and the 5 GHz pair is removed, rule first', () => {
    const l = live(configured);
    const { steps } = planCapsman(input(l, { ...body, passphrase: '' }), l);
    expect(steps.map((s) => [s.command, s.params['.id'] ?? s.params.numbers])).toEqual([
      ['/interface/wifi/provisioning/unset', '*2'],
      ['/interface/wifi/provisioning/remove', '*3'],
      ['/interface/wifi/configuration/remove', '*b'],
    ]);
    // One band only removes it too.
    const one = planCapsman(input(l, { ...body, passphrase: '', band: '5ghz', ssid5: 'ignored' }), l).steps;
    expect(one.map((s) => s.command)).toContain('/interface/wifi/provisioning/remove');
  });

  it('treats the same name as one SSID, and asks for the password for a new 5 GHz SSID', () => {
    const l = live({ ...configured, configurations: [configured.configurations[0]], provisioning: [configured.provisioning[0]] });
    expect(input(l, { ...body, ssid5: 'Office' })).not.toHaveProperty('ssid5');
    const r = parseCapsmanSetup({ ...body, passphrase: '', ssid5: 'Office-5G' }, l);
    expect('error' in r && r.error).toMatch(/password/);
    const bad = parseCapsmanSetup({ ...body, ssid5: 'x'.repeat(33) }, l);
    expect('error' in bad && bad.error).toMatch(/5 GHz SSID/);
  });
});
