import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldBan } from 'lucide-react';
import { trafficApi } from '../../services/api';

/**
 * The names looked up through AdGuard Home (#366 step 3), busiest first, with
 * how many were blocked: for the site, or for one client.
 */
export default function DnsNamesList({ range, mac, limit = 30, className }: { range: string; mac?: string; limit?: number; className?: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['traffic-dns-names', range, mac, limit],
    queryFn: () => trafficApi.dnsNames({ range, mac, limit }).then((r) => r.data),
  });
  if (isLoading) return <div className="p-6 text-center text-sm text-gray-400">Loading…</div>;
  if (isError || !data) return <div className="p-6 text-center text-sm text-red-500">DNS lookups could not be read right now.</div>;
  if (!data.configured) {
    return (
      <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">
        Add your AdGuard Home or Pi-hole servers under <Link to="/settings?tab=dns" className="underline">Settings → DNS Query Log</Link> to see the names clients look up.
      </div>
    );
  }
  if (mac && data.client_addresses && data.client_addresses.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">This client has no known address to match the DNS servers&apos; logs against.</div>;
  }
  if (data.names.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No lookups in this range.</div>;
  }
  const max = Math.max(1, ...data.names.map((n) => n.allowed + n.blocked));
  return (
    <div className={className}>
      <div className="px-5 py-2 text-xs text-gray-500 dark:text-slate-400">
        {(data.allowed + data.blocked).toLocaleString()} lookups, {data.blocked.toLocaleString()} blocked
        {mac && data.client_addresses && ` · ${data.client_addresses.join(', ')}`}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {data.names.map((n) => (
          <div key={n.name} className="px-5 py-1.5">
            <div className="flex items-center gap-2 text-sm">
              {n.blocked > 0 && n.allowed === 0 && <ShieldBan className="w-3.5 h-3.5 text-red-500 flex-shrink-0" aria-label="Blocked" />}
              <span className="font-mono text-xs text-gray-800 dark:text-slate-200 truncate flex-1" title={n.name}>{n.name}</span>
              {!mac && <span className="text-xs text-gray-400 w-16 text-right">{n.clients} client{n.clients === 1 ? '' : 's'}</span>}
              {n.blocked > 0 && <span className="text-xs text-red-600 dark:text-red-400 w-20 text-right">{n.blocked.toLocaleString()} blocked</span>}
              <span className="text-xs font-semibold text-gray-700 dark:text-slate-200 w-14 text-right">{(n.allowed + n.blocked).toLocaleString()}</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden flex">
              <div className="h-full bg-sky-500" style={{ width: `${(n.allowed / max) * 100}%` }} />
              <div className="h-full bg-red-500" style={{ width: `${(n.blocked / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
