/**
 * Reboots seen from the uptime counter (#326). A device's boot time is "now
 * minus uptime"; on every poll it should come out the same, give or take a
 * second or two. Later by more than a couple of minutes means the device
 * restarted since we last looked, however quick the restart and however long
 * the gap between looks.
 */
export const BOOT_DRIFT_MS = 10_000;
export const REBOOT_SHIFT_MS = 120_000;

export type BootChange = 'first' | 'same' | 'drift' | 'reboot';

export function bootChange(prevBootMs: number | null, bootMs: number): BootChange {
  if (prevBootMs == null) return 'first';
  const shift = bootMs - prevBootMs;
  if (Math.abs(shift) <= BOOT_DRIFT_MS) return 'same';
  return shift > REBOOT_SHIFT_MS ? 'reboot' : 'drift';
}
