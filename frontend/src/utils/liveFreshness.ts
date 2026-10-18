/**
 * Fleet pages served from the live cache (#302): rows carry when they were
 * read from the device and whether a refresh is under way.
 */
export interface LiveRow { fetched_at?: string | null; refreshing?: boolean }

/** Re-check every few seconds while any device is being refreshed, otherwise not at all. */
export function liveRefetch(rows: LiveRow[] | undefined): number | false {
  return rows?.some((r) => r.refreshing) ? 4_000 : false;
}

/** "Updated 3 min ago", from the oldest row, and how many are still refreshing. */
export function freshnessLabel(rows: LiveRow[] | undefined): string {
  if (!rows?.length) return '';
  const refreshing = rows.filter((r) => r.refreshing).length;
  const times = rows.map((r) => (r.fetched_at ? Date.parse(r.fetched_at) : NaN)).filter((t) => !Number.isNaN(t));
  const oldest = times.length ? Math.min(...times) : null;
  const ago = oldest == null ? '' : (() => {
    const m = Math.round((Date.now() - oldest) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  })();
  return [ago && `Read from devices ${ago}`, refreshing && `refreshing ${refreshing}`].filter(Boolean).join(' · ');
}
