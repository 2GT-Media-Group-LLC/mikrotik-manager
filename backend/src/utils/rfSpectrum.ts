/**
 * Wi-Fi spectrum occupancy and interference analysis.
 *
 * The channel map used to model a radio as occupying a *channel number*, and
 * coloured a channel amber when two radios sat on it. Both halves of that are
 * wrong, and the result actively misleads spectrum planning
 * (github.com/2GT-Media-Group-LLC/mikrotik-manager/issues/98).
 *
 * **Channels are not slots.** In 2.4 GHz the channel centres are 5 MHz apart while
 * a channel is 20 MHz wide, so an AP on channel 1 occupies roughly 2401–2423 MHz
 * and pollutes channels 1 through 5. Showing channels 2–5 as free is not a missing
 * feature, it is bad advice: 1/6/11 is the only three-way non-overlapping set, and
 * a model built on channel indices cannot express why.
 *
 * **Sharing a channel is not the problem.** Two radios on exactly the same channel
 * hear each other and take turns — CSMA/CA does its job and the cost is airtime.
 * Two radios *partially* overlapping cannot decode each other, so they transmit
 * over one another and the cost is corruption. Partial overlap is the harmful case
 * and must rank above co-channel, not below it.
 *
 * So occupancy is modelled in megahertz and overlap is classified by how two
 * ranges relate, not by whether two numbers match.
 */

export type RfBand = '2.4' | '5' | '6';

export interface BandRange {
  band: RfBand;
  label: string;
  startMhz: number;
  endMhz: number;
}

/**
 * Spectrum drawn for each band. Wide enough to contain every legal channel —
 * including the ones that spill past the round numbers.
 *
 * 2.4 GHz starts at 2390 rather than 2400 because a 40 MHz channel centred on
 * channel 1 occupies 2392–2432. Starting the axis at 2400 puts that carrier at a
 * negative offset, which is not merely a cosmetic problem: it renders outside the
 * chart and misstates how far the radio actually reaches below the band.
 */
export const BAND_RANGES: BandRange[] = [
  { band: '2.4', label: '2.4 GHz', startMhz: 2390, endMhz: 2500 },
  { band: '5',   label: '5 GHz',   startMhz: 5150, endMhz: 5895 },
  { band: '6',   label: '6 GHz',   startMhz: 5925, endMhz: 7125 },
];

export function bandForFreq(freq: number): RfBand | null {
  if (freq >= 2400 && freq < 2500) return '2.4';
  if (freq >= 4900 && freq < 5925) return '5';
  if (freq >= 5925 && freq <= 7125) return '6';
  return null;
}

export function channelForFreq(freq: number): number | null {
  const band = bandForFreq(freq);
  if (band === '2.4') return freq === 2484 ? 14 : Math.round((freq - 2407) / 5);
  if (band === '5') return Math.round((freq - 5000) / 5);
  if (band === '6') return Math.round((freq - 5950) / 5);
  return null;
}

/**
 * Operating width in MHz from a RouterOS width string.
 *
 * RouterOS reports a *capability* list such as `20/40/80mhz` on a radio configured
 * to bond opportunistically, and a single value such as `20mhz` when pinned. The
 * widest entry is taken, because that is the spectrum the radio may occupy and
 * therefore the spectrum a planner must treat as unavailable.
 */
export function widthMhz(width: string | null | undefined): number {
  if (!width) return 20;
  const all = (width.match(/\d+/g) || []).map(Number).filter((v) => v >= 20 && v <= 320);
  return all.length ? Math.max(...all) : 20;
}

export interface RadioSpectrum {
  centerMhz: number;
  widthMhz: number;
  lowMhz: number;
  highMhz: number;
  band: RfBand | null;
  channel: number | null;
}

/** The slice of spectrum a radio actually occupies. */
export function spectrumFor(freq: number, width?: string | null): RadioSpectrum {
  const w = widthMhz(width);
  return {
    centerMhz: freq,
    widthMhz: w,
    lowMhz: freq - w / 2,
    highMhz: freq + w / 2,
    band: bandForFreq(freq),
    channel: channelForFreq(freq),
  };
}

export type OverlapKind = 'clear' | 'co-channel' | 'partial';

/**
 * How two occupied ranges relate.
 *
 * Identical ranges are co-channel: the radios decode each other and share airtime.
 * Anything else that intersects — including one range nested inside a wider one —
 * is partial, because the two cannot reliably carrier-sense one another.
 */
export function classifyPair(a: RadioSpectrum, b: RadioSpectrum): OverlapKind {
  if (a.band !== b.band) return 'clear';
  const overlap = Math.min(a.highMhz, b.highMhz) - Math.max(a.lowMhz, b.lowMhz);
  if (overlap <= 0) return 'clear';
  if (a.lowMhz === b.lowMhz && a.highMhz === b.highMhz) return 'co-channel';
  return 'partial';
}

/** How much spectrum two radios share, in MHz. */
export function overlapMhz(a: RadioSpectrum, b: RadioSpectrum): number {
  if (a.band !== b.band) return 0;
  return Math.max(0, Math.min(a.highMhz, b.highMhz) - Math.max(a.lowMhz, b.lowMhz));
}

const SEVERITY: Record<OverlapKind, number> = { clear: 0, 'co-channel': 1, partial: 2 };

export interface Clash {
  /** Index into the input array of the other radio. */
  with: number;
  kind: Exclude<OverlapKind, 'clear'>;
  overlapMhz: number;
}

export interface RadioVerdict {
  spectrum: RadioSpectrum;
  /** The worst relationship this radio has with any other. */
  kind: OverlapKind;
  clashes: Clash[];
}

/**
 * Classify every radio against every other. Order-independent and symmetric.
 *
 * Radios on different bands never clash, and a radio is never compared with
 * itself — a single AP is `clear`, not co-channel with its own reflection.
 */
export function analyzeSpectrum(
  radios: { frequency: number; channel_width?: string | null }[]
): RadioVerdict[] {
  const spectra = radios.map((r) => spectrumFor(r.frequency, r.channel_width));

  return spectra.map((s, i) => {
    const clashes: Clash[] = [];
    let worst: OverlapKind = 'clear';

    for (let j = 0; j < spectra.length; j++) {
      if (i === j) continue;
      const kind = classifyPair(s, spectra[j]);
      if (kind === 'clear') continue;
      clashes.push({ with: j, kind, overlapMhz: overlapMhz(s, spectra[j]) });
      if (SEVERITY[kind] > SEVERITY[worst]) worst = kind;
    }

    // Worst first, so the UI leads with the problem rather than a benign neighbour.
    clashes.sort((a, b) => SEVERITY[b.kind] - SEVERITY[a.kind] || b.overlapMhz - a.overlapMhz);
    return { spectrum: s, kind: worst, clashes };
  });
}

export interface SpectrumSummary {
  radios: number;
  clear: number;
  coChannel: number;
  partial: number;
}

export function summarize(verdicts: RadioVerdict[]): SpectrumSummary {
  return {
    radios: verdicts.length,
    clear: verdicts.filter((v) => v.kind === 'clear').length,
    coChannel: verdicts.filter((v) => v.kind === 'co-channel').length,
    partial: verdicts.filter((v) => v.kind === 'partial').length,
  };
}

/**
 * Contiguous stretches of a band that no radio occupies — where an additional AP
 * could go without partially overlapping anything already deployed.
 *
 * Only spans at least `minWidth` wide are returned, since a 5 MHz gap between two
 * 20 MHz radios is not somewhere you can put an access point.
 */
export function freeSpans(
  verdicts: RadioVerdict[],
  band: RfBand,
  minWidth = 20
): { startMhz: number; endMhz: number }[] {
  const range = BAND_RANGES.find((b) => b.band === band);
  if (!range) return [];

  const occupied = verdicts
    .filter((v) => v.spectrum.band === band)
    .map((v) => ({ lo: Math.max(v.spectrum.lowMhz, range.startMhz), hi: Math.min(v.spectrum.highMhz, range.endMhz) }))
    .filter((o) => o.hi > o.lo)
    .sort((a, b) => a.lo - b.lo);

  const spans: { startMhz: number; endMhz: number }[] = [];
  let cursor = range.startMhz;
  for (const o of occupied) {
    if (o.lo - cursor >= minWidth) spans.push({ startMhz: cursor, endMhz: o.lo });
    cursor = Math.max(cursor, o.hi);
  }
  if (range.endMhz - cursor >= minWidth) spans.push({ startMhz: cursor, endMhz: range.endMhz });
  return spans;
}

/**
 * Parse a RouterOS channel specification into frequency and width.
 *
 * Format is `<freq>/<phy>[/<control-positions>]`, e.g. `2412/ax/Ce` or
 * `5680/ax/eCee/D`. The control-position letters count the 20 MHz subchannels the
 * radio is bonding, so `Ce` is 40 MHz and `Ceee` is 80 MHz — a precise operating
 * width rather than the capability list a width field reports.
 *
 * Needed because a CAPsMAN-managed AP stores no frequency of its own: the
 * controller owns the channel, and reports it only in this form (issue #97).
 */
export function parseChannelSpec(spec: string | null | undefined): { frequency: number; widthMhz: number } | null {
  if (!spec) return null;
  const segs = spec.split('/');
  const frequency = parseInt(segs[0], 10);
  if (!frequency || isNaN(frequency)) return null;

  const letters = (segs[2] || '').replace(/[^a-zA-Z]/g, '').length;
  const widthMhz = letters >= 8 ? 160 : letters >= 4 ? 80 : letters >= 2 ? 40 : 20;
  return { frequency, widthMhz };
}
