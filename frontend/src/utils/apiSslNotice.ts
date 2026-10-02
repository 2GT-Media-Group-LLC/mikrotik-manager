/** The security check the API-SSL notice repeats; muting it mutes the notice (#194). */
export const PLAIN_API_CHECK = 'mgmt-api-cleartext';

interface Mute { check_id: string; device_id: number | null }

/**
 * Which devices the API-SSL notice should consider, given the check's mutes:
 * none at all when it's muted fleet-wide, otherwise every device not muted
 * on its own.
 */
export function unmutedForApiSslNotice<T extends { id: number }>(devices: T[], mutes: Mute[]): { mutedFleetWide: boolean; devices: T[] } {
  const relevant = mutes.filter((m) => m.check_id === PLAIN_API_CHECK);
  const mutedFleetWide = relevant.some((m) => m.device_id === null);
  const muted = new Set(relevant.map((m) => m.device_id).filter((id): id is number => id !== null));
  return { mutedFleetWide, devices: mutedFleetWide ? [] : devices.filter((d) => !muted.has(d.id)) };
}
