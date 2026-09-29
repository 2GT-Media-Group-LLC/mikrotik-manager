/**
 * Only the fields an operator changed (outside review P2-11).
 *
 * Several edit forms sent their whole state back, including values read live
 * from the device when the form opened. Saving a new hostname re-sent the clock
 * as it was minutes earlier (rewinding the device), and saving an SSID re-sent
 * the radio's current operating frequency (pinning a radio set to pick its
 * channel automatically). Sending only what differs from what was loaded means
 * a save changes exactly what the operator changed.
 */
export function changedFields<T extends Record<string, unknown>>(initial: T, current: T): Partial<T> {
  const before = new Map(Object.entries(initial));
  const changed = Object.entries(current).filter(([key, value]) => !sameValue(before.get(key), value));
  return Object.fromEntries(changed) as Partial<T>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // A number field and its string form ("5" vs 5) are the same value.
  if ((typeof a === 'number' || typeof b === 'number') && a !== '' && b !== '') return String(a) === String(b);
  return a === b;
}
