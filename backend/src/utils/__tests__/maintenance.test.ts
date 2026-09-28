import { windowCovers, type MaintenanceWindowRow } from '../maintenance';

const w = (over: Partial<MaintenanceWindowRow>): MaintenanceWindowRow => ({
  device_ids: [], start_at: '2026-09-01T02:00:00Z', end_at: '2026-09-01T04:00:00Z',
  recurring_cron: null, active: true, ...over,
});
const at = (iso: string) => new Date(iso);

describe('windowCovers', () => {
  it('covers every device when no devices are listed (what the UI saved)', () => {
    expect(windowCovers(w({}), 8, at('2026-09-01T03:00:00Z'))).toBe(true);
    expect(windowCovers(w({}), 1, at('2026-09-01T03:00:00Z'))).toBe(true);
  });

  it('covers only the listed devices when there are some', () => {
    expect(windowCovers(w({ device_ids: [8] }), 8, at('2026-09-01T03:00:00Z'))).toBe(true);
    expect(windowCovers(w({ device_ids: [8] }), 1, at('2026-09-01T03:00:00Z'))).toBe(false);
  });

  it('respects the one-off span and the active flag', () => {
    expect(windowCovers(w({}), 8, at('2026-09-01T04:30:00Z'))).toBe(false);
    expect(windowCovers(w({ active: false }), 8, at('2026-09-01T03:00:00Z'))).toBe(false);
  });

  it('repeats a weekly window on later weeks, for its duration', () => {
    // Sundays 02:00-04:00 UTC; first occurrence Sunday 6 September.
    const weekly = w({ start_at: '2026-09-06T02:00:00Z', end_at: '2026-09-06T04:00:00Z', recurring_cron: '0 2 * * 0' });
    expect(windowCovers(weekly, 8, at('2026-09-27T03:15:00Z'))).toBe(true);   // three Sundays later
    expect(windowCovers(weekly, 8, at('2026-09-27T04:30:00Z'))).toBe(false);  // after that occurrence
    expect(windowCovers(weekly, 8, at('2026-09-28T03:00:00Z'))).toBe(false);  // a Monday
    expect(windowCovers(weekly, 8, at('2026-08-30T03:00:00Z'))).toBe(false);  // before the first
  });

  it('evaluates the repeat in the manager time zone', () => {
    // Daily 02:00 in New York is 06:00 UTC (EDT).
    const daily = w({ start_at: '2026-09-01T06:00:00Z', end_at: '2026-09-01T07:00:00Z', recurring_cron: '0 2 * * *' });
    expect(windowCovers(daily, 8, at('2026-09-20T06:30:00Z'), 'America/New_York')).toBe(true);
    expect(windowCovers(daily, 8, at('2026-09-20T02:30:00Z'), 'America/New_York')).toBe(false);
  });
});
