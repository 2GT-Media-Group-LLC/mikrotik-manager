import type { Device } from '../types';

/**
 * What to show for a device's status (#168).
 *
 * `status` is still only online/offline/unknown, and stays honest. Two cases
 * are shown differently on top of it:
 *   - degraded: online, but /system/health reports a failed PSU, fan, or an
 *     over-limit temperature. Amber rather than green.
 *   - expected offline: offline, but marked intermittent (solar, battery).
 *     Grey rather than red, because nothing needs doing.
 */
export type DisplayState = 'online' | 'degraded' | 'offline' | 'expected-offline' | 'unknown';

export function displayState(d: Pick<Device, 'status'> & {
  health_status?: string | null;
  intermittent?: boolean;
}): DisplayState {
  if (d.status === 'online') return d.health_status === 'degraded' ? 'degraded' : 'online';
  if (d.status === 'offline') return d.intermittent ? 'expected-offline' : 'offline';
  return 'unknown';
}

export const STATE_LABEL: Record<DisplayState, string> = {
  online: 'online',
  degraded: 'degraded',
  offline: 'offline',
  'expected-offline': 'offline (expected)',
  unknown: 'unknown',
};

/** CSS colour for dots. */
export const STATE_COLOR: Record<DisplayState, string> = {
  online: 'var(--good)',
  // Brighter than the --warn text colour, which reads as brown on a small dot.
  degraded: '#f59e0b',
  offline: 'var(--bad)',
  'expected-offline': 'var(--ink-4)',
  unknown: 'var(--ink-4)',
};
