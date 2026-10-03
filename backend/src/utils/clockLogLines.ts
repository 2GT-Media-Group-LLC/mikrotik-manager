/**
 * RouterOS's clock-adjustment log lines (#213):
 *
 *     ntp change time Sep/29/2026 22:31:49 => Sep/30/2026 09:37:02
 *     cloud change time Sep/20/2026 04:24:48 => Sep/20/2026 04:24:48
 *
 * RouterOS tags the NTP one "system,clock,critical,info", so it was stored as
 * an error, counted as one, and raised the device-log alert, every time NTP
 * nudged the clock or a device without a battery-backed clock set it after
 * boot. They are routine: stored as info, and hidden from Events unless asked
 * for.
 */
export const CLOCK_CHANGE_RE = /^(ntp|cloud) change time\b/i;

/** The same match in SQL, for the events queries. */
export const CLOCK_CHANGE_SQL = `(message ~* '^(ntp|cloud) change time')`;

export function isClockChangeLine(message: string | null | undefined): boolean {
  return CLOCK_CHANGE_RE.test((message ?? '').trim());
}
