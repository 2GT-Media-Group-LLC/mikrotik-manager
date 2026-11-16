/**
 * Traceroute hops from RouterOS's /tool/traceroute rows (#460).
 *
 * RouterOS (6 and 7 alike) answers with a full snapshot of the route each
 * time a round of probes returns, every hop in order, each snapshot marked by
 * its own `.section`. The last snapshot is the most complete. Rows used to be
 * keyed on an `id` field neither version sends, so every hop was dropped and
 * Traceroute showed no results.
 */
export function tracerouteHops(rows: Record<string, string>[]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const sections = rows.map((r) => Number(r['.section']));
  if (sections.some((s) => !Number.isFinite(s))) return rows.map(({ '.section': _s, ...r }) => r);
  const last = Math.max(...sections);
  return rows
    .filter((r) => Number(r['.section']) === last)
    .map(({ '.section': _s, ...r }) => r);
}
