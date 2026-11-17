import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Globe, Home, ChevronRight, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { trafficApi, type RemoteOwner, type TrafficDestination } from '../../services/api';
import { formatBytes } from '../../utils/formatBytes';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';

/**
 * Where traffic goes (#366 step 2): the busiest remote addresses for a site,
 * an application, a client, or a client's use of one application. Each names
 * the organisation that owns the address, its reverse DNS name and, with
 * AdGuard Home connected, the names clients looked up to reach it.
 */

const KIND_LABEL: Record<RemoteOwner['kind'], string> = {
  public: '', private: 'Private network', loopback: 'Loopback', 'link-local': 'Link-local',
  multicast: 'Multicast', cgnat: 'Carrier-grade NAT', reserved: 'Reserved', other: 'Other',
};

/** The organisation (or kind of address), then the best name for the address itself. */
export function ownerLabel(d: RemoteOwner): string {
  if (d.kind !== 'public') return KIND_LABEL[d.kind];
  return d.org ?? 'Unknown owner';
}

export function OwnerLine({ d, remote }: { d: RemoteOwner; remote: string }) {
  const domain = d.domains?.[0];
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {d.kind === 'public'
          ? <Globe className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          : <Home className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{domain ?? ownerLabel(d)}</span>
        {domain && <span className="text-xs text-gray-500 dark:text-slate-400 truncate">{ownerLabel(d)}</span>}
        {d.country && <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 flex-shrink-0">{d.country}</span>}
      </div>
      <div className="font-mono text-xs text-gray-400 dark:text-slate-500 truncate" title={[remote, d.name, d.asn ? `AS${d.asn}` : ''].filter(Boolean).join(' · ')}>
        {remote}{d.name ? ` · ${d.name}` : ''}{d.asn ? ` · AS${d.asn}` : ''}
        {d.domains && d.domains.length > 1 && ` · also ${d.domains.slice(1, 3).join(', ')}`}
      </div>
    </div>
  );
}

/** The clients behind one address, opened from a destination row. */
function DestinationClients({ remote, range, app }: { remote: string; range: string; app?: string }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['traffic-destination-clients', remote, range, app],
    queryFn: () => trafficApi.destinationClients(remote, range, app).then((r) => r.data),
  });
  if (isLoading) return <div className="pl-10 py-2 text-xs text-gray-400">Loading…</div>;
  if (isError || !data) return <div className="pl-10 py-2 text-xs text-red-500">The clients could not be read.</div>;
  return (
    <div className="pl-10 pr-5 pb-2 space-y-1">
      {data.clients.map((c) => {
        const isReal = c.mac !== 'unknown' && c.mac !== 'other';
        return (
          <div key={c.mac} onClick={() => isReal && navigate(`/clients/${encodeURIComponent(c.mac)}`)}
            className={clsx('flex items-center gap-2 text-xs', isReal && 'cursor-pointer hover:underline')}>
            <span className="text-gray-700 dark:text-slate-300 truncate flex-1">
              {c.mac === 'unknown' ? 'Unattributed (local)' : c.custom_name || c.hostname || c.vendor || c.mac}
              {isReal && c.ip_address && <span className="ml-1.5 font-mono text-gray-400">{c.ip_address}</span>}
            </span>
            <span className="text-gray-400 truncate max-w-[10rem]">{c.apps.join(', ')}</span>
            <span className="font-medium text-gray-700 dark:text-slate-200 w-20 text-right">{formatBytes(c.total_bytes)}</span>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  range: string;
  app?: string;
  mac?: string;
  /** Rows to show; the API returns up to 200. */
  limit?: number;
  /** Let a row open the clients behind it (not useful when one client is chosen). */
  expandable?: boolean;
  className?: string;
}

export default function DestinationsList({ range, app, mac, limit = 25, expandable = !mac, className }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const { formatDateTime } = useDateTimeFormat();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['traffic-destinations', range, app, mac, limit],
    queryFn: () => trafficApi.destinations({ range, app, mac, limit }).then((r) => r.data),
  });
  if (isLoading) return <div className="p-6 text-center text-sm text-gray-400">Loading…</div>;
  if (isError || !data) return <div className="p-6 text-center text-sm text-red-500">Destinations could not be read right now.</div>;
  if (data.destinations.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">
        No destinations recorded in this range. They&apos;re kept for {data.retention_days} day{data.retention_days === 1 ? '' : 's'}
        {' '}and start from when this version began collecting them.
      </div>
    );
  }
  const max = Math.max(1, ...data.destinations.map((d) => d.total_bytes));
  const row = (d: TrafficDestination) => (
    <div key={d.remote}>
      <div onClick={() => expandable && setOpen(open === d.remote ? null : d.remote)}
        className={clsx('px-5 py-2', expandable && 'cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700/40 transition-colors')}>
        <div className="flex items-center justify-between gap-2 mb-1">
          {expandable && (open === d.remote
            ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />)}
          <div className="flex-1 min-w-0"><OwnerLine d={d} remote={d.remote} /></div>
          {!mac && <span className="text-xs text-gray-400 dark:text-slate-500 flex-shrink-0 w-16 text-right">{d.client_count} client{d.client_count === 1 ? '' : 's'}</span>}
          <span className="text-xs text-gray-500 dark:text-slate-400 flex-shrink-0 w-12 text-right">{(d.share * 100).toFixed(1)}%</span>
          <span className="text-sm font-semibold text-gray-700 dark:text-slate-200 flex-shrink-0 w-20 text-right">{formatBytes(d.total_bytes)}</span>
        </div>
        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
          <div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(2, (d.total_bytes / max) * 100)}%` }} />
        </div>
        <div className="mt-0.5 flex gap-3 text-xs text-gray-400 dark:text-slate-500">
          <span className="inline-flex items-center gap-0.5"><ArrowDown className="w-3 h-3" />{formatBytes(d.download_bytes)}</span>
          <span className="inline-flex items-center gap-0.5"><ArrowUp className="w-3 h-3" />{formatBytes(d.upload_bytes)}</span>
          {!app && d.apps.length > 0 && <span className="truncate">{d.apps.join(', ')}</span>}
        </div>
      </div>
      {open === d.remote && <DestinationClients remote={d.remote} range={range} app={app} />}
    </div>
  );
  return (
    <div className={clsx('divide-y divide-gray-100 dark:divide-slate-800', className)}>
      {data.destinations.map(row)}
      <div className="px-5 py-2 text-xs text-gray-400 dark:text-slate-500 space-y-0.5">
        {data.other_bytes > 0 && (
          <div>{formatBytes(data.other_bytes)} went to addresses beyond each client&apos;s busiest twenty a minute, counted together.</div>
        )}
        {data.recorded_since && (
          <div>Recorded since {formatDateTime(data.recorded_since)}, when collecting began; the range&apos;s earlier hours aren&apos;t here.</div>
        )}
        {!data.names_available && <div>Organisation names aren&apos;t loaded yet, so addresses are shown without them.</div>}
        <div>Kept for {data.retention_days} day{data.retention_days === 1 ? '' : 's'} (Settings → General → Data Retention).</div>
      </div>
    </div>
  );
}
