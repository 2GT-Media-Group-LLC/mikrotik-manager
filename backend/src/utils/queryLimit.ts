/**
 * A `?limit=` value, kept to 1..max. Anything that isn't a positive whole
 * number gets the default: a negative limit reached Postgres, which refuses
 * one, and NaN did too, each a 500.
 */
export function queryLimit(raw: unknown, fallback: number, max: number): number {
  const n = parseInt(String(Array.isArray(raw) ? raw[0] : raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
