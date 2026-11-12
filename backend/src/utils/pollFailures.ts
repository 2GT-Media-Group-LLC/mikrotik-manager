/**
 * When a failed fast poll makes a device offline, and when many failures at
 * once are one problem rather than many.
 *
 * One failed poll used to mark a device offline at once: alert, outage row,
 * clients marked inactive, topology links dropped. A poll can fail for reasons
 * that are not the device: the manager stalls for a few seconds, a job runs
 * over its timeout, a packet is lost on the way. Waiting for a second failure
 * in a row (30 seconds later at the default interval) removes those, at the
 * cost of announcing a real outage one interval later. Zabbix, PRTG and
 * LibreNMS all do the same.
 */

export const DEFAULT_FAILED_POLLS_BEFORE_OFFLINE = 2;
/** Failures this close together (the fast and slow polls, say) are one missed poll. */
export const SAME_MISS_SEC = 10;
const MAX_FAILED_POLLS_BEFORE_OFFLINE = 10;

/** The `offline_after_failed_polls` setting as a usable count: 1 to 10. */
export function failedPollsBeforeOffline(setting: unknown): number {
  const n = typeof setting === 'string' && setting.trim() !== '' ? Number(setting) : setting;
  if (typeof n !== 'number' || !Number.isInteger(n)) return DEFAULT_FAILED_POLLS_BEFORE_OFFLINE;
  return Math.min(MAX_FAILED_POLLS_BEFORE_OFFLINE, Math.max(1, n));
}

/**
 * Whether this failure should mark the device offline. A device that is not
 * online yet (just added, or already offline) gets no grace: there is no
 * up state to protect.
 */
export function shouldMarkOffline(prevStatus: string | null | undefined, failures: number, needed: number): boolean {
  if (prevStatus !== 'online') return true;
  return failures >= needed;
}

/** How recent a failure counts towards a site going quiet at once. */
export const SITE_OUTAGE_WINDOW_SEC = 120;
const SITE_OUTAGE_MIN_DEVICES = 3;
const SITE_OUTAGE_RATIO = 0.75;

/**
 * Most of a site stopping at once is one event: the manager's path to the
 * site, the site's uplink, or the manager itself. It is announced once, naming
 * the site, instead of once per device. Small sites (under 3 devices) keep
 * per-device alerts, where one device is already most of the site.
 */
export function isSiteOutage(failing: number, total: number): boolean {
  if (total < SITE_OUTAGE_MIN_DEVICES) return false;
  return failing / total >= SITE_OUTAGE_RATIO;
}

export function siteOutageMessage(siteName: string | null, failing: number, total: number): string {
  const where = siteName ? `Site ${siteName}` : 'Devices without a site';
  return `${where}: ${failing} of ${total} devices stopped answering within ${SITE_OUTAGE_WINDOW_SEC / 60} minutes. ` +
    'More likely the path from the manager to the site, the site uplink, or the manager itself than every device at once.';
}

/** How a device's going offline was announced (devices.offline_alert). */
export type OfflineAlert = 'device' | 'site' | 'deferred';

/**
 * The recovery to announce, matching how the outage was announced: none for
 * one that was never alerted (down on purpose and back in time), one for the
 * site when the site was alerted, else the device's own. Devices that went
 * offline before this existed have no record and recover as they always did.
 */
export function recoveryKind(offlineAlert: string | null | undefined): 'device' | 'site' | 'none' {
  if (offlineAlert === 'deferred') return 'none';
  if (offlineAlert === 'site') return 'site';
  return 'device';
}

export function siteRecoveryMessage(siteName: string | null): string {
  return `${siteName ? `Site ${siteName}` : 'Devices without a site'}: devices are answering again after going quiet together.`;
}
