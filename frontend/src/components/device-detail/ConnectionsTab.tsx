import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Activity, Search } from 'lucide-react';
import { devicesApi } from '../../services/api';
import { formatBytes } from '../../utils/firewallSummary';
import clsx from 'clsx';

// Split a RouterOS connection address ("192.168.1.10:443") into ip + port.
function splitAddr(a?: string): { ip: string; port: string } {
  if (!a) return { ip: '', port: '' };
  const i = a.lastIndexOf(':');
  return i > 0 ? { ip: a.slice(0, i), port: a.slice(i + 1) } : { ip: a, port: '' };
}

const PROTO_COLOR: Record<string, string> = {
  tcp: 'text-blue-600 dark:text-blue-400', udp: 'text-violet-600 dark:text-violet-400',
  icmp: 'text-amber-600 dark:text-amber-400',
};

const LIMITS = [200, 500, 2000];

export default function ConnectionsTab({ deviceId }: { deviceId: number }) {
  const [search, setSearch] = useState('');
  // Only the first rows are read, and refreshing is opt-in: a busy router can
  // track hundreds of thousands of connections (#300).
  const [limit, setLimit] = useState(200);
  const [protocol, setProtocol] = useState('');
  const [auto, setAuto] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['connections', deviceId, limit, protocol],
    queryFn: () => devicesApi.getConnections(deviceId, limit, protocol).then(r => r.data),
    refetchInterval: auto ? 30_000 : false,
  });

  const all = data?.connections ?? [];
  const total = data?.total ?? null;
  const q = search.trim().toLowerCase();
  const rows = q ? all.filter(c => JSON.stringify(c).toLowerCase().includes(q)) : all;

  // Conntrack state: yes / no / auto (auto = active only once firewall/NAT rules exist).
  const tracking = (data?.tracking?.enabled ?? '').toLowerCase();
  const trackLabel = tracking === 'yes' ? 'on' : tracking === 'auto' ? 'auto' : tracking === 'no' ? 'off' : '';
  const trackStyle = tracking === 'yes'
    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
    : tracking === 'no'
    ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
    : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
  const emptyMessage = tracking === 'no'
    ? 'Connection tracking is disabled on this device, so no connections are recorded. Enable it (or add a firewall/NAT rule) to populate this table.'
    : tracking === 'auto'
    ? 'Connection tracking is in auto mode — RouterOS only tracks connections once the device has firewall/NAT/mangle rules. This device has none yet, so the table is empty. It also won’t show hardware-switched (L2) traffic, only what the CPU routes/firewalls.'
    : 'No active connections. Only CPU-processed (routed/firewalled) traffic is tracked — hardware-switched L2 traffic bypasses connection tracking.';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-cyan-50 dark:bg-cyan-900/20 rounded-lg flex items-center justify-center"><Activity className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" /></div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Active Connections <span className="text-gray-400 font-normal">
              ({total !== null ? total.toLocaleString() : all.length.toLocaleString()}{data?.truncated ? `, showing the first ${all.length.toLocaleString()}` : ''})
            </span>
          </h3>
          {trackLabel && (
            <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', trackStyle)}
              title={tracking === 'auto' ? 'Auto: tracking activates only when the device has firewall/NAT rules' : tracking === 'no' ? 'Connection tracking is disabled' : 'Connection tracking is active'}>
              Tracking: {trackLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input py-1.5 text-xs w-auto" value={protocol} onChange={e => setProtocol(e.target.value)} title="Filtered by the router">
            <option value="">All protocols</option><option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">ICMP</option>
          </select>
          <select className="input py-1.5 text-xs w-auto" value={limit} onChange={e => setLimit(Number(e.target.value))} title="How many connections to read from the router">
            {LIMITS.map(l => <option key={l} value={l}>First {l.toLocaleString()}</option>)}
          </select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input className="input pl-8 py-1.5 text-xs w-48" placeholder="Filter shown rows…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Auto-refresh
          </label>
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading connections…</div>
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center text-gray-400 max-w-2xl mx-auto text-sm">{all.length === 0 ? emptyMessage : 'No connections match your filter.'}</div>
      ) : (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-3 py-2.5 text-left">Proto</th>
                <th className="table-header px-3 py-2.5 text-left">Source</th>
                <th className="table-header px-3 py-2.5 text-left">Destination</th>
                <th className="table-header px-3 py-2.5 text-left">State</th>
                <th className="table-header px-3 py-2.5 text-right">Rate ↓/↑</th>
                <th className="table-header px-3 py-2.5 text-right">Bytes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {rows.map((c, i) => {
                const src = splitAddr(c['src-address']);
                const dst = splitAddr(c['dst-address']);
                const proto = (c.protocol || '').toLowerCase();
                const origRate = c['orig-rate'] || '0';
                const replRate = c['repl-rate'] || '0';
                const bytes = (c['orig-bytes'] ? Number(c['orig-bytes']) : 0) + (c['repl-bytes'] ? Number(c['repl-bytes']) : 0);
                return (
                  <tr key={c['.id'] ?? i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className={clsx('px-3 py-2 text-xs font-semibold uppercase', PROTO_COLOR[proto] ?? 'text-gray-500')}>{proto || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{src.ip}{src.port && <span className="text-gray-400">:{src.port}</span>}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{dst.ip}{dst.port && <span className="text-gray-400">:{dst.port}</span>}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">{c['tcp-state'] || c.state || '—'}</td>
                    <td className="px-3 py-2 text-right text-xs text-gray-500 dark:text-slate-400 font-mono">{replRate !== '0' || origRate !== '0' ? `${replRate}/${origRate}` : '—'}</td>
                    <td className="px-3 py-2 text-right text-xs text-gray-500 dark:text-slate-400">{bytes > 0 ? formatBytes(bytes) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400">
        Live from the device&apos;s connection tracking table. Only the first {limit.toLocaleString()} connections are read, so a busy
        router isn&apos;t asked for its whole table; the protocol filter is applied by the router, the text filter to the rows shown.
        {auto ? ' Refreshing every 30 seconds.' : ' Refresh to update, or turn on auto-refresh (every 30 seconds).'}
      </p>
    </div>
  );
}
