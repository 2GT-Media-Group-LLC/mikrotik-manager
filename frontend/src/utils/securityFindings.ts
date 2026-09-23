import type { SecurityCheck } from '../services/api';

/**
 * Counting security findings, once.
 *
 * A finding an operator has muted is shown greyed with the words "not counted"
 * on it, and is excluded from the hardening score by the server. Every *count*
 * in the UI ignored that and included it anyway, so a device with three
 * findings and two muted still read "3 issues found", and the fleet table still
 * showed `1 med 2 low` (#157). The same row said "not counted" directly beneath
 * the number counting it.
 *
 * The cause was that each site filtered `checks` inline for its own purposes
 * and none of them knew about suppression. Counting lives here now so a fourth
 * call site cannot reintroduce it.
 *
 * Suppressed findings are deliberately still *rendered* — hiding them outright
 * would make the posture unauditable, which is why the server marks rather than
 * removes them.
 */

/** Findings that still count against the device. */
export function activeChecks(checks: SecurityCheck[]): SecurityCheck[] {
  return checks.filter((c) => !c.suppressed);
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
}

/** Counts by severity, muted findings excluded. `ok` entries are not findings. */
export function countFindings(checks: SecurityCheck[]): SeverityCounts {
  const active = activeChecks(checks);
  return {
    high: active.filter((c) => c.severity === 'high').length,
    medium: active.filter((c) => c.severity === 'medium').length,
    low: active.filter((c) => c.severity === 'low').length,
    total: active.length,
  };
}

/** How many of a device's findings are muted, for "and 2 muted" style wording. */
export function mutedCount(checks: SecurityCheck[]): number {
  return checks.length - activeChecks(checks).length;
}
