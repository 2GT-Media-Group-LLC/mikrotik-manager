/**
 * The dashboard's Capacity & health card (#368): which devices come first, how
 * their names are shortened, and what colour a load gets.
 */

export interface CapacityLoad {
  name: string; cpu: number; mem_pct: number;
  /** The least memory used in the last 7 days, in %, when known. */
  mem_low_7d?: number | null;
}

/** Memory is high from here: coloured, and it may count toward the order. */
export const MEM_HIGH = 75;
/**
 * ...but only once it has grown this far above the device's own 7-day low. A
 * wAP ax sits at 88-91 % all week, which is where its firmware keeps it; a
 * leak climbs from where the device was (#368).
 */
export const MEM_GROWTH = 10;

/** Whether a device's memory counts toward the order: high, and grown this week. */
export function memoryCounts(c: CapacityLoad): boolean {
  if (c.mem_pct < MEM_HIGH) return false;
  return c.mem_low_7d == null || c.mem_pct - c.mem_low_7d >= MEM_GROWTH;
}

/** The hover on the memory figure, once it is high. */
export function memHint(c: CapacityLoad): string | undefined {
  if (c.mem_pct < MEM_HIGH) return undefined;
  if (c.mem_low_7d == null) return 'Memory is high, so it counts toward the order';
  const grown = c.mem_pct - c.mem_low_7d;
  return memoryCounts(c)
    ? `Memory is high and up ${grown} points on its 7-day low of ${c.mem_low_7d} %, so it counts toward the order`
    : `Memory is high but steady (7-day low ${c.mem_low_7d} %), so it doesn't move the device up the list`;
}

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

/** How hard a device is working: its CPU, or its memory once that's high and growing. */
export function pressure(c: CapacityLoad): number {
  return Math.max(c.cpu, memoryCounts(c) ? c.mem_pct : 0);
}

/** Busiest first: by pressure, then CPU, then memory, then name. */
export function sortCapacity<T extends CapacityLoad>(rows: T[]): T[] {
  return [...rows].sort((a, b) => pressure(b) - pressure(a) || b.cpu - a.cpu || b.mem_pct - a.mem_pct || a.name.localeCompare(b.name));
}

/** Grey under 50 %, accent to 74, warn to 89, bad from 90. */
export function loadColor(v: number): string {
  return v >= 90 ? 'var(--bad)' : v >= 75 ? 'var(--warn)' : v >= 50 ? 'var(--accent)' : 'var(--ink-4)';
}

/** The number beside a bar: plain under 50 %, the bar's colour from there. */
export function loadText(v: number): string {
  return v >= 50 ? loadColor(v) : 'var(--ink-3)';
}

/** The memory figure: coloured once it's high, whether or not it counts toward the order. */
export function memText(v: number): string {
  return v >= MEM_HIGH ? loadColor(v) : 'var(--ink-3)';
}

/** Below this width the card drops its 24h graphs, so names keep their room (#368). */
export const CAPACITY_NARROW_PX = 400;

/** The card's columns: name (never under 90 px), the 24h graph unless narrow, CPU, memory. */
export function capacityGrid(narrow: boolean): string {
  return narrow ? 'minmax(90px,1fr) 92px 38px' : 'minmax(90px,1fr) 96px 92px 38px';
}
