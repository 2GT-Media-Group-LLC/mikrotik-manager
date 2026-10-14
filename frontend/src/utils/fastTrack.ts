/**
 * FastTracked connections skip simple queues (#280), so a bandwidth limit on a
 * device that FastTracks can quietly do nothing for most of the traffic.
 */
export type FilterRule = Record<string, string | undefined>;

/** The enabled FastTrack rules in a device's IPv4 filter table. */
export function activeFastTrackRules(rules: FilterRule[] | undefined): FilterRule[] {
  return (rules ?? []).filter((r) =>
    r.action === 'fasttrack-connection' && r.disabled !== 'true' && r.invalid !== 'true');
}
