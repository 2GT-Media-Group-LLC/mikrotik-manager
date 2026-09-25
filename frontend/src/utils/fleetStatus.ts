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
  /** Unreachable, not counting devices marked intermittent. */
  offline: number;
  /** Reachable, with a hardware problem (#168). */
  degraded?: number;
  /** Intermittent devices currently offline, which is expected. */
  intermittent_offline?: number;
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
  const n = devices.offline;
  const d = devices.degraded ?? 0;
  const plural = (k: number) => `device${k === 1 ? '' : 's'}`;
  if (n === 0 && d === 0) {
    return {
      kind: 'healthy',
      headline: 'All systems nominal',
      sentence: "Everything's running.",
      tone: 'good',
    };
  }
  const parts = [
    n > 0 ? `${n} ${plural(n)} unreachable` : null,
    d > 0 ? `${d} ${n > 0 ? '' : `${plural(d)} `}degraded` : null,
  ].filter(Boolean).map((p) => (p as string).replace(/\s+/g, ' ').trim());
  return {
    kind: 'degraded',
    headline: parts.join(' · '),
    sentence: `${parts.join(', ')}.`,
    tone: 'warn',
  };
}
