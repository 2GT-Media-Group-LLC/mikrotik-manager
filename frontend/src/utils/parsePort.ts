/**
 * Parse API/SSH port from form fields (string or number). Invalid values use fallback.
 */
export function parsePort(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}
