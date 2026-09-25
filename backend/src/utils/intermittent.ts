/**
 * Devices that are expected to drop out (#168, from Orhideous).
 *
 * A solar- or battery-powered device going offline at a random moment is
 * normal. Treated like any other device it shows red and sends an offline
 * alert every time, which trains people to ignore offline alerts.
 *
 * Marked intermittent, a device:
 *   - does not alert when it goes offline
 *   - alerts once if it stays offline longer than its limit (0 = never)
 *   - sends a recovery alert only if that long-offline alert was sent
 * Its status is still recorded honestly; only alerting and colour change.
 */

export const DEFAULT_INTERMITTENT_ALERT_AFTER_MIN = 24 * 60;

export interface OfflineState {
  intermittent: boolean;
  /** Minutes offline before an intermittent device alerts. 0 or less: never. */
  alertAfterMin: number | null | undefined;
  /** Offline already before this failed poll? */
  wasOffline: boolean;
  offlineSince: Date | null;
  alreadyAlerted: boolean;
  now: Date;
}

export type OfflineAction = 'alert' | 'alert-long-offline' | 'none';

export function offlineAction(s: OfflineState): OfflineAction {
  if (!s.intermittent) return s.wasOffline ? 'none' : 'alert';
  const limit = s.alertAfterMin ?? DEFAULT_INTERMITTENT_ALERT_AFTER_MIN;
  if (limit <= 0 || s.alreadyAlerted || !s.offlineSince) return 'none';
  const minutes = (s.now.getTime() - s.offlineSince.getTime()) / 60000;
  return minutes >= limit ? 'alert-long-offline' : 'none';
}

/** Whether coming back online should send the usual recovery alert. */
export function recoveryAlert(intermittent: boolean, alreadyAlerted: boolean): boolean {
  return !intermittent || alreadyAlerted;
}

export function describeDuration(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}
