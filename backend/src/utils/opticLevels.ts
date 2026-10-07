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
export const DEFAULT_DROP_DB = 3;
/** The usual level needs this many readings (5-minute slow polls) to count. */
export const MIN_BASELINE_READINGS = 24;

/** Every number in a value: "-2.1dBm,-2.3dBm" or "-2.1 -2.3" or "33C". */
function numbers(v: string | undefined): number[] {
  if (!v) return [];
  return v.split(/[,;\s]+/).map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
}

const first = (v: string | undefined): number | null => numbers(v)[0] ?? null;

/** The reading in a monitor row, or null when the module reports no diagnostics. */
export function readOptic(mon: Record<string, string>): OpticReading | null {
  if (mon['sfp-module-present'] !== undefined && !['true', 'yes'].includes(mon['sfp-module-present'])) return null;
  const rxLanes = numbers(mon['sfp-rx-power']);
  const txLanes = numbers(mon['sfp-tx-power']);
  if (rxLanes.length === 0 && txLanes.length === 0) return null;
  return {
    rx_dbm: rxLanes.length ? Math.min(...rxLanes) : null,
    rx_lanes: rxLanes.length > 1 ? rxLanes : [],
    tx_dbm: txLanes.length ? Math.min(...txLanes) : null,
    temp_c: first(mon['sfp-temperature']),
    bias_ma: first(mon['sfp-tx-bias-current']),
    voltage: first(mon['sfp-supply-voltage']),
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
  /** How far below its usual level, in dB (positive = weaker). */
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
): OpticStatus {
  const threshold = Math.max(0.5, dropDb);
  const enough = !!usual && usual.readings >= MIN_BASELINE_READINGS;
  const lit = cur.rx_dbm !== null && cur.rx_dbm > NO_LIGHT_DBM;
  const rxDrop = enough && lit && usual!.rx !== null ? round1(usual!.rx - cur.rx_dbm!) : null;
  const txDrop = enough && cur.tx_dbm !== null && usual!.tx !== null && cur.tx_dbm > NO_LIGHT_DBM
    ? round1(usual!.tx - cur.tx_dbm) : null;
  const hot = cur.temp_c !== null && cur.temp_c >= HOT_C;

  const reasons: string[] = [];
  let state: OpticStatus['state'] = null;
  const consider = (drop: number | null, what: string) => {
    if (drop === null) return;
    if (drop >= threshold) { state = 'alert'; reasons.push(`${what} ${drop} dB below its usual level`); }
    else if (drop >= threshold / 2) { if (!state) state = 'watch'; reasons.push(`${what} ${drop} dB below its usual level`); }
  };
  consider(rxDrop, 'receive light');
  consider(txDrop, 'transmit light');
  if (hot) { state = 'alert'; reasons.push(`module at ${cur.temp_c} °C`); }

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
