import { query } from '../config/database';
import { alertService } from './AlertService';
import type { DeviceCollector, DeviceRow } from './mikrotik/DeviceCollector';
import { summarizeIssues } from '../utils/deviceHealth';

/**
 * Read a device's hardware health, store the verdict, and alert on a change
 * (#168). Used by the slow and full polls and by a manual Sync, so pressing
 * Sync shows current health rather than whatever the last poll found.
 *
 * Alerts when a device becomes degraded, when a new problem appears on one
 * that already was, and when it recovers. Writes a device event either way.
 * Returns true if the stored state changed in a way worth telling the UI.
 */
export async function runHealthCheck(collector: DeviceCollector, device: DeviceRow): Promise<boolean> {
  try {
    const [setting] = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'health_temp_limit_c'`
    ).catch(() => []);
    const limit = Number(setting?.value) || undefined;
    const r = await collector.collectHealth(limit);
    if (!r) return false;
    const { prevStatus, prevItems, verdict } = r;
    const newItems = verdict.issues.filter((i) => !prevItems.includes(i.item));
    const became = verdict.status === 'degraded' && (prevStatus !== 'degraded' || newItems.length > 0);
    const restored = prevStatus === 'degraded' && verdict.status === 'ok';
    if (!became && !restored) return prevStatus !== verdict.status;

    const message = became
      ? `${device.name} is degraded: ${summarizeIssues(prevStatus === 'degraded' ? newItems : verdict.issues)}`
      : `${device.name} hardware is healthy again.`;
    await query(
      `INSERT INTO events (device_id, event_time, severity, topic, message)
       VALUES ($1, NOW(), $2, 'manager,health', $3)`,
      [device.id, became ? 'warning' : 'info', message]
    ).catch(() => {});
    alertService.dispatch(became ? 'device_degraded' : 'device_health_restored', message, {
      deviceId: device.id,
      deviceName: device.name,
      // A second, different failure must not be swallowed by the cooldown of the first.
      cooldownKey: became ? `device_degraded:${device.id}:${verdict.issues.map((i) => i.item).sort().join(',')}` : undefined,
    }).catch(() => {});
    return true;
  } catch (err) {
    console.warn(`[health] check failed for ${device.name}: ${(err as Error).message}`);
    return false;
  }
}
