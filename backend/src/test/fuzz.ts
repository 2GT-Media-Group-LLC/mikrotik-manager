/**
 * Settings for the property-based fuzz tests (`*.fuzz.test.ts`).
 *
 * Normal CI runs a few hundred generated cases per property, so the suite stays
 * fast. The scheduled Fuzz workflow sets FUZZ_RUNS much higher. A failure
 * prints its seed and path; FUZZ_SEED replays it:
 *
 *   FUZZ_SEED=-123456 FUZZ_RUNS=1 npx jest decoder.fuzz
 */
import type { Parameters } from 'fast-check';

const runs = Number(process.env.FUZZ_RUNS);
export const FUZZ_RUNS = Number.isSafeInteger(runs) && runs > 0 ? runs : 300;

export function fuzz<T>(extra: Parameters<T> = {}): Parameters<T> {
  const seed = Number(process.env.FUZZ_SEED);
  return { numRuns: FUZZ_RUNS, ...(Number.isSafeInteger(seed) && process.env.FUZZ_SEED ? { seed } : {}), ...extra };
}

/**
 * Properties that make an HTTP request per case stop here: each opens a
 * connection, and tens of thousands in seconds run the machine out of local
 * ports.
 */
export const HTTP_RUNS = 5000;

/** Jest timeout for a fuzz test: generous when FUZZ_RUNS is raised. */
export const FUZZ_TIMEOUT_MS = Math.max(30_000, FUZZ_RUNS * 20);
