/**
 * Parse API/SSH port from request bodies (string or number). Invalid values
 * fall back to the provided default (matches existing device routes behavior).
 */
export function parsePort(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}
