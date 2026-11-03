/**
 * The dashboard's Capacity & health card (#368): which devices come first, how
 * their names are shortened, and what colour a load gets.
 */

export interface CapacityLoad { name: string; cpu: number; mem_pct: number }

/** Memory counts toward the order only from here. RouterOS memory barely moves. */
export const MEM_HIGH = 75;

/**
 * The longest start shared by every name, cut back to its last '-', '_' or '.',
 * so `01-NIKITINA-ASW01` and `01-NIKITINA-CSW02` share `01-NIKITINA-`. Empty
 * for fewer than two names or when hiding it would leave a name blank.
 */
export function commonPrefix(names: string[]): string {
  if (names.length < 2) return '';
  let p = names[0];
  for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
  const cut = Math.max(p.lastIndexOf('-'), p.lastIndexOf('_'), p.lastIndexOf('.'));
  const prefix = cut > 0 ? p.slice(0, cut + 1) : '';
  return names.some((n) => n.length <= prefix.length) ? '' : prefix;
}

/** A name without the shared prefix. */
export function shortName(name: string, prefix: string): string {
  return prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

/** How hard a device is working: its CPU, or its memory once that's high. */
export function pressure(c: CapacityLoad): number {
  return Math.max(c.cpu, c.mem_pct >= MEM_HIGH ? c.mem_pct : 0);
}

/** Busiest first: by pressure, then memory, then name. */
export function sortCapacity<T extends CapacityLoad>(rows: T[]): T[] {
  return [...rows].sort((a, b) => pressure(b) - pressure(a) || b.mem_pct - a.mem_pct || a.name.localeCompare(b.name));
}

/** Grey under 50 %, accent to 74, warn to 89, bad from 90. */
export function loadColor(v: number): string {
  return v >= 90 ? 'var(--bad)' : v >= 75 ? 'var(--warn)' : v >= 50 ? 'var(--accent)' : 'var(--ink-4)';
}

/** The number beside a bar: plain under 50 %, the bar's colour from there. */
export function loadText(v: number): string {
  return v >= 50 ? loadColor(v) : 'var(--ink-3)';
}

/** The memory figure: coloured only once it counts toward the order. */
export function memText(v: number): string {
  return v >= MEM_HIGH ? loadColor(v) : 'var(--ink-3)';
}
