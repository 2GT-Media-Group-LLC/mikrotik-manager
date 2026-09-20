/**
 * Arranging the switch faceplate so it fits on a screen.
 *
 * Asked for by a user with switches that have many ports *and bonds*: "it's a
 * very wide view where one has to scroll a lot. Maybe put them in multiple
 * rows, or make it user customizable."
 *
 * He was describing five separate groups — ETH, SFP, QSFP cages, BRIDGE and
 * BOND — laid out in a single horizontal row inside a container set to
 * `overflowX: auto`. Only one of them wrapped at all:
 *
 *   ETH     two staggered rows above 8 ports, and never more than two
 *   SFP     had `flexWrap` set, but a `maxWidth` of 52px per port against a
 *           real 50px per port, so the wrap could never trigger — off by 2px
 *   QSFP    no wrap
 *   BRIDGE  no wrap
 *   BOND    no wrap
 *
 * So width grew linearly with no ceiling and the overflow was simply hidden
 * behind a scrollbar. His mention of bonds was precise: they contribute at full
 * width and never fold, which is why bonded devices are worse than port count
 * alone suggests.
 *
 * The geometry here is deliberately in real pixels taken from the rendered
 * tile. The constants that *used* to live in the component were a leftover
 * coordinate system that nothing read, and reasoning from them produced a tile
 * width of 36px for a tile that is actually 50px including its gap.
 */

/** Rendered size of one PortTile, and the flex gap between tiles. */
export const TILE_PX = 46;
export const TILE_GAP_PX = 4;
/** Padding inside the rack unit, both sides. */
export const RACK_PAD_PX = 52;

/** A pair of faceplate rows: odd ports above, even ports below. */
export interface StaggerBlock<T> {
  top: T[];
  bottom: T[];
}

/**
 * How many tiles fit across, given the space available.
 *
 * Clamped rather than allowed to reach zero: a very narrow container should
 * produce a cramped faceplate, not an empty one or a division by zero.
 */
export function columnsForWidth(availablePx: number, min = 4, max = 32): number {
  const usable = availablePx - RACK_PAD_PX;
  const per = TILE_PX + TILE_GAP_PX;
  if (!Number.isFinite(usable) || usable <= 0) return min;
  return Math.max(min, Math.min(max, Math.floor(usable / per)));
}

/** Split a flat list into rows of at most `maxCols`. */
export function chunkRows<T>(items: T[], maxCols: number): T[][] {
  const cols = Math.max(1, Math.floor(maxCols));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

/**
 * Arrange ports as a real faceplate does: odd numbers on top, even below.
 *
 * Above `maxCols` the stagger repeats in banks rather than running on, which is
 * also how physical hardware is laid out — a 48-port switch is banks of
 * staggered pairs, not one enormous row. Preserving the stagger matters because
 * it is how an operator maps a tile to the socket in front of them.
 *
 * At or below `maxCols` a single row is used, matching the previous behaviour
 * for small devices where a stagger would only add height for nothing.
 */
export function staggerBlocks<T>(items: T[], maxCols: number): StaggerBlock<T>[] {
  const cols = Math.max(1, Math.floor(maxCols));
  if (items.length === 0) return [];
  if (items.length <= cols) return [{ top: items, bottom: [] }];

  const perBank = cols * 2;
  const blocks: StaggerBlock<T>[] = [];
  for (let i = 0; i < items.length; i += perBank) {
    const bank = items.slice(i, i + perBank);
    blocks.push({
      top: bank.filter((_, j) => j % 2 === 0),
      bottom: bank.filter((_, j) => j % 2 === 1),
    });
  }
  return blocks;
}

/** The density choices offered, and what they mean in columns. */
export type Density = 'auto' | 'compact' | 'medium' | 'wide';

export const DENSITY_COLUMNS: Record<Exclude<Density, 'auto'>, number> = {
  compact: 8,
  medium: 16,
  wide: 24,
};

export const DENSITY_LABELS: Record<Density, string> = {
  auto: 'Fit to width',
  compact: 'Compact',
  medium: 'Medium',
  wide: 'Wide',
};

/**
 * Columns to use, from the operator's preference and the measured container.
 *
 * "Fit to width" is the default because it answers the complaint without
 * anyone having to choose: the faceplate stops being wider than the space it
 * is in. The explicit settings exist because he asked to be able to decide,
 * and because a fixed density is easier to compare across devices.
 */
export function resolveColumns(density: Density, measuredPx: number): number {
  if (density === 'auto') return columnsForWidth(measuredPx);
  return DENSITY_COLUMNS[density];
}
