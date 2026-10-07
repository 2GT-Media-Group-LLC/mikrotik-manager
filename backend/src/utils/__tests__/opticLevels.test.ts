import { readOptic, opticStatus, MIN_BASELINE_READINGS } from '../opticLevels';

describe('readOptic', () => {
  it('reads the API form (bare numbers)', () => {
    expect(readOptic({ 'sfp-module-present': 'true', 'sfp-rx-power': '-5.22', 'sfp-tx-power': '-5.792', 'sfp-temperature': '33', 'sfp-tx-bias-current': '2', 'sfp-supply-voltage': '3.237' }))
      .toEqual({ rx_dbm: -5.22, rx_lanes: [], tx_dbm: -5.792, temp_c: 33, bias_ma: 2, voltage: 3.237 });
  });

  it('reads the terminal form (with units), as in the MikroTik manual', () => {
    expect(readOptic({ 'sfp-module-present': 'yes', 'sfp-rx-power': '-5.22dBm', 'sfp-tx-power': '-5.792dBm', 'sfp-temperature': '33C', 'sfp-supply-voltage': '3.237V', 'sfp-tx-bias-current': '2mA' }))
      .toMatchObject({ rx_dbm: -5.22, tx_dbm: -5.792, temp_c: 33, voltage: 3.237, bias_ma: 2 });
  });

  it("reads a CRS520's QSFP28 optic, which drops the sfp- prefix (#249, 7.24.5)", () => {
    expect(readOptic({
      name: 'qsfp28-2-1', status: 'link-ok', rate: '100Gbps', 'full-duplex': 'yes',
      temperature: '41C', 'supply-voltage': '3.300V', 'tx-bias-current': '51mA', 'tx-power': '0.395dBm', 'rx-power': '-4.417dBm',
    })).toEqual({ rx_dbm: -4.417, rx_lanes: [], tx_dbm: 0.395, temp_c: 41, bias_ma: 51, voltage: 3.3 });
  });

  it('takes the weakest lane of a multi-lane module and keeps the lanes', () => {
    const r = readOptic({ 'sfp-module-present': 'true', 'sfp-rx-power': '-1.2dBm,-4.8dBm,-1.1dBm,-1.3dBm', 'sfp-tx-power': '-0.5 -0.7 -0.4 -0.6' });
    expect(r).toMatchObject({ rx_dbm: -4.8, rx_lanes: [-1.2, -4.8, -1.1, -1.3], tx_dbm: -0.7 });
  });

  it('skips copper DAC cables and empty cages (captured from a CRS518 and a CRS309)', () => {
    expect(readOptic({ name: 'sfp28-2', status: 'link-ok', 'sfp-module-present': 'true', 'sfp-connector-type': 'copper-pigtail', 'sfp-vendor-part-number': 'XS+DA0001' })).toBeNull();
    expect(readOptic({ name: 'sfp-sfpplus2', status: 'no-link', 'sfp-module-present': 'false' })).toBeNull();
  });
});

describe('opticStatus', () => {
  const cur = (rx: number | null, tx: number | null = -2, temp: number | null = 40) =>
    ({ rx_dbm: rx, rx_lanes: [], tx_dbm: tx, temp_c: temp, bias_ma: 6, voltage: 3.3 });
  const usual = (rx: number, tx = -2, readings = MIN_BASELINE_READINGS) => ({ rx, tx, readings });

  it('alerts when receive light falls by the threshold', () => {
    const s = opticStatus('sfp28-1', cur(-8.6), usual(-5.1), 3);
    expect(s).toMatchObject({ rx_drop_db: 3.5, usual_rx_dbm: -5.1, state: 'alert' });
    expect(s.reason).toBe('receive light 3.5 dB below its usual level');
  });

  it('watches at half the threshold, and is quiet below that', () => {
    expect(opticStatus('p', cur(-6.8), usual(-5.1), 3).state).toBe('watch');
    expect(opticStatus('p', cur(-5.6), usual(-5.1), 3).state).toBeNull();
  });

  it('notices a weakening transmitter', () => {
    expect(opticStatus('p', cur(-5, -6), usual(-5, -2), 3)).toMatchObject({ tx_drop_db: 4, state: 'alert' });
  });

  it('does nothing until there is enough history', () => {
    const s = opticStatus('p', cur(-20), usual(-5, -2, MIN_BASELINE_READINGS - 1), 3);
    expect(s).toMatchObject({ state: null, rx_drop_db: null, usual_rx_dbm: null });
  });

  it('leaves no light at all to the link-down checks', () => {
    expect(opticStatus('p', cur(-40), usual(-5), 3).state).toBeNull();
  });

  it('alerts on a hot module even without history', () => {
    expect(opticStatus('p', cur(-5, -2, 72), null, 3)).toMatchObject({ state: 'alert', reason: 'module at 72 °C' });
  });
});
