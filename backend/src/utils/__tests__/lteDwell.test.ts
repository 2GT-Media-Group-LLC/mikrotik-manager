import {
  buildSegments, summarise, summariseBands, expandBands, formatDuration,
  type CellEvent,
} from '../lteDwell';

const T = (iso: string) => new Date(iso);
const ev = (at: string, cellId: string | null, bands: string | null, enbId: string | null = 'E1'): CellEvent =>
  ({ at: T(at), cellId, enbId, bands });

const NOW = T('2026-09-06T12:00:00Z');

describe('buildSegments', () => {
  it('runs each state until the next change', () => {
    const segs = buildSegments([
      ev('2026-09-06T09:00:00Z', 'A', '1'),
      ev('2026-09-06T10:00:00Z', 'B', '1,3'),
    ], NOW);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ cellId: 'A', seconds: 3600, open: false });
    expect(segs[1]).toMatchObject({ cellId: 'B', seconds: 7200, open: true });
  });

  it('leaves the final segment open, since it is still accruing', () => {
    const segs = buildSegments([ev('2026-09-06T11:30:00Z', 'A', '1')], NOW);
    expect(segs[0].open).toBe(true);
    expect(segs[0].seconds).toBe(1800);
  });

  it('credits the window before the first change to the state then in force', () => {
    // Without this, a link that changed once at 11:00 would report only one hour
    // of dwell across a twelve-hour window — most of it silently dropped.
    const segs = buildSegments(
      [ev('2026-09-06T11:00:00Z', 'B', '3')],
      NOW,
      T('2026-09-06T00:00:00Z'),
      ev('2026-09-05T22:00:00Z', 'A', '1'),
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ cellId: 'A', seconds: 39600 });
    expect(segs[1]).toMatchObject({ cellId: 'B', seconds: 3600 });
  });

  it('sorts events that arrive out of order', () => {
    const segs = buildSegments([
      ev('2026-09-06T10:00:00Z', 'B', '1'),
      ev('2026-09-06T09:00:00Z', 'A', '1'),
    ], NOW);
    expect(segs.map((s) => s.cellId)).toEqual(['A', 'B']);
  });

  it('discards a state that never actually held', () => {
    // Two changes in the same second describe a transient, not a stretch of
    // time; counting it would inflate the visit count for that cell.
    const segs = buildSegments([
      ev('2026-09-06T09:00:00Z', 'A', '1'),
      ev('2026-09-06T09:00:00Z', 'B', '1'),
      ev('2026-09-06T10:00:00Z', 'C', '1'),
    ], NOW);
    expect(segs.map((s) => s.cellId)).toEqual(['B', 'C']);
  });

  it('returns nothing when there is no history at all', () => {
    expect(buildSegments([], NOW)).toEqual([]);
  });
});

describe('summarise', () => {
  const segs = buildSegments([
    ev('2026-09-06T06:00:00Z', 'A', '1'),
    ev('2026-09-06T08:00:00Z', 'B', '1'),
    ev('2026-09-06T09:00:00Z', 'A', '1'),
  ], NOW);

  it('adds up separate visits to the same cell', () => {
    const totals = summarise(segs, (s) => s.cellId);
    const a = totals.find((t) => t.key === 'A')!;
    expect(a.seconds).toBe(7200 + 10800);
    expect(a.visits).toBe(2);
  });

  it('orders by time spent, not by recency', () => {
    expect(summarise(segs, (s) => s.cellId).map((t) => t.key)).toEqual(['A', 'B']);
  });

  it('reports each share of the measured time', () => {
    const totals = summarise(segs, (s) => s.cellId);
    expect(totals.reduce((n, t) => n + t.pct, 0)).toBeCloseTo(100, 0);
  });

  it('ignores segments where the attribute was never reported', () => {
    // Attributing an unreported cell to "unknown" would invent a state the
    // modem never described.
    const withGap = buildSegments([
      ev('2026-09-06T09:00:00Z', null, '1'),
      ev('2026-09-06T10:00:00Z', 'A', '1'),
    ], NOW);
    expect(summarise(withGap, (s) => s.cellId).map((t) => t.key)).toEqual(['A']);
  });

  it('tracks when each was last in use', () => {
    const a = summarise(segs, (s) => s.cellId).find((t) => t.key === 'A')!;
    expect(a.lastSeen).toEqual(NOW);
  });
});

describe('summariseBands', () => {
  it('credits both bands of an aggregated pair for the whole stretch', () => {
    // "1,3" means B1 and B3 were in use *simultaneously*, so each gets the full
    // duration — percentages describe usage, not a division of the window.
    const segs = buildSegments([ev('2026-09-06T11:00:00Z', 'A', '1,3')], NOW);
    const bands = summariseBands(segs, 3600);
    expect(bands.map((b) => b.label).sort()).toEqual(['B1', 'B3']);
    expect(bands.every((b) => b.seconds === 3600)).toBe(true);
    expect(bands.every((b) => b.pct === 100)).toBe(true);
  });

  it('adds a band up across the stretches it appeared in', () => {
    const segs = buildSegments([
      ev('2026-09-06T10:00:00Z', 'A', '1,3'),
      ev('2026-09-06T11:00:00Z', 'A', '1'),
    ], NOW);
    const b1 = summariseBands(segs, 7200).find((b) => b.label === 'B1')!;
    const b3 = summariseBands(segs, 7200).find((b) => b.label === 'B3')!;
    expect(b1.seconds).toBe(7200);
    expect(b3.seconds).toBe(3600);
  });

  it('handles a segment with no band recorded', () => {
    const segs = buildSegments([ev('2026-09-06T11:00:00Z', 'A', null)], NOW);
    expect(summariseBands(segs, 3600)).toEqual([]);
  });
});

describe('expandBands', () => {
  it('splits and trims', () => {
    expect(expandBands('1, 3 ,7')).toEqual(['1', '3', '7']);
  });
  it('copes with nothing', () => {
    expect(expandBands(null)).toEqual([]);
    expect(expandBands('')).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('reads the way a person would say it', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(187200)).toBe('2d 4h');
  });
});
