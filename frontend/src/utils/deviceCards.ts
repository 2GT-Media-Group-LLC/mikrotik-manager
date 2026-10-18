/**
 * Cards that list devices on a large fleet (#303): the ones needing attention
 * first, so a card cut to its first rows still shows what matters.
 */
interface CardDevice {
  name: string;
  status?: string | null;
  firmware_update_available?: boolean | null;
  routerboard_upgrade_available?: boolean | null;
}

function rank(d: CardDevice): number {
  if (d.status === 'offline') return 0;
  if (d.status && d.status !== 'online') return 1;
  if (d.firmware_update_available || d.routerboard_upgrade_available) return 2;
  return 3;
}

/** Offline first, then other trouble, then pending updates; by name within each. */
export function byAttention<T extends CardDevice>(devices: T[]): T[] {
  return [...devices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Rows a dashboard card shows before "View all". */
export const CARD_ROWS = 10;

/** "a, b, c and 12 more": a sentence naming devices that stays one line (#303). */
export function shortList(names: string[], max = 5): string {
  const clean = names.map((n) => n.trim());
  if (clean.length <= max) return clean.join(', ');
  return `${clean.slice(0, max).join(', ')} and ${clean.length - max} more`;
}
