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

/**
 * Ports per row: "auto" to fit the container, or an explicit column count.
 *
 * The first attempt offered Compact/Medium/Wide at 8/16/24 columns, which was
 * sized for a hypothetical 48-port switch rather than for real hardware. Across
 * the five boards on the reference fleet, all four settings produced an
 * identical layout in nineteen of twenty combinations — the largest single
 * group on any of them is twelve ports, and the *smallest* option was eight. A
 * control that cannot move anything reads as broken, and was reported as such.
 *
 * The range now starts low enough to bite on an eight-port switch, and the
 * numbers are explicit so it is obvious what a setting should do.
 */
export type Density = 'auto' | number;

export const DENSITY_OPTIONS: number[] = [4, 6, 8, 12, 16, 24];

/** localStorage round-trip, tolerating anything previously stored. */
export function parseDensity(raw: string | null): Density {
  if (!raw || raw === 'auto') return 'auto';
  const n = Number(raw);
  return Number.isFinite(n) && DENSITY_OPTIONS.includes(n) ? n : 'auto';
}

export function densityLabel(d: Density, effective: number): string {
  return d === 'auto' ? `Fit to width (${effective})` : `${d} per row`;
}

/**
 * Columns to use, from the operator's preference and the measured container.
 *
 * "Fit to width" is the default because it answers the original complaint
 * without anyone choosing anything. Where a group is smaller than the budget it
 * stays on one row, which is correct and also why the effective column count is
 * shown: otherwise "nothing happened" is indistinguishable from "nothing needed
 * to happen".
 */
export function resolveColumns(density: Density, measuredPx: number): number {
  if (density === 'auto') return columnsForWidth(measuredPx);
  return Math.max(1, Math.floor(density));
}
