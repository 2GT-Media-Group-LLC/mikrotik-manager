/**
 * Placement of a radio's carrier within a drawn spectrum band.
 *
 * Split out of the channel map because the arithmetic had a bug that was
 * invisible in the component: a 40 MHz channel 1 occupies 2392–2432 MHz, and
 * while the 2.4 GHz axis started at 2400 that carrier resolved to a *negative*
 * offset. An absolutely positioned bar at `left: -8%` renders outside its
 * container, so the 2.4 GHz row painted over the edge of the card.
 *
 * The band table has since been widened to contain channel 1 honestly, but the
 * clamp stays: band ranges are static assumptions, and region-specific channels
 * and widths they do not anticipate will keep turning up.
 */
export interface BarGeometry {
  /** Offset from the left of the band, as a percentage. Never negative. */
  leftPct: number;
  /** Width as a percentage. Never extends past the right edge. */
  widthPct: number;
}

/** Narrowest bar that stays visible; a hairline carrier must not vanish. */
const MIN_WIDTH_PCT = 0.6;

export function barGeometry(
  lowMhz: number,
  highMhz: number,
  bandStartMhz: number,
  bandEndMhz: number,
): BarGeometry {
  const span = bandEndMhz - bandStartMhz;
  if (!(span > 0)) return { leftPct: 0, widthPct: MIN_WIDTH_PCT };

  const clamp = (mhz: number) =>
    Math.max(0, Math.min(100, ((mhz - bandStartMhz) / span) * 100));

  const start = clamp(lowMhz);
  const end = clamp(highMhz);
  const widthPct = Math.max(MIN_WIDTH_PCT, end - start);

  // Pull a bar that would overhang back inside rather than letting it bleed.
  return { leftPct: Math.max(0, Math.min(start, 100 - widthPct)), widthPct };
}
