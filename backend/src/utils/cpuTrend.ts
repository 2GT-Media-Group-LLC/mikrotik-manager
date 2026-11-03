/**
 * The dashboard capacity card's 24-hour CPU trend (#368): 48 half-hour slots
 * per device, each holding the highest CPU load seen in it.
 */

export const TREND_SLOT_MS = 30 * 60_000;
export const TREND_SLOTS = 48;

/** Start of the first slot: the current half hour is the last of the 48. */
export function trendStart(now: number): number {
  return Math.floor(now / TREND_SLOT_MS) * TREND_SLOT_MS - (TREND_SLOTS - 1) * TREND_SLOT_MS;
}

export interface TrendPoint { id: string; start: number; value: number }

/**
 * Place half-hour maxima into each device's 48 slots. A slot with no polls is
 * null, so a gap shows as a gap rather than squeezing the line. Two points in
 * one slot (a device renamed mid-window writes a second series) keep the higher.
 */
export function trendSlots(points: TrendPoint[], now: number): Map<string, (number | null)[]> {
  const first = trendStart(now);
  const out = new Map<string, (number | null)[]>();
  for (const p of points) {
    if (!p.id || !Number.isFinite(p.value)) continue;
    const slot = Math.floor((p.start - first) / TREND_SLOT_MS);
    if (slot < 0 || slot >= TREND_SLOTS) continue;
    let s = out.get(p.id);
    if (!s) { s = new Array<number | null>(TREND_SLOTS).fill(null); out.set(p.id, s); }
    const v = Math.round(Math.min(100, Math.max(0, p.value)));
    s.splice(slot, 1, Math.max(s.at(slot) ?? 0, v));
  }
  return out;
}

/** Highest value in a trend, or null when it holds none. */
export function trendPeak(series: (number | null)[]): number | null {
  const vals = series.filter((v): v is number => v !== null);
  return vals.length ? Math.max(...vals) : null;
}
