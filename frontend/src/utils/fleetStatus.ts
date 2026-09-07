/**
 * Resolves the dashboard's headline device status.
 *
 * Exists because the summary can legitimately be *absent* rather than zero, and
 * the two are not the same claim. Switching site remounts the tree against an
 * empty cache (see SiteScopedQueryProvider), so there is always a moment with no
 * summary — which rendered "undefined device(s) unreachable". Substituting 0
 * would have been just as wrong in the other direction: reporting a healthy
 * fleet we have not heard from yet.
 *
 * A site with no devices is a third distinct state, and one multi-site makes
 * ordinary: "0 devices unreachable" is technically true and reads as nonsense.
 */

export interface FleetSummaryDevices {
  total: number;
  online: number;
  offline: number;
}

export type FleetStatusKind = 'loading' | 'empty' | 'healthy' | 'degraded';

export interface FleetStatus {
  kind: FleetStatusKind;
  /** Compact label for the summary header. */
  headline: string;
  /** Sentence form for the operations hero. */
  sentence: string;
  tone: 'neutral' | 'good' | 'warn';
}

export function fleetStatus(devices?: FleetSummaryDevices | null): FleetStatus {
  if (!devices) {
    return { kind: 'loading', headline: 'Checking…', sentence: 'Checking…', tone: 'neutral' };
  }
  if (devices.total === 0) {
    return {
      kind: 'empty',
      headline: 'No devices yet',
      sentence: 'No devices in this site yet.',
      tone: 'neutral',
    };
  }
  if (devices.offline === 0) {
    return {
      kind: 'healthy',
      headline: 'All systems nominal',
      sentence: "Everything's running.",
      tone: 'good',
    };
  }
  const n = devices.offline;
  const noun = `device${n === 1 ? '' : 's'}`;
  return {
    kind: 'degraded',
    headline: `${n} ${noun} unreachable`,
    sentence: `${n} ${noun} unreachable.`,
    tone: 'warn',
  };
}
