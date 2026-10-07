/**
 * Optic light levels: stores each slow poll's readings, works out each port's
 * usual level, and alerts when a port falls well below it or runs hot.
 *
 * The slow poll already reads /interface/ethernet/monitor for the port list,
 * so this costs no extra call to the device. Only modules that report
 * diagnostics are stored (copper DAC cables have none). Readings are kept for
 * two weeks: one week for the usual level, and a week of margin.
 */
import { query } from '../config/database';
import { alertService } from './AlertService';
import { readOptic, opticStatus, DEFAULT_DROP_DB, HOT_C, type OpticStatus, type Usual } from '../utils/opticLevels';

/** Store one slow poll's readings. */
export async function recordOptics(deviceId: number, monitor: Map<string, Record<string, string>>): Promise<void> {
  for (const [name, row] of monitor) {
    const r = readOptic(row);
    if (!r) continue;
    await query(
      `INSERT INTO optic_readings (device_id, interface, rx_dbm, tx_dbm, temp_c, bias_ma, voltage, rx_lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [deviceId, name, r.rx_dbm, r.tx_dbm, r.temp_c, r.bias_ma, r.voltage, r.rx_lanes.length ? r.rx_lanes.join(',') : null],
    );
  }
}

export async function dropThreshold(): Promise<number> {
  const rule = await alertService.getRule('optic_degraded');
  return rule?.threshold && rule.threshold > 0 ? rule.threshold : DEFAULT_DROP_DB;
}

interface LatestRow {
  device_id: number; interface: string;
  rx_dbm: number | null; tx_dbm: number | null; temp_c: number | null; bias_ma: number | null; voltage: number | null;
  rx_lanes: string | null;
  usual_rx: number | null; usual_tx: number | null; readings: number;
}

/**
 * Latest reading per port (from the last 30 minutes, so a module that was
 * pulled drops out) and its usual level: the median over the past week,
 * leaving out the last hour so a fresh drop doesn't drag its own baseline.
 */
export async function opticStatuses(deviceIds?: number[]): Promise<Map<number, OpticStatus[]>> {
  const params: unknown[] = [];
  let scope = '';
  if (deviceIds) { params.push(deviceIds); scope = `AND device_id = ANY($1::int[])`; }
  const [rows, threshold] = await Promise.all([
    query<LatestRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (device_id, interface) device_id, interface, rx_dbm, tx_dbm, temp_c, bias_ma, voltage, rx_lanes
           FROM optic_readings
          WHERE at > NOW() - INTERVAL '30 minutes' ${scope}
          ORDER BY device_id, interface, at DESC
       ), usual AS (
         SELECT device_id, interface,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY rx_dbm) FILTER (WHERE rx_dbm > -30) AS usual_rx,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY tx_dbm) FILTER (WHERE tx_dbm > -30) AS usual_tx,
                COUNT(*)::int AS readings
           FROM optic_readings
          WHERE at > NOW() - INTERVAL '7 days' AND at < NOW() - INTERVAL '1 hour' ${scope}
          GROUP BY device_id, interface
       )
       SELECT l.*, u.usual_rx, u.usual_tx, COALESCE(u.readings, 0) AS readings
         FROM latest l LEFT JOIN usual u USING (device_id, interface)`,
      params,
    ),
    dropThreshold(),
  ]);
  const out = new Map<number, OpticStatus[]>();
  for (const r of rows) {
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const usual: Usual = { rx: n(r.usual_rx), tx: n(r.usual_tx), readings: Number(r.readings) || 0 };
    const status = opticStatus(r.interface, {
      rx_dbm: n(r.rx_dbm), tx_dbm: n(r.tx_dbm), temp_c: n(r.temp_c), bias_ma: n(r.bias_ma), voltage: n(r.voltage),
      rx_lanes: r.rx_lanes ? r.rx_lanes.split(',').map(Number) : [],
    }, usual, threshold);
    const list = out.get(r.device_id) ?? [];
    list.push(status);
    out.set(r.device_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.interface.localeCompare(b.interface, undefined, { numeric: true }));
  return out;
}

/** A port's readings over a period, for its chart. */
export async function opticHistory(deviceId: number, iface: string, days: number) {
  return query<{ at: string; rx_dbm: number | null; tx_dbm: number | null; temp_c: number | null }>(
    `SELECT at, rx_dbm, tx_dbm, temp_c FROM optic_readings
      WHERE device_id = $1 AND interface = $2 AND at > NOW() - make_interval(days => $3)
      ORDER BY at`,
    [deviceId, iface, days],
  );
}

/** Alert on ports past the threshold or running hot. Cooldown is per port. */
export async function checkOptics(): Promise<void> {
  const rule = await alertService.getRule('optic_degraded');
  if (!rule?.enabled) return;
  const [statuses, threshold] = await Promise.all([opticStatuses(), dropThreshold()]);
  const ids = [...statuses.keys()];
  if (ids.length === 0) return;
  const names = new Map(
    (await query<{ id: number; name: string }>(`SELECT id, name FROM devices WHERE id = ANY($1::int[])`, [ids]))
      .map((d) => [d.id, d.name.trim()]),
  );
  for (const [deviceId, ports] of statuses) {
    const deviceName = names.get(deviceId) ?? `device ${deviceId}`;
    for (const p of ports) {
      if (p.state !== 'alert') continue;
      const now = [
        p.rx_dbm !== null ? `receive ${p.rx_dbm} dBm${p.usual_rx_dbm !== null ? ` (usually ${p.usual_rx_dbm})` : ''}` : '',
        p.tx_dbm !== null ? `transmit ${p.tx_dbm} dBm${p.usual_tx_dbm !== null ? ` (usually ${p.usual_tx_dbm})` : ''}` : '',
      ].filter(Boolean).join(', ');
      const losingLight = (p.rx_drop_db ?? 0) >= threshold || (p.tx_drop_db ?? 0) >= threshold;
      const hot = p.temp_c !== null && p.temp_c >= HOT_C;
      const advice = [
        losingLight ? 'clean the connectors, check the fibre and the far end' : '',
        hot ? 'check the airflow around the switch' : '',
      ].filter(Boolean).join('; ');
      await alertService.dispatch(
        'optic_degraded',
        `Optic in ${p.interface} on ${deviceName}: ${p.reason}. Now ${now}. ` +
          `${advice[0].toUpperCase()}${advice.slice(1)}, or replace the optic.`,
        { deviceId, deviceName, cooldownKey: `optic_degraded:${deviceId}:${p.interface}` },
      );
    }
  }
}

export async function purgeOpticReadings(): Promise<void> {
  await query(`DELETE FROM optic_readings WHERE at < NOW() - INTERVAL '14 days'`);
}
