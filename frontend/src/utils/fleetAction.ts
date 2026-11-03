import type { OpsActionResult } from '../services/api';

export interface FleetFailure { id?: number; name: string; error: string }

export interface FleetActionSummary {
  text: string;
  /** 'good' when every device worked, 'warn' when some did, 'bad' when none did. */
  tone: 'good' | 'warn' | 'bad';
  failures: FleetFailure[];
}

/**
 * What Backup all and Sync config say when they finish. The server reports
 * each device's error, but the dashboard used to show only the count, so
 * "Backed up 2/5 devices" left no way to tell which 3 failed or why (#392).
 */
export function fleetActionSummary(done: string, data: OpsActionResult): FleetActionSummary {
  const ok = data.results.filter((r) => r.ok).length;
  const failures = data.results
    .filter((r) => !r.ok)
    .map((r) => ({ id: r.id, name: r.name, error: r.error?.trim() || 'No reason given' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const text = `${done} ${ok}/${data.total} device${data.total !== 1 ? 's' : ''}`;
  const tone = failures.length === 0 ? 'good' : ok > 0 ? 'warn' : 'bad';
  return { text, tone, failures };
}
