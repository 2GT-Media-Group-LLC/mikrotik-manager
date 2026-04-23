import { useState, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Wifi, Network, Users, X, Pencil, Trash2, ChevronUp, ChevronDown, ChevronsUpDown, RefreshCw } from 'lucide-react';
import { clientsApi } from '../services/api';
import type { Client } from '../types';
import { useCanWrite } from '../hooks/useCanWrite';
import { useSocket } from '../hooks/useSocket';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';


const REFRESH_OPTIONS = [
  { label: 'Not Updating', value: null },
  { label: '30 seconds',   value: 30_000 },
  { label: '1 minute',     value: 60_000 },
  { label: '3 minutes',    value: 180_000 },
] as const;

const STORAGE_KEY = 'clients-refresh-interval';

function readStoredInterval(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'null') return null;
  const n = Number(raw);
  return REFRESH_OPTIONS.some((o) => o.value === n) ? n : 30_000;
}

function ClientModal({
  client,
  onClose,
}: {
  client: Client;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(client.custom_name || '');

  const mutation = useMutation({
    mutationFn: () => clientsApi.updateHostname(client.mac_address, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Edit Client</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3 text-sm text-gray-500 dark:text-slate-400 mb-4">
          <div className="flex justify-between">
            <span>MAC</span>
            <span className="font-mono text-gray-800 dark:text-white">{client.mac_address}</span>
          </div>
          {client.vendor && (
            <div className="flex justify-between">
              <span>Vendor</span>
              <span className="text-gray-800 dark:text-white">{client.vendor}</span>
            </div>
          )}
          {client.ip_address && (
            <div className="flex justify-between">
              <span>IP</span>
              <span className="font-mono text-gray-800 dark:text-white">{client.ip_address}</span>
            </div>
          )}
          {client.interface_name && (
            <div className="flex justify-between">
              <span>Port</span>
              <span className="font-mono text-gray-800 dark:text-white">{client.interface_name}</span>
            </div>
          )}
          {client.hostname && (
            <div className="flex justify-between">
              <span>Discovered Hostname</span>
              <span className="font-mono text-gray-800 dark:text-white">{client.hostname}</span>
            </div>
          )}
        </div>

        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
          Custom Name
        </label>
        <input
          type="text"
          className="input w-full mb-1"
          placeholder={client.hostname || 'e.g. Office Printer'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') mutation.mutate(); }}
          autoFocus
        />
        <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
          Overrides the auto-discovered hostname. Persists even when the client is offline.
        </p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="btn-primary"
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        {mutation.isError && (
          <p className="mt-2 text-xs text-red-500">Failed to save name.</p>
        )}
      </div>
    </div>
  );
}

export default function ClientsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(0);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [sortCol, setSortCol] = useState<string>('last_seen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [refreshInterval, setRefreshInterval] = useState<number | null>(readStoredInterval);
  const refreshIntervalRef = useRef(refreshInterval);
  refreshIntervalRef.current = refreshInterval;
  const PAGE_SIZE = 50;

  const handleIntervalChange = (val: number | null) => {
    setRefreshInterval(val);
    refreshIntervalRef.current = val;
    localStorage.setItem(STORAGE_KEY, String(val));
  };

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['clients', { search, showAll, page }],
    queryFn: () =>
      clientsApi
        .list({ search: search || undefined, active: showAll ? undefined : true, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        .then((r) => r.data),
    refetchInterval: refreshInterval ?? false,
  });

  const [purgeResult, setPurgeResult] = useState('');
  const purgeMutation = useMutation({
    mutationFn: () => clientsApi.purgeStale(),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      setPurgeResult(r.data.message);
      setTimeout(() => setPurgeResult(''), 5000);
    },
  });

  useSocket({
    'clients:updated': () => {
      if (refreshIntervalRef.current !== null) {
        queryClient.invalidateQueries({ queryKey: ['clients'] });
      }
    },
  });

  const rawClients = data?.clients ?? [];
  const total = data?.total ?? 0;

  const clients = useMemo(() => {
    const toIpNum = (ip: string) =>
      (ip || '').split('.').reduce((n, o) => n * 256 + parseInt(o || '0', 10), 0);

    return [...rawClients].sort((a, b) => {
      let av: string | number, bv: string | number;
      switch (sortCol) {
        case 'hostname':       av = a.custom_name || a.hostname || ''; bv = b.custom_name || b.hostname || ''; break;
        case 'vendor':         av = a.vendor || ''; bv = b.vendor || ''; break;
        case 'ip_address':     av = toIpNum(a.ip_address || ''); bv = toIpNum(b.ip_address || ''); break;
        case 'client_type':    av = a.client_type || ''; bv = b.client_type || ''; break;
        case 'interface_name': av = a.interface_name || ''; bv = b.interface_name || ''; break;
        case 'vlan_id':        av = a.vlan_id ?? -1; bv = b.vlan_id ?? -1; break;
        case 'device_name':    av = a.device_name || ''; bv = b.device_name || ''; break;
        case 'last_seen':      av = a.last_seen || ''; bv = b.last_seen || ''; break;
        default:               av = ''; bv = '';
      }
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rawClients, sortCol, sortDir]);

  return (
    <div className="space-y-4">
      {editingClient && (
        <ClientModal client={editingClient} onClose={() => setEditingClient(null)} />
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Clients
          {total > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({total} {showAll ? 'total' : 'online'})
            </span>
          )}
        </h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            className="input pl-9"
            placeholder="Search hostname, MAC, IP, or vendor…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
        <button
          onClick={() => { setShowAll((s) => !s); setPage(0); }}
          className={clsx(
            'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
            showAll
              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'
              : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
          )}
        >
          {showAll ? 'Active Only' : 'Show Inactive'}
        </button>
        {canWrite && (
          <button
            onClick={() => {
              if (confirm('Purge all inactive clients older than the configured retention period?')) {
                purgeMutation.mutate();
              }
            }}
            disabled={purgeMutation.isPending}
            className="btn-secondary flex items-center gap-1.5 text-sm"
            title="Delete inactive client records older than the retention period (set in Settings)"
          >
            <Trash2 className="w-4 h-4" />
            Purge Stale
          </button>
        )}
        {purgeResult && (
          <span className="text-xs text-green-600 dark:text-green-400">{purgeResult}</span>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <RefreshCw className="w-3.5 h-3.5 text-gray-400 dark:text-slate-500" />
          <select
            value={String(refreshInterval)}
            onChange={(e) => {
              const raw = e.target.value;
              handleIntervalChange(raw === 'null' ? null : Number(raw));
            }}
            className="text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-200 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading...</div>
      ) : clients.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <Users className="w-12 h-12 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">
            {showAll ? 'No clients found' : 'No active clients detected'}
          </p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  {([
                    { col: 'hostname',       label: 'Host / Vendor / MAC', align: 'left'  },
                    { col: 'ip_address',     label: 'IP Address',          align: 'left'  },
                    { col: 'client_type',    label: 'Type',                align: 'left'  },
                    { col: 'interface_name', label: 'Port',                align: 'left'  },
                    { col: 'vlan_id',        label: 'VLAN',                align: 'left'  },
                    { col: 'device_name',    label: 'Device',              align: 'left'  },
                    { col: 'last_seen',      label: 'Last Seen',           align: 'left'  },
                  ] as { col: string; label: string; align: 'left' | 'right' }[]).map(({ col, label, align }) => (
                    <th
                      key={col}
                      className={clsx('table-header px-4 py-2.5 cursor-pointer select-none whitespace-nowrap', `text-${align}`)}
                      onClick={() => toggleSort(col)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {sortCol === col ? (
                          sortDir === 'asc'
                            ? <ChevronUp className="w-3 h-3 text-blue-500" />
                            : <ChevronDown className="w-3 h-3 text-blue-500" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 text-gray-300 dark:text-slate-600" />
                        )}
                      </span>
                    </th>
                  ))}
                  {showAll && (
                    <th className="table-header px-4 py-2.5 text-center">Active</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {clients.map((client) => (
                  <tr
                    key={client.id}
                    className="hover:bg-gray-50 dark:hover:bg-slate-700/30"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => navigate(`/clients/${encodeURIComponent(client.mac_address)}`)}
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left"
                        >
                          {client.custom_name || client.hostname || (
                            <span className="text-gray-400 dark:text-slate-500 italic">No hostname</span>
                          )}
                        </button>
                        {client.custom_name && (
                          <span className="text-xs text-blue-500 dark:text-blue-400 ml-1">custom</span>
                        )}
                        {canWrite && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingClient(client); }}
                            className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
                            title="Edit name"
                          >
                            <Pencil className="w-3 h-3 text-gray-300 dark:text-slate-600 hover:text-gray-500 dark:hover:text-slate-400" />
                          </button>
                        )}
                      </div>
                      {client.vendor && (
                        <div className="text-xs text-gray-400 dark:text-slate-500">{client.vendor}</div>
                      )}
                      <div className="text-xs font-mono text-gray-400 dark:text-slate-500">
                        {client.mac_address}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-600 dark:text-slate-400">
                      {client.ip_address || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1 text-xs font-medium',
                          client.client_type === 'wireless'
                            ? 'text-purple-600 dark:text-purple-400'
                            : 'text-blue-600 dark:text-blue-400'
                        )}
                      >
                        {client.client_type === 'wireless' ? (
                          <Wifi className="w-3 h-3" />
                        ) : (
                          <Network className="w-3 h-3" />
                        )}
                        {client.client_type}
                        {client.signal_strength != null && (
                          <span className="text-gray-400 ml-1">({client.signal_strength} dBm)</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {client.interface_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                      {client.vlan_id != null
                        ? <span className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded font-mono">{client.vlan_id}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                      {client.device_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500">
                      {client.last_seen
                        ? formatDistanceToNow(new Date(client.last_seen), { addSuffix: true })
                        : '—'}
                    </td>
                    {showAll && (
                      <td className="px-4 py-2.5 text-center">
                        <span
                          className={clsx(
                            'w-2 h-2 rounded-full inline-block',
                            client.active ? 'bg-green-500' : 'bg-gray-300 dark:bg-slate-600'
                          )}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 dark:text-slate-400">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="btn-secondary py-1"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  className="btn-secondary py-1"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
