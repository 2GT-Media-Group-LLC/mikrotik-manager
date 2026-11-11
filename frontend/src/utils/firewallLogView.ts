// Firewall Logs presentation helpers (#415).

/**
 * The page buttons to show: the first and last page, the current one and its
 * neighbours, and 'gap' where pages are skipped. Pages are 0-based.
 * 181 pages on the first: 1 2 3 4 5 … 181.
 */
export function pageItems(current: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  if (current < 4) return [0, 1, 2, 3, 4, 'gap', count - 1];
  if (current > count - 5) return [0, 'gap', count - 5, count - 4, count - 3, count - 2, count - 1];
  return [0, 'gap', current - 1, current, current + 1, 'gap', count - 1];
}

const NEUTRAL = 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-slate-200';
const UNTRUSTED = 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
const TRUSTED = 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
const IN_BETWEEN = 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
const OTHERS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
];

/**
 * A zone badge's colour. The manager doesn't know which zone is trusted, so
 * the usual names get the usual colours (untrust/WAN red, trust/LAN green,
 * DMZ/guest amber), the router grey, and any other zone a colour of its own
 * that stays the same from page to page.
 */
export function zoneColor(zone: string, router: boolean): string {
  if (router) return NEUTRAL;
  const z = zone.toLowerCase();
  if (/untrust|\bwan|internet|outside|external|public/.test(z)) return UNTRUSTED;
  if (/dmz|guest|iot/.test(z)) return IN_BETWEEN;
  if (/trust|\blan|inside|internal|private/.test(z)) return TRUSTED;
  let h = 0;
  for (const ch of z) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OTHERS[h % OTHERS.length];
}
