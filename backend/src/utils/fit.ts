/**
 * Device-supplied strings, cut to the database column they go into (outside
 * review P2-20). A device can report anything, and one value past a column's
 * width used to fail the insert and abort the whole collector, leaving every
 * row after it stale on every poll.
 */
export function fit(value: string | null | undefined, max: number): string | null {
  return value == null ? null : value.slice(0, max);
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** A lowercase colon-separated MAC, or null for anything else. */
export function normalizeMac(raw: string | null | undefined): string | null {
  const mac = (raw || '').trim().toLowerCase();
  return MAC_RE.test(mac) ? mac : null;
}
