import {
  parseCapsmanSetup, planCapsman, defaultFlavor, capIsLocal, ruleBand, MTM_CAPSMAN, MTM_CAPSMAN_COMMENT, type CapsmanLive,
} from '../capsmanSetup';

const live = (over: Partial<CapsmanLive> = {}): CapsmanLive => ({
  flavor: 'wifi', bridges: ['bridge'], configurations: [], provisioning: [],
  manager: { enabled: 'false' }, cap: { enabled: 'false', 'caps-man-addresses': '' }, radios: ['wifi1', 'wifi2'], ...over,
});
const body = { ssid: 'Office', passphrase: 'correct horse', bridge: 'bridge', localRadios: true };
const input = (l: CapsmanLive, b: Record<string, unknown> = body) => {
  const r = parseCapsmanSetup(b, l);
  if ('error' in r) throw new Error(r.error);
  return r.input;
};

describe('CAPsMAN quick set (#438)', () => {
  it('sets up a wifi controller that serves its own radios', () => {
    const l = live();
    const { steps, warnings } = planCapsman(input(l), l);
    expect(steps.map((s) => s.command)).toEqual([
      '/interface/wifi/configuration/add', '/interface/wifi/provisioning/add', '/interface/wifi/capsman/set', '/interface/wifi/cap/set',
    ]);
    expect(steps[0].params).toEqual({
      name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk',
      'security.passphrase': 'correct horse', 'datapath.bridge': 'bridge',
    });
    expect(steps[1].params).toEqual({ action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT });
    expect(steps[2].params).toEqual({ enabled: 'yes' });
    expect(steps[3].params).toEqual({ enabled: 'yes', 'caps-man-addresses': '127.0.0.1' });
    expect(warnings.join(' ')).toMatch(/wifi1, wifi2\) switch to Office/);
  });

  it('sets up a legacy controller, handing its wlans to its own CAP', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1', 'wlan2'] });
    const { steps } = planCapsman(input(l, { ...body, country: 'Netherlands' }), l);
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
      cap: { enabled: 'true', 'caps-man-addresses': '127.0.0.1' },
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
      cap: { enabled: 'yes', 'caps-man-addresses': '127.0.0.1' },
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
      provisioning: [{ '.id': '*5', action: 'create-dynamic-enabled', 'master-configuration': 'theirs', disabled: 'false' }],
      cap: { enabled: 'true', 'caps-man-addresses': '10.0.0.1' },
    });
    const { warnings } = planCapsman(input(l), l);
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
    expect(err(body, live({ radios: [] }))).toMatch(/Choose controller only/);
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
    expect(warnings.join(' ')).toMatch(/Its own 5 GHz radios switch to Office/);
  });

  it('matches legacy radios by their hardware modes', () => {
    const l = live({ flavor: 'legacy', radios: ['wlan1'] });
    const { steps } = planCapsman(input(l, { ...body, band: '2ghz' }), l);
    expect(steps[1].params).toMatchObject({ 'hw-supported-modes': 'b,g,gn' });
    expect(steps[1].params).not.toHaveProperty('place-before');   // nothing to go before
  });

  it('changes an earlier rule\'s band, moves it first, and takes the band off again', () => {
    const ours = { '.id': '*2', action: 'create-dynamic-enabled', 'master-configuration': MTM_CAPSMAN, comment: MTM_CAPSMAN_COMMENT, disabled: 'false' };
    const configured = { configurations: [{ '.id': '*9', name: MTM_CAPSMAN, ssid: 'Office', 'security.authentication-types': 'wpa2-psk,wpa3-psk', 'datapath.bridge': 'bridge' }],
      manager: { enabled: 'true' }, cap: { enabled: 'true', 'caps-man-addresses': '127.0.0.1' } };
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
