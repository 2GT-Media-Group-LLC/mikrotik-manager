/**
 * Which RouterOS update channel a device should follow (#162).
 *
 * A fleet-wide setting with a per-device override. When neither is set the
 * device is left on whatever channel it already has, which is how every
 * install behaved before this existed.
 *
 * Moving a device to a channel that trails the version it runs (long-term
 * behind stable, say) is safe: availability compares versions rather than
 * trusting the status text, so an older build is never offered as an update
 * (#144).
 */

export const UPDATE_CHANNELS = ['stable', 'long-term', 'testing', 'development'] as const;
export type UpdateChannel = typeof UPDATE_CHANNELS[number];

export function isUpdateChannel(v: unknown): v is UpdateChannel {
  return typeof v === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(v);
}

/**
 * The channel to put the device on, or null to leave it alone.
 * A device override wins over the fleet setting; anything unrecognised is ignored.
 */
export function resolveChannel(deviceOverride: unknown, fleetSetting: unknown): UpdateChannel | null {
  if (isUpdateChannel(deviceOverride)) return deviceOverride;
  if (isUpdateChannel(fleetSetting)) return fleetSetting;
  return null;
}
