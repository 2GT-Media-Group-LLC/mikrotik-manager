/**
 * Which newly stored log lines raise an alert (outside review P2-18).
 *
 * Only lines this poll stored count, so a line can't alert twice and a line
 * isn't missed for having an odd timestamp. Of those, only recent ones: the
 * first poll of a newly added device stores its whole log backlog, and errors
 * from last week aren't news. The newest error and the newest warning each
 * raise one alert; the alert cooldown handles the rest.
 */
const RECENT_MS = 15 * 60_000;

export function logAlertCandidates<T extends { id: number; severity: string; event_time: Date | string }>(
  stored: T[], now = new Date(),
): T[] {
  const recent = stored.filter((e) => Math.abs(now.getTime() - new Date(e.event_time).getTime()) <= RECENT_MS);
  const newest = (sev: string) => recent.filter((e) => e.severity === sev).sort((a, b) => b.id - a.id)[0];
  return [newest('error'), newest('warning')].filter((e): e is T => !!e);
}
