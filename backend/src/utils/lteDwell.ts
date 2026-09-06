/**
 * How long a modem has spent on each band and each cell.
 *
 * The Tower and band changes panel lists every handover, newest first, and grows
 * without bound — it answers "what happened" but not "what is the pattern",
 * which is the question an operator actually has (#120).
 *
 * History is recorded on *change*, so each row marks the start of a state that
 * runs until the next row, or until now for the last one. That makes dwell a
 * matter of pairing consecutive events, the same reconstruction already used for
 * WiFi roaming sessions.
 */

export interface CellEvent {
  at: Date;
  cellId: string | null;
  enbId: string | null;
  /** Comma-separated band numbers as recorded, e.g. "1,3". */
  bands: string | null;
}

export interface DwellSegment {
  start: Date;
  end: Date;
  seconds: number;
  cellId: string | null;
  enbId: string | null;
  bands: string | null;
  /** True for the segment still in progress, whose length keeps growing. */
  open: boolean;
}

export interface DwellTotal {
  key: string;
  label: string;
  seconds: number;
  /** Share of the measured window, 0–100. */
  pct: number;
  /** How many separate stretches contributed — 6 short visits differ from 1 long one. */
  visits: number;
  lastSeen: Date;
}

/**
 * Turn change events into the stretches between them.
 *
 * `priorState`, when supplied, is the last event *before* the window: without it
 * the time from the window opening until the first change inside it would be
 * dropped, which on a stable link is most of the window.
 */
export function buildSegments(
  events: CellEvent[],
  now: Date,
  windowStart?: Date,
  priorState?: CellEvent | null,
): DwellSegment[] {
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  // The state in force when the window opened, if we know it.
  if (priorState && windowStart) {
    ordered.unshift({ ...priorState, at: windowStart });
  }
  if (ordered.length === 0) return [];

  const segments: DwellSegment[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i].at;
    const next = ordered[i + 1];
    const end = next ? next.at : now;
    const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    // A change recorded at the same second as the next one describes a state
    // that never really held; counting it would inflate the visit count.
    if (seconds === 0 && next) continue;
    segments.push({
      start, end, seconds,
      cellId: ordered[i].cellId,
      enbId: ordered[i].enbId,
      bands: ordered[i].bands,
      open: !next,
    });
  }
  return segments;
}

/** Sum dwell by a chosen attribute, largest first. */
export function summarise(
  segments: DwellSegment[],
  pick: (s: DwellSegment) => string | null,
  label?: (key: string, s: DwellSegment) => string,
): DwellTotal[] {
  const totals = new Map<string, { seconds: number; visits: number; lastSeen: Date; label: string }>();

  for (const s of segments) {
    const key = pick(s);
    // A segment whose attribute was never reported tells us nothing about that
    // attribute; attributing it to "unknown" would be inventing a state.
    if (key == null || key === '') continue;
    const existing = totals.get(key);
    if (existing) {
      existing.seconds += s.seconds;
      existing.visits += 1;
      if (s.end > existing.lastSeen) existing.lastSeen = s.end;
    } else {
      totals.set(key, {
        seconds: s.seconds, visits: 1, lastSeen: s.end,
        label: label ? label(key, s) : key,
      });
    }
  }

  const measured = [...totals.values()].reduce((n, t) => n + t.seconds, 0);
  return [...totals.entries()]
    .map(([key, t]) => ({
      key,
      label: t.label,
      seconds: t.seconds,
      pct: measured > 0 ? Math.round((t.seconds / measured) * 1000) / 10 : 0,
      visits: t.visits,
      lastSeen: t.lastSeen,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** Each individual band, so an aggregated pair counts toward both. */
export function expandBands(bands: string | null): string[] {
  if (!bands) return [];
  return bands.split(',').map((b) => b.trim()).filter(Boolean);
}

/**
 * Dwell per individual band.
 *
 * A segment on "1,3" is time spent on B1 *and* on B3 simultaneously, so both are
 * credited the full duration. Percentages therefore describe how much of the
 * window each band was in use, not a division of it, and can exceed 100 in
 * total — which is the honest description of carrier aggregation.
 */
export function summariseBands(segments: DwellSegment[], windowSeconds: number): DwellTotal[] {
  const totals = new Map<string, { seconds: number; visits: number; lastSeen: Date }>();

  for (const s of segments) {
    for (const band of expandBands(s.bands)) {
      const existing = totals.get(band);
      if (existing) {
        existing.seconds += s.seconds;
        existing.visits += 1;
        if (s.end > existing.lastSeen) existing.lastSeen = s.end;
      } else {
        totals.set(band, { seconds: s.seconds, visits: 1, lastSeen: s.end });
      }
    }
  }

  return [...totals.entries()]
    .map(([band, t]) => ({
      key: band,
      label: `B${band}`,
      seconds: t.seconds,
      pct: windowSeconds > 0 ? Math.round((t.seconds / windowSeconds) * 1000) / 10 : 0,
      visits: t.visits,
      lastSeen: t.lastSeen,
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** Human duration, e.g. "2d 4h" or "18m". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}
