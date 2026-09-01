/**
 * A single place to reach the running PollerService.
 *
 * Routes receive it by injection from index.ts, which works well for a route
 * module but not for code reached indirectly — the dashboard insights build in
 * a helper that has no injection point of its own. A tiny module-level
 * reference avoids threading the dependency through every caller, and stays
 * null until the poller starts so nothing can accidentally depend on it early.
 */
import type { PollerService } from './PollerService';

export let pollerService: PollerService | null = null;

export function setSharedPollerService(p: PollerService): void {
  pollerService = p;
}
