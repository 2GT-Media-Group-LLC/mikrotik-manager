/**
 * Who hears about a device going offline (#442).
 *
 * Devices that are down on purpose right now: rebooted by the manager
 * (the Reboot button, a RouterBOOT upgrade, a firmware rollout), in a running
 * rollout, or in a maintenance window. Their going offline isn't alerted, and
 * isn't counted as part of a site going quiet; if one is still down once the
 * reason has passed, it alerts then.
 */
import { query } from '../config/database';
import { windowCovers, type MaintenanceWindowRow } from '../utils/maintenance';
import { isSiteOutage, SITE_OUTAGE_WINDOW_SEC } from '../utils/pollFailures';

/** How long after the manager sends a reboot the device may be gone. */
export const PLANNED_REBOOT_MIN = 10;

/** Rollout steps during which the device is expected to drop. */
const ROLLOUT_DOWN_STEPS = ['upgrading', 'rebooting', 'verifying'];

/** Note that the manager is about to reboot a device. */
export async function expectReboot(deviceId: number): Promise<void> {
  if (!deviceId) return;
  try {
    await query(
      `UPDATE devices SET reboot_expected_until = NOW() + make_interval(mins => $2) WHERE id = $1`,
      [deviceId, PLANNED_REBOOT_MIN]);
  } catch { /* the reboot then alerts, as before */ }
}

/** The reason each of these devices is down on purpose; absent when it isn't. */
export async function plannedOutages(deviceIds: number[]): Promise<Map<number, string>> {
  const reasons = new Map<number, string>();
  if (!deviceIds.length) return reasons;
  const [rebooting, rollouts, windows, tz] = await Promise.all([
    query<{ id: number }>(
      `SELECT id FROM devices WHERE id = ANY($1::int[]) AND reboot_expected_until > NOW()`, [deviceIds]).catch(() => []),
    // Started recently, so a rollout the manager died in the middle of doesn't hold it forever.
    query<{ device_id: number }>(
      `SELECT DISTINCT device_id FROM firmware_rollout_devices
        WHERE device_id = ANY($1::int[]) AND status = ANY($2::text[]) AND started_at > NOW() - INTERVAL '2 hours'`,
      [deviceIds, ROLLOUT_DOWN_STEPS]).catch(() => []),
    query<MaintenanceWindowRow>(`SELECT * FROM maintenance_windows WHERE active = true`).catch(() => []),
    query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'app_timezone'`).catch(() => []),
  ]);
  const timeZone = typeof tz[0]?.value === 'string' ? tz[0].value : 'UTC';
  const now = new Date();
  for (const id of deviceIds) {
    if (windows.some((w) => windowCovers(w, id, now, timeZone))) reasons.set(id, 'a maintenance window');
  }
  for (const r of rollouts) reasons.set(r.device_id, 'a firmware upgrade');
  for (const r of rebooting) reasons.set(r.id, 'a reboot sent by the manager');
  return reasons;
}

/**
 * Most of a site failing within a couple of minutes: the path to the site,
 * its uplink, or the manager, not every device at once. Leaves out devices
 * already down before then, devices down on purpose, and ones that aren't
 * polled or never answered. Null when it isn't that.
 */
export async function siteGoingQuiet(siteId: number | null): Promise<{ name: string | null; failing: number; total: number } | null> {
  const rows = await query<{ id: number; failing: boolean; site_name: string | null }>(
    `SELECT d.id, (d.poll_failures > 0 AND d.last_poll_failure_at > NOW() - make_interval(secs => $2)) AS failing,
            s.name AS site_name
       FROM devices d LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.site_id IS NOT DISTINCT FROM $1 AND NOT d.intermittent
        AND d.status NOT IN ('disabled', 'unknown')
        AND NOT EXISTS (
          SELECT 1 FROM device_availability a
           WHERE a.device_id = d.id AND a.came_back_online_at IS NULL
             AND a.went_offline_at < NOW() - make_interval(secs => $2))`,
    [siteId, SITE_OUTAGE_WINDOW_SEC]).catch(() => []);
  const planned = await plannedOutages(rows.map((r) => r.id));
  const counted = rows.filter((r) => !planned.has(r.id));
  const failing = counted.filter((r) => r.failing).length;
  return isSiteOutage(failing, counted.length) ? { name: rows[0]?.site_name ?? null, failing, total: counted.length } : null;
}
