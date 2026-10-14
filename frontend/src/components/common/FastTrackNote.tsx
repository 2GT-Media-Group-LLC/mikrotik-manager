import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { devicesApi } from '../../services/api';
import { activeFastTrackRules } from '../../utils/fastTrack';

/**
 * Shown where a simple queue is created, only when the device FastTracks
 * connections: FastTracked traffic skips queues (#280). Shares the Firewall
 * tab's query, so it costs nothing when that tab has been opened.
 */
export default function FastTrackNote({ deviceId, compact = false }: { deviceId: number; compact?: boolean }) {
  const { data } = useQuery({
    queryKey: ['firewall', deviceId],
    queryFn: () => devicesApi.getFirewall(deviceId).then((r) => r.data as Record<string, string>[]),
    staleTime: 60_000,
    retry: false,
  });
  if (activeFastTrackRules(data).length === 0) return null;
  return (
    <div className={`flex gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 ${compact ? 'p-2 text-[10px]' : 'p-2.5 text-xs'}`}>
      <AlertTriangle className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} flex-shrink-0 mt-0.5`} />
      <p>
        This device FastTracks connections, and FastTracked traffic skips queues, so this limit
        only applies to traffic that isn&apos;t FastTracked. To limit this target, exclude it from
        FastTrack (for example, an accept rule above the FastTrack rule) or turn FastTrack off.
      </p>
    </div>
  );
}
