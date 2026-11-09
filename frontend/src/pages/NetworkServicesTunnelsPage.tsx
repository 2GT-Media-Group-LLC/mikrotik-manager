import { useMemo, useState } from 'react';
import { useDateTimeFormat } from '../hooks/useDateTimeFormat';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useFleetRefresh } from '../hooks/useFleetRefresh';
import { Cable, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import { tunnelsApi, devicesApi, type TunnelKind, type TunnelRowView } from '../services/api';
import PppCard from '../components/tunnels/PppCard';
import { FilterBar, FilterSearch, FilterSelect } from '../components/common/FilterBar';

const KIND_LABEL: Record<TunnelKind, string> = {
  ipsec: 'IPsec',
  'pppoe-server': 'PPPoE server',
  'ppp-session': 'PPP session',
  'pppoe-client': 'PPPoE client',
  eoip: 'EoIP',
  gre: 'GRE',
  ipip: 'IPIP',
};

/** A busy access concentrator has thousands of sessions; the table draws this many. */
const SHOW = 500;

function StatusBadge({ t }: { t: TunnelRowView }) {
  const cls = t.status === 'up' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    : t.status === 'down' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      : t.status === 'idle' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400';
  return <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', cls)}>{t.state}</span>;
}

/**
 * IPsec peers, PPPoE servers and clients, active PPP sessions and EoIP, GRE
 * and IPIP tunnels across the fleet (#310), from the slow polls. PPP users,
 * servers and sessions can be managed per router (Discussion #85); the rest is
 * set up on the device.
 */
export default function NetworkServicesTunnelsPage() {
  const { formatDateTime } = useDateTimeFormat();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['tunnels'],
    queryFn: () => tunnelsApi.list().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { refresh, refreshing } = useFleetRefresh(['slow'], refetch);
  const [pppDevice, setPppDevice] = useState<number | null>(null);
  const { data: allDevices = [] } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list().then((r) => r.data), staleTime: 60_000 });
  // Routers with PPP found first, then the rest of the online ones.
  const pppDevices = useMemo(() => {
    const withPpp = new Set(rows.filter((t) => t.kind === 'pppoe-server' || t.kind === 'ppp-session').map((t) => t.device_id));
    return allDevices.filter((d) => d.status === 'online' || withPpp.has(d.id))
      .sort((a, b) => Number(withPpp.has(b.id)) - Number(withPpp.has(a.id)) || a.name.localeCompare(b.name))
      .map((d) => ({ id: d.id, name: d.name }));
  }, [rows, allDevices]);

  const shown = useMemo(() => rows.filter((t) => {
    if (kind && t.kind !== kind) return false;
    if (status && t.status !== status) return false;
    const q = search.trim().toLowerCase();
    if (q && ![t.device_name, t.name, t.local_address, t.remote_address, t.detail]
      .some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    return true;
  }), [rows, kind, status, search]);

  const count = (k: TunnelKind[]) => rows.filter((t) => k.includes(t.kind));
  const ipsec = count(['ipsec']);
  const sessions = count(['ppp-session']).length;
  const tunnels = count(['eoip', 'gre', 'ipip', 'pppoe-client']);
  const down = rows.filter((t) => t.status === 'down').length;
  const kindsPresent = (Object.keys(KIND_LABEL) as TunnelKind[]).filter((k) => rows.some((t) => t.kind === k));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Tunnels &amp; PPP</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            IPsec peers, PPPoE servers, clients and sessions, and EoIP, GRE and IPIP tunnels across the fleet,
            refreshed with each slow poll. PPP users, servers and sessions can be managed per router below; the rest is set up on the device.
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={isFetching || refreshing} className="btn-secondary flex items-center gap-2 text-sm flex-shrink-0">
          <RefreshCw className={clsx('w-3.5 h-3.5', (isFetching || refreshing) && 'animate-spin')} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'IPsec peers up', value: `${ipsec.filter((t) => t.status === 'up').length} of ${ipsec.length}` },
          { label: 'PPP sessions', value: String(sessions) },
          { label: 'Tunnels & PPPoE clients up', value: `${tunnels.filter((t) => t.status === 'up').length} of ${tunnels.length}` },
          { label: 'Down', value: String(down), bad: down > 0 },
        ].map((c) => (
          <div key={c.label} className="card px-4 py-3">
            <div className="text-xs text-gray-500 dark:text-slate-400">{c.label}</div>
            <div className={clsx('text-2xl font-bold', c.bad ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white')}>{c.value}</div>
          </div>
        ))}
      </div>

      <div id="ppp-card"><PppCard devices={pppDevices} deviceId={pppDevice} onDevice={setPppDevice} /></div>

      <FilterBar>
        <FilterSearch value={search} onChange={setSearch} placeholder="Filter by device, name, address, user, MAC…" />
        <FilterSelect value={kind} onChange={setKind} title="Type">
          <option value="">Every type</option>
          {kindsPresent.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </FilterSelect>
        <FilterSelect value={status} onChange={setStatus} title="Status">
          <option value="">Any status</option>
          <option value="down">Down</option>
          <option value="up">Up</option>
          <option value="idle">Waiting</option>
          <option value="disabled">Disabled</option>
        </FilterSelect>
      </FilterBar>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="py-10 text-center text-gray-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-gray-400 dark:text-slate-500 flex flex-col items-center gap-2">
            <Cable className="w-6 h-6" />
            No IPsec, PPPoE, PPP, EoIP, GRE or IPIP found. They appear here after the next slow poll of a device that has them.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 text-left">
                  {['Device', 'Type', 'Name', 'Local', 'Remote', 'Status', 'Up for', 'Last change'].map((h) => (
                    <th key={h} className="table-header px-4 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {shown.slice(0, SHOW).map((t) => (
                  <tr key={`${t.device_id}-${t.kind}-${t.tunnel_key}`} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2">
                      <Link to={`/devices/${t.device_id}`} className="text-blue-600 dark:text-blue-400 hover:underline">{t.device_name}</Link>
                      {t.device_status !== 'online' && <span className="ml-1.5 text-xs text-gray-400">({t.device_status})</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600 dark:text-slate-300 whitespace-nowrap">
                      {KIND_LABEL[t.kind] ?? t.kind}
                      {(t.kind === 'pppoe-server' || t.kind === 'ppp-session') && (
                        <button onClick={() => { setPppDevice(t.device_id); document.getElementById('ppp-card')?.scrollIntoView({ behavior: 'smooth' }); }}
                          className="ml-2 text-blue-600 dark:text-blue-400 hover:underline">manage</button>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-gray-900 dark:text-white">{t.name}</div>
                      {t.detail && <div className="text-xs text-gray-400">{t.detail}</div>}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{t.local_address || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{t.remote_address || '—'}</td>
                    <td className="px-4 py-2"><StatusBadge t={t} /></td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-slate-300">{t.status === 'up' && t.uptime ? t.uptime : '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400" title={formatDateTime(t.last_change_at)}>
                      {formatDistanceToNow(new Date(t.last_change_at), { addSuffix: true })}
                      {t.status === 'down' && !t.last_up_at && <div className="text-gray-400">not up since it was found</div>}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">Nothing matches the filters.</td></tr>
                )}
              </tbody>
            </table>
            {shown.length > SHOW && (
              <div className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400 border-t border-gray-100 dark:border-slate-700">
                Showing {SHOW} of {shown.length}. Filter by device, user or type to find the rest.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
