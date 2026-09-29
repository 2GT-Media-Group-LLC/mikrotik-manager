import { compareRosVersions, parseRosVersion } from './rosVersion';

/**
 * Firmware decisions that used to be string comparisons (outside review P2-9).
 *
 *   - "Skip if latest === installed" treated any *different* version as an
 *     upgrade. With the channel set to long-term, a device on a newer stable
 *     release would be "upgraded" to the older long-term one: a downgrade,
 *     recorded as success. RouterOS installs whatever its channel offers.
 *   - The check after the reboot compared the new version with the version we
 *     had stored for the device (which could be stale or empty), not with the
 *     version we meant to install, so an upgrade that landed on something else,
 *     or never moved, could pass.
 *   - A scheduled rollout had no end, so after downtime or a long earlier run it
 *     started whenever the manager got to it, rebooting devices in business hours.
 */

export type UpgradeDecision =
  | { action: 'upgrade' }
  | { action: 'skip'; reason: string };

/** Whether to upgrade a device from `installed` to what its channel offers. */
export function upgradeDecision(installed: string, latest: string): UpgradeDecision {
  const inst = installed.trim();
  const next = latest.trim();
  if (!next) return { action: 'skip', reason: 'The device reported no available version' };
  if (!parseRosVersion(inst) || !parseRosVersion(next)) {
    return next === inst
      ? { action: 'skip', reason: 'Already up to date' }
      : { action: 'skip', reason: `Could not compare the installed version (${inst || 'unknown'}) with ${next}, so nothing was changed` };
  }
  const cmp = compareRosVersions(next, inst);
  if (cmp === 0) return { action: 'skip', reason: 'Already up to date' };
  if (cmp < 0) {
    return {
      action: 'skip',
      reason: `The update channel offers ${next}, which is older than the installed ${inst}. ` +
        'Nothing is downgraded automatically; change the channel if that was not intended.',
    };
  }
  return { action: 'upgrade' };
}

/** After the reboot: did the device end up on the version we installed? */
export function verifyUpgrade(target: string, reported: string, from: string): { ok: true } | { ok: false; error: string } {
  const want = target.trim();
  const got = reported.trim();
  if (!got) return { ok: false, error: `The device came back but its version could not be read, so the upgrade to ${want} can't be confirmed` };
  if (compareRosVersions(got, want) === 0 && parseRosVersion(got)) return { ok: true };
  if (from && compareRosVersions(got, from) === 0) {
    return { ok: false, error: `The device still reports ${got}; the upgrade to ${want} did not apply` };
  }
  return { ok: false, error: `Expected ${want} after the upgrade, but the device reports ${got}` };
}

/** How long after its scheduled time a rollout may still start when no end was given. */
export const DEFAULT_START_WINDOW_MIN = 60;

export type ScheduleDecision = 'wait' | 'start' | 'missed';

/**
 * Whether a scheduled rollout may start now. It must start between its
 * scheduled time and its "don't start after" time (or the default window),
 * never later: a missed window is recorded, not caught up.
 */
export function scheduleDecision(scheduledAt: Date, notAfter: Date | null, now: Date = new Date()): ScheduleDecision {
  if (now < scheduledAt) return 'wait';
  const end = notAfter ?? new Date(scheduledAt.getTime() + DEFAULT_START_WINDOW_MIN * 60_000);
  return now <= end ? 'start' : 'missed';
}
