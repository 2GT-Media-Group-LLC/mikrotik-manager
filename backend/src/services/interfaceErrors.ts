/**
 * Interface errors and link flaps (#249): turns each poll's cumulative
 * counters into stored intervals, and alerts on them.
 *
 * The previous reading of each port is kept in memory. After a restart the
 * first poll only sets the baseline, which costs one poll interval of history
 * and saves a database write per port per poll. Only intervals in which a
 * counter grew are stored, so a healthy fleet writes nothing.
 */
import { query } from '../config/database';
import { alertService } from './AlertService';
import {
  readCounters, counterDelta, isEmpty, summarise, describeErrors, totalErrors,
  DEFAULT_ERRORS_PER_MIN, DEFAULT_FLAPS_PER_HOUR, RATE_WINDOW_MIN,
  type PortCounters, type ErrorEvent, type PortErrorSummary,
} from '../utils/interfaceErrors';

const baseline = new Map<string, PortCounters>();

/** Forget a device's baseline (removed device; tests). */
export function forgetBaseline(deviceId?: number): void {
  if (deviceId === undefined) { baseline.clear(); return; }
  for (const k of [...baseline.keys()]) if (k.startsWith(`${deviceId}:`)) baseline.delete(k);
}

/**
 * Record one poll. `ethernet` is /interface/ethernet/print stats; `linkDowns`
 * maps interface name to its link-downs from /interface/print stats. Only
 * Ethernet ports are tracked: link drops on Wi-Fi, VLAN or tunnel interfaces
 * are routine and would only add noise.
 */
export async function recordInterfaceCounters(
  deviceId: number, ethernet: Record<string, string>[], linkDowns: Map<string, string | undefined>, intervalSec: number,
): Promise<void> {
  const rows: unknown[][] = [];
  for (const eth of ethernet) {
    const name = eth['name'];
    if (!name) continue;
    const key = `${deviceId}:${name}`;
    const cur = readCounters(eth, linkDowns.get(name));
    const prev = baseline.get(key);
    baseline.set(key, cur);
    if (!prev) continue;
    const d = counterDelta(prev, cur);
    if (!d || isEmpty(d)) continue;
    rows.push([deviceId, name, intervalSec, d.errors.fcs, d.errors.align, d.errors.overflow, d.errors.other, d.linkDowns]);
  }
  for (const r of rows) {
    await query(
      `INSERT INTO interface_error_events (device_id, interface, interval_sec, fcs, align, overflow, other, link_downs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      r,
    );
  }
}

/** The last hour of events, for one device or the fleet. */
async function recentEvents(deviceIds?: number[]): Promise<(ErrorEvent & { device_id: number })[]> {
  const params: unknown[] = [];
  let where = `at > NOW() - INTERVAL '1 hour'`;
  if (deviceIds) { params.push(deviceIds); where += ` AND device_id = ANY($1::int[])`; }
  return query<ErrorEvent & { device_id: number }>(
    `SELECT device_id, interface, EXTRACT(EPOCH FROM NOW() - at)::int AS ago_sec,
            -- BIGINT arrives from pg as a string; one interval never comes near 2^53.
            fcs::float8 AS fcs, align::float8 AS align, overflow::float8 AS overflow,
            other::float8 AS other, link_downs
       FROM interface_error_events WHERE ${where}`,
    params,
  );
}

/** The thresholds in force: the alert rules' own, or the defaults. */
export async function thresholds(): Promise<{ errorsPerMin: number; flapsPerHour: number }> {
  const [e, f] = await Promise.all([alertService.getRule('interface_errors'), alertService.getRule('interface_flapping')]);
  return {
    errorsPerMin: e?.threshold && e.threshold > 0 ? e.threshold : DEFAULT_ERRORS_PER_MIN,
    flapsPerHour: f?.threshold && f.threshold > 0 ? f.threshold : DEFAULT_FLAPS_PER_HOUR,
  };
}

/** Per-port summaries, keyed by device. Ports with nothing in the last hour are absent. */
export async function portErrorSummaries(deviceIds?: number[]): Promise<Map<number, PortErrorSummary[]>> {
  const [events, t] = await Promise.all([recentEvents(deviceIds), thresholds()]);
  const byDevice = new Map<number, ErrorEvent[]>();
  for (const e of events) {
    const list = byDevice.get(e.device_id) ?? [];
    list.push(e);
    byDevice.set(e.device_id, list);
  }
  const out = new Map<number, PortErrorSummary[]>();
  for (const [id, list] of byDevice) out.set(id, summarise(list, t.errorsPerMin, t.flapsPerHour));
  return out;
}

/** Alert on ports over the error rate, and on flapping ports. Cooldown is per port. */
export async function checkInterfaceErrors(): Promise<void> {
  const [errRule, flapRule] = await Promise.all([
    alertService.getRule('interface_errors'), alertService.getRule('interface_flapping'),
  ]);
  if (!errRule?.enabled && !flapRule?.enabled) return;
  const summaries = await portErrorSummaries();
  if (summaries.size === 0) return;
  const t = await thresholds();
  const names = new Map(
    (await query<{ id: number; name: string }>(`SELECT id, name FROM devices WHERE id = ANY($1::int[])`, [[...summaries.keys()]]))
      .map((d) => [d.id, d.name.trim()]),
  );
  for (const [deviceId, ports] of summaries) {
    const deviceName = names.get(deviceId) ?? `device ${deviceId}`;
    for (const p of ports) {
      if (errRule?.enabled && p.rate_per_min >= t.errorsPerMin) {
        const kinds = describeErrors(p.hour);
        await alertService.dispatch(
          'interface_errors',
          `${p.interface} on ${deviceName} is receiving ${p.rate_per_min} bad frames a minute ` +
            `(average over ${RATE_WINDOW_MIN} min; alert at ${t.errorsPerMin}). Last hour: ${kinds || `${totalErrors(p.hour)} errors`}` +
            `${p.hour.link_downs === 0 ? '. The link stayed up' : ''}; check the optic, cable and the far end.`,
          { deviceId, deviceName, cooldownKey: `interface_errors:${deviceId}:${p.interface}` },
        );
      }
      if (flapRule?.enabled && p.flapping) {
        await alertService.dispatch(
          'interface_flapping',
          `${p.interface} on ${deviceName} went down ${p.hour.link_downs} times in the last hour ` +
            `(alert at ${t.flapsPerHour}); check the cable, optic, power at the far end, or auto-negotiation.`,
          { deviceId, deviceName, cooldownKey: `interface_flapping:${deviceId}:${p.interface}` },
        );
      }
    }
  }
}

/** Keep a week: enough to look back on, small enough to never matter. */
export async function purgeInterfaceErrorEvents(): Promise<void> {
  await query(`DELETE FROM interface_error_events WHERE at < NOW() - INTERVAL '7 days'`);
}
