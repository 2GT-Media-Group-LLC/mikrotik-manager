import { useEffect, useRef, useState } from 'react';
import { operationsApi } from '../services/api';

/**
 * A fleet page's Refresh for data the poller stores (clients, wireless, routing
 * peers, logs): ask the devices in view for a fresh poll, then read again as the
 * polls land over the next few seconds. Without the poll, Refresh only
 * re-read what the last scheduled poll had stored, and nothing changed.
 */
export function useFleetRefresh(kinds: Array<'fast' | 'slow' | 'logs'>, refetch: () => unknown) {
  const [busy, setBusy] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);

  const run = async () => {
    setBusy(true);
    // A viewer, or a poller that isn't up, still gets a plain re-read.
    await Promise.allSettled(kinds.map((k) => operationsApi.pollNow(k)));
    void refetch();
    for (const ms of [4_000, 10_000, 20_000]) {
      timers.current.push(window.setTimeout(() => {
        void refetch();
        if (ms === 10_000) setBusy(false);
      }, ms));
    }
  };
  return { refresh: run, refreshing: busy };
}
