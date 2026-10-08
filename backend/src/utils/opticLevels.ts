/**
 * Optic light levels (digital diagnostics, DDM) per SFP/QSFP port.
 *
 * Receive power that drifts down is often the first sign of a failing optic,
 * a dirty connector or a damaged fibre, well before frames start failing. What
 * counts as "low" depends on the optic type and the link budget, so a port is
 * compared with its own usual level (the median of the past week) rather than
 * with a fixed number. Pure, so it can be tested without a device.
 *
 * RouterOS reports these in /interface/ethernet/monitor: the API gives bare
 * numbers ("-5.22"), the terminal adds units ("-5.22dBm"). A QSFP may give one
 * value per lane; the weakest lane is the one that matters. Copper DAC cables
 * and modules without diagnostics have none of these fields and are skipped.
 */

export interface OpticReading {
  /** Receive power, dBm: the weakest lane on a multi-lane module. */
  rx_dbm: number | null;
  rx_lanes: number[];
  tx_dbm: number | null;
  temp_c: number | null;
  bias_ma: number | null;
  voltage: number | null;
}

/** Below this the receiver sees no light at all (RouterOS reports about -40). */
export const NO_LIGHT_DBM = -30;
/** Commercial-grade optics are rated to a 70 °C case temperature. */
export const HOT_C = 70;
/** Above this, airflow is likely poor or a fan has failed (#249); laser aging speeds up. */
export const WARM_C = 60;

/**
 * Optional fixed receive limits (#249), off unless set: below `rxLow` the
 * signal nears the receiver's sensitivity, above `rxHigh` it nears saturation.
 * Off by default because the right values depend on the optic: a 10G LR link
 * runs happily at -12 dBm, far below a 100G optic's floor.
 */
export interface RxLimits { rxLow: number | null; rxHigh: number | null }
export const DEFAULT_DROP_DB = 3;
/** The usual level needs this many readings (5-minute slow polls) to count. */
export const MIN_BASELINE_READINGS = 24;

/** Every number in a value: "-2.1dBm,-2.3dBm" or "-2.1 -2.3" or "33C". */
function numbers(v: string | undefined): number[] {
  if (!v) return [];
  return v.split(/[,;\s]+/).map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
}

const first = (v: string | undefined): number | null => numbers(v)[0] ?? null;

/**
 * A diagnostics field under either name. MikroTik's manual shows `sfp-rx-power`;
 * a CRS520-4XS-16XQ on 7.24.5 reports a QSFP28 optic's as plain `rx-power`
 * (#249). Read whichever is there.
 */
const ddm = (mon: Record<string, string>, field: string): string | undefined => mon[`sfp-${field}`] ?? mon[field];

/** The reading in a monitor row, or null when the module reports no diagnostics. */
export function readOptic(mon: Record<string, string>): OpticReading | null {
  if (mon['sfp-module-present'] !== undefined && !['true', 'yes'].includes(mon['sfp-module-present'])) return null;
  const rxLanes = numbers(ddm(mon, 'rx-power'));
  const txLanes = numbers(ddm(mon, 'tx-power'));
  if (rxLanes.length === 0 && txLanes.length === 0) return null;
  return {
    rx_dbm: rxLanes.length ? Math.min(...rxLanes) : null,
    rx_lanes: rxLanes.length > 1 ? rxLanes : [],
    tx_dbm: txLanes.length ? Math.min(...txLanes) : null,
    temp_c: first(ddm(mon, 'temperature')),
    bias_ma: first(ddm(mon, 'tx-bias-current')),
    voltage: first(ddm(mon, 'supply-voltage')),
  };
}

export interface OpticStatus {
  interface: string;
  rx_dbm: number | null;
  tx_dbm: number | null;
  temp_c: number | null;
  bias_ma: number | null;
  voltage: number | null;
  rx_lanes: number[];
  /** Median of the past week, before the last hour; null until there's enough history. */
  usual_rx_dbm: number | null;
  usual_tx_dbm: number | null;
  /** How far from its usual level, in dB: positive weaker, negative stronger. */
  rx_drop_db: number | null;
  tx_drop_db: number | null;
  /** 'alert': at or past the threshold, or too hot. 'watch': halfway there. */
  state: 'alert' | 'watch' | null;
  /** Why, in a few words, when state is set. */
  reason: string | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface Usual { rx: number | null; tx: number | null; readings: number }

/**
 * A port's state from its latest reading and its usual level. No light at all
 * is left to the link-down and flapping checks: the link is down, which is
 * already reported.
 */
export function opticStatus(
  name: string, cur: OpticReading, usual: Usual | null, dropDb = DEFAULT_DROP_DB,
  limits: RxLimits = { rxLow: null, rxHigh: null },
): OpticStatus {
  const threshold = Math.max(0.5, dropDb);
  const enough = !!usual && usual.readings >= MIN_BASELINE_READINGS;
  const lit = cur.rx_dbm !== null && cur.rx_dbm > NO_LIGHT_DBM;
  // Positive: weaker than usual; negative: stronger. Both count (#249): light
  // that rises can mean a failing sensor, reflection off a damaged end face,
  // or the optic's power control misbehaving.
  const rxDrop = enough && lit && usual!.rx !== null ? round1(usual!.rx - cur.rx_dbm!) : null;
  const txDrop = enough && cur.tx_dbm !== null && usual!.tx !== null && cur.tx_dbm > NO_LIGHT_DBM
    ? round1(usual!.tx - cur.tx_dbm) : null;

  const reasons: string[] = [];
  let level = 0; // 0 quiet, 1 watch, 2 alert
  const raise = (to: 1 | 2, why: string) => { level = Math.max(level, to); reasons.push(why); };
  const consider = (shift: number | null, what: string) => {
    if (shift === null || shift === 0) return;
    const size = Math.abs(shift);
    const why = `${what} ${size} dB ${shift > 0 ? 'below' : 'above'} its usual level`;
    if (size >= threshold) raise(2, why);
    else if (size >= threshold / 2) raise(1, why);
  };
  consider(rxDrop, 'receive light');
  consider(txDrop, 'transmit light');
  if (lit && limits.rxLow !== null && cur.rx_dbm! < limits.rxLow) raise(2, `receive light ${round1(cur.rx_dbm!)} dBm, under the ${limits.rxLow} dBm limit`);
  if (lit && limits.rxHigh !== null && cur.rx_dbm! > limits.rxHigh) raise(2, `receive light ${round1(cur.rx_dbm!)} dBm, over the ${limits.rxHigh} dBm limit`);
  if (cur.temp_c !== null && cur.temp_c >= HOT_C) raise(2, `module at ${cur.temp_c} °C`);
  else if (cur.temp_c !== null && cur.temp_c >= WARM_C) raise(1, `module at ${cur.temp_c} °C`);
  const state: OpticStatus['state'] = level === 2 ? 'alert' : level === 1 ? 'watch' : null;

  return {
    interface: name,
    rx_dbm: cur.rx_dbm, tx_dbm: cur.tx_dbm, temp_c: cur.temp_c, bias_ma: cur.bias_ma, voltage: cur.voltage,
    rx_lanes: cur.rx_lanes,
    usual_rx_dbm: enough && usual!.rx !== null ? round1(usual!.rx) : null,
    usual_tx_dbm: enough && usual!.tx !== null ? round1(usual!.tx) : null,
    rx_drop_db: rxDrop, tx_drop_db: txDrop,
    state,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}
