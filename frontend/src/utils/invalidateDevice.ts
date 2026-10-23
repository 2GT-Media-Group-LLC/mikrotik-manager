import type { QueryClient } from '@tanstack/react-query';

/**
 * After a Sync, refresh everything shown for that device: the header, every
 * tab's data, live or stored. Device queries carry the device id as a key
 * element (['vlans', 7], ['routing-ipv6', 7], ...), so matching on it covers
 * tabs added later too. Only queries on screen refetch; the rest are marked
 * stale and reload when opened.
 */
export function invalidateDevice(qc: QueryClient, deviceId: number): Promise<void> {
  return qc.invalidateQueries({
    predicate: (q) => q.queryKey.slice(1).includes(deviceId),
  });
}
