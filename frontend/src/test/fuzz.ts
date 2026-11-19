/**
 * Settings for the property-based fuzz tests (`*.fuzz.test.ts`), as in the
 * backend: a few hundred cases per property in CI, FUZZ_RUNS more in the
 * scheduled Fuzz workflow, FUZZ_SEED to replay a failure.
 */
import type { Parameters } from 'fast-check';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const runs = Number(env.FUZZ_RUNS);
export const FUZZ_RUNS = Number.isSafeInteger(runs) && runs > 0 ? runs : 300;

export function fuzz<T>(extra: Parameters<T> = {}): Parameters<T> {
  const seed = Number(env.FUZZ_SEED);
  return { numRuns: FUZZ_RUNS, ...(env.FUZZ_SEED && Number.isSafeInteger(seed) ? { seed } : {}), ...extra };
}

export const FUZZ_TIMEOUT_MS = Math.max(30_000, FUZZ_RUNS * 20);
