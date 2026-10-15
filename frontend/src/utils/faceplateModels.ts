/**
 * Built-in faceplate layouts per device model, so the diagram matches the
 * physical front panel without the operator choosing anything.
 *
 * To add a model: add one entry to MODEL_LAYOUTS keyed by the model string as
 * RouterOS reports it (matched case-insensitively). Only list what has been
 * verified against the real panel; omitted fields keep the generic behaviour.
 * A localStorage choice (`faceplate.evenTop.<model>`) still overrides
 * `etherEvenOnTop`.
 */
import { chunkRows, staggerBlocks, type StaggerBlock } from './faceplateLayout';

export type SfpLayout =
  /** One unwrapped row, left to right. */
  | { rows: 1 }
  /** Two rows in banks of four: 2 4 over 1 3, then 6 8 over 5 7. */
  | { rows: 2; evenOnTop: true };

export interface ModelLayout {
  /** Ethernet ports: 2 4 6.. on the top row. */
  etherEvenOnTop?: boolean;
  /** SFP / SFP+ / SFP28 cages. */
  sfp?: SfpLayout;
  /** QSFP cages stacked in pairs, 2 over 1. */
  qsfpStacked?: boolean;
}

export const MODEL_LAYOUTS: Record<string, ModelLayout> = {
  'CRS354-48P-4S+2Q+': { etherEvenOnTop: true, sfp: { rows: 2, evenOnTop: true }, qsfpStacked: true },
  'CRS510-8XS-2XQ': { sfp: { rows: 2, evenOnTop: true }, qsfpStacked: true },
  'CRS317-1G-16S+': { sfp: { rows: 1 } },
  // Ethers verified on the physical unit; SFP+ layout not verified.
  'CRS328-24P-4S+': { etherEvenOnTop: true },
};

const NORMALISED = new Map(
  Object.entries(MODEL_LAYOUTS).map(([k, v]) => [k.trim().toLowerCase(), v]),
);

/** Case-insensitive lookup on the device model string, with or without a `RB`-style suffix like `-RM`. */
export function lookupModelLayout(model: string | null | undefined): ModelLayout | undefined {
  const m = (model || '').trim().toLowerCase();
  if (!m) return undefined;
  const exact = NORMALISED.get(m);
  if (exact) return exact;
  // Rackmount / revision suffixes ("CRS317-1G-16S+RM") still match their base model.
  for (const [k, v] of NORMALISED) {
    if (m.startsWith(k) && /^(rm|-rm|r\d*)$/.test(m.slice(k.length))) return v;
  }
  return undefined;
}

/** Stored choice wins; otherwise the model default; otherwise odd on top. */
export function resolveEvenOnTop(stored: string | null, layout: ModelLayout | undefined): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return !!layout?.etherEvenOnTop;
}

export type SfpArrangement<T> =
  | { kind: 'rows'; rows: T[][] }
  | { kind: 'banks'; banks: StaggerBlock<T>[] };

/** Arrange individual SFP ports. Unknown models: plain wrapped rows, as before. */
export function arrangeSfp<T>(ports: T[], layout: ModelLayout | undefined, columns: number): SfpArrangement<T> {
  const sfp = layout?.sfp;
  if (!sfp) return { kind: 'rows', rows: chunkRows(ports, columns) };
  if (sfp.rows === 1) return { kind: 'rows', rows: ports.length ? [ports] : [] };
  return { kind: 'banks', banks: staggerBlocks(ports, 2, true) };
}

/** Cages stacked in pairs: even-numbered cage above its odd neighbour. */
export function stackCages<T>(cages: T[]): StaggerBlock<T>[] {
  const out: StaggerBlock<T>[] = [];
  for (let i = 0; i < cages.length; i += 2) {
    const pair = cages.slice(i, i + 2);
    out.push(pair.length === 2 ? { top: [pair[1]], bottom: [pair[0]] } : { top: pair, bottom: [] });
  }
  return out;
}

/** The boxes a cage draws: its one real port, or its real breakout lanes. */
export function cageTiles<T>(cage: { lanes: T[]; singlePort?: T }): T[] {
  return cage.singlePort ? [cage.singlePort] : cage.lanes;
}
