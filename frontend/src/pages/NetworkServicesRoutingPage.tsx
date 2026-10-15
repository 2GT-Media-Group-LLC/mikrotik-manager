import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw, Route as RouteIcon } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import { routingApi, type RoutingPeerRow } from '../services/api';
import { FilterBar, FilterSearch, FilterSelect } from '../components/common/FilterBar';

function StateBadge({ p }: { p: RoutingPeerRow }) {
  const cls = p.disabled
    ? 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400'
    : p.up
      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  return <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', cls)}>{p.state}</span>;
}

/**
 * Every BGP peer and OSPF neighbour across the fleet (#279), from the slow
 * polls: what's up, what's down and since when. Configuring them stays on each
 * device's Routing tab; the "Routing peer down" alert rule reports drops.
 */
export default function NetworkServicesRoutingPage() {
  const [search, setSearch] = useState('');
  const [protocol, setProtocol] = useState('');
  const [state, setState] = useState('');
  const { data: peers = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['routing-peers'],
    queryFn: () => routingApi.peers().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const shown = useMemo(() => peers.filter((p) => {
    if (protocol && p.protocol !== protocol) return false;
    if (state === 'down' && (p.up || p.disabled)) return false;
    if (state === 'up' && !p.up) return false;
    const q = search.trim().toLowerCase();
    if (q && ![p.device_name, p.name, p.remote_address, p.remote_as, p.remote_id, p.instance]
      .some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    return true;
  }), [peers, protocol, state, search]);

  const down = peers.filter((p) => !p.up && !p.disabled).length;
  const bgp = peers.filter((p) => p.protocol === 'bgp').length;
  const ospf = peers.filter((p) => p.protocol === 'ospf').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Routing</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            BGP peers and OSPF neighbours across the fleet, refreshed with each slow poll. Set them up on a
            device&apos;s Routing tab; turn on the <Link to="/settings" className="text-blue-600 dark:text-blue-400 hover:underline">Routing peer down</Link> alert
            to hear when one drops.
          </p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 text-sm">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'BGP peers', value: bgp },
          { label: 'OSPF neighbours', value: ospf },
          { label: 'Down', value: down, bad: down > 0 },
        ].map((c) => (
          <div key={c.label} className="card px-4 py-3">
            <div className="text-xs text-gray-500 dark:text-slate-400">{c.label}</div>
            <div className={clsx('text-2xl font-bold', c.bad ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white')}>{c.value}</div>
          </div>
        ))}
      </div>

      <FilterBar>
        <FilterSearch value={search} onChange={setSearch} placeholder="Filter by device, peer, address, AS…" />
        <FilterSelect value={protocol} onChange={setProtocol} title="Protocol">
          <option value="">BGP and OSPF</option>
          <option value="bgp">BGP</option>
          <option value="ospf">OSPF</option>
        </FilterSelect>
        <FilterSelect value={state} onChange={setState} title="State">
          <option value="">Any state</option>
          <option value="down">Down</option>
          <option value="up">Up</option>
        </FilterSelect>
      </FilterBar>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="py-10 text-center text-gray-400">Loading…</div>
        ) : peers.length === 0 ? (
          <div className="py-10 text-center text-gray-400 dark:text-slate-500 flex flex-col items-center gap-2">
            <RouteIcon className="w-6 h-6" />
            No BGP peers or OSPF neighbours found. They appear here after the next slow poll of a device that has them.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 text-left">
                {['Device', 'Protocol', 'Peer', 'Remote', 'State', 'Up for', 'Prefixes', 'Last change'].map((h) => (
                  <th key={h} className="table-header px-4 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {shown.map((p) => (
                <tr key={`${p.device_id}-${p.protocol}-${p.peer_key}`} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2">
                    <Link to={`/devices/${p.device_id}?tab=routing`} className="text-blue-600 dark:text-blue-400 hover:underline">{p.device_name}</Link>
                    {p.device_status !== 'online' && <span className="ml-1.5 text-xs text-gray-400">({p.device_status})</span>}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs uppercase text-gray-600 dark:text-slate-300">{p.protocol}</td>
                  <td className="px-4 py-2">
                    <div className="font-mono text-xs text-gray-900 dark:text-white">{p.name || '—'}</div>
                    {(p.instance || p.detail) && <div className="text-xs text-gray-400">{[p.instance, p.detail].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">
                    {p.remote_address || '—'}
                    {p.remote_as && <span className="text-gray-400"> · AS {p.remote_as}</span>}
                    {p.protocol === 'bgp' && p.remote_id && p.remote_id !== p.remote_address && <div className="text-gray-400">id {p.remote_id}</div>}
                  </td>
                  <td className="px-4 py-2"><StateBadge p={p} /></td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{p.up && p.uptime ? (p.uptime.replace(/\d+ms$/, '') || p.uptime) : '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{p.prefix_count ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400" title={new Date(p.last_change_at).toLocaleString()}>
                    {formatDistanceToNow(new Date(p.last_change_at), { addSuffix: true })}
                    {!p.up && !p.disabled && !p.last_up_at && <div className="text-gray-400">never up</div>}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">Nothing matches the filters.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
