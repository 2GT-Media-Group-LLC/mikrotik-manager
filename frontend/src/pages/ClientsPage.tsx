import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, Wifi, Network, Users, X, Pencil, Trash2, ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, RefreshCw,
} from 'lucide-react';
import { CATEGORY_META } from '../utils/clientCategories';
import { RSSI_ZONES } from '../utils/wifiChannels';
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

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const PAGE_SIZE_KEY = 'clients-page-size';

function readStoredPageSize(): number {
  const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : 50;
}

// Build a compact list of page numbers (1-based) with ellipses, always keeping
// the first, last, current page and its immediate neighbours visible.
function getPageList(current0: number, totalPages: number): (number | 'ellipsis')[] {
  const cur = current0 + 1;
  const wanted = new Set<number>([1, totalPages]);
  for (let i = cur - 1; i <= cur + 1; i++) {
    if (i >= 1 && i <= totalPages) wanted.add(i);
  }
  const sorted = Array.from(wanted).sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('ellipsis');
    out.push(p);
    prev = p;
  }
  return out;
}

function CategoryIcon({ category }: { category?: string }) {
  const meta = category && category !== 'unknown' ? CATEGORY_META[category] : undefined;
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <span title={meta.label} className="flex-shrink-0 text-gray-400 dark:text-slate-500">
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

function signalLabel(dbm: number): string {
  if (dbm >= -55) return 'Excellent';
  if (dbm >= -65) return 'Good';
  if (dbm >= -75) return 'Fair';
  return 'Poor';
}

function signalColor(dbm: number): string {
  if (dbm >= -55) return 'text-green-600 dark:text-green-400';
  if (dbm >= -65) return 'text-lime-600 dark:text-lime-400';
  if (dbm >= -75) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

function formatDataBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
  // Wired/wireless filter lives in the URL (?type=wireless) so the sidebar and
  // the legacy /wireless/clients route can deep-link to a pre-filtered view.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawType = searchParams.get('type');
  const typeFilter: 'wired' | 'wireless' | null =
    rawType === 'wired' || rawType === 'wireless' ? rawType : null;
  const setTypeFilter = (t: 'wired' | 'wireless' | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (t) next.set('type', t); else next.delete('type');
      return next;
    }, { replace: true });
    setPage(0);
  };
  const isWireless = typeFilter === 'wireless';

  // VLAN and signal-range filters live in the URL alongside type, so the AP
  // Deployment Density chart can hand off the band the user clicked (#99) and any
  // filtered view stays shareable (#100).
  const urlNum = (k: string): number | undefined => {
    const v = searchParams.get(k);
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const vlanFilter = urlNum('vlan');
  const signalMin = urlNum('smin');
  const signalMax = urlNum('smax');
  const setUrlFilter = (patch: Record<string, string | null>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k); else next.set(k, v);
      }
      return next;
    }, { replace: true });
    setPage(0);
  };
  const activeFilterCount = [vlanFilter, signalMin ?? signalMax].filter(v => v !== undefined).length;
  const [page, setPage] = useState(0);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [sortCol, setSortCol] = useState<string>('last_seen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [refreshInterval, setRefreshInterval] = useState<number | null>(readStoredInterval);
  const refreshIntervalRef = useRef(refreshInterval);
  useEffect(() => { refreshIntervalRef.current = refreshInterval; }, [refreshInterval]);
  const [pageSize, setPageSize] = useState(readStoredPageSize);

  const handleIntervalChange = (val: number | null) => {
    setRefreshInterval(val);
    refreshIntervalRef.current = val;
    localStorage.setItem(STORAGE_KEY, String(val));
  };

  const handlePageSizeChange = (n: number) => {
    setPageSize(n);
    setPage(0);
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  };

  // Sorting is server-side (across the whole dataset, not just the current
  // page), so changing the sort returns to page 1 and refetches.
  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
    setPage(0);
  };

  const { data, isLoading } = useQuery({
    queryKey: ['clients', { search, showAll, typeFilter, vlanFilter, signalMin, signalMax, page, pageSize, sortCol, sortDir }],
    queryFn: () =>
      clientsApi
        .list({
          search: search || undefined,
          active: showAll ? undefined : true,
          client_type: typeFilter ?? undefined,
          vlan_id: vlanFilter,
          signal_min: signalMin,
          signal_max: signalMax,
          limit: pageSize, offset: page * pageSize, sort: sortCol, dir: sortDir,
        })
        .then((r) => r.data),
    refetchInterval: refreshInterval ?? false,
    // Keep the current rows on screen while a sort/page/search refetch is in
    // flight so the table doesn't blank out and jump.
    placeholderData: keepPreviousData,
  });

  // Offer only VLANs the fleet actually uses, so the list never presents a
  // choice that would return nothing.
  const vlanOptions = useMemo(() => {
    const seen = new Set<number>();
    for (const c of (data?.clients ?? [])) if (c.vlan_id != null) seen.add(c.vlan_id);
    if (vlanFilter != null) seen.add(vlanFilter);   // keep the active choice selectable
    return [...seen].sort((a, b) => a - b);
  }, [data, vlanFilter]);

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

  // Server returns rows already sorted + paginated for the active sort column.
  const clients = data?.clients ?? [];
  const total = data?.total ?? 0;

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
        {/* Wired / wireless segmented filter */}
        <div className="flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
          {([
            { key: null, label: 'All' },
            { key: 'wired' as const, label: 'Wired' },
            { key: 'wireless' as const, label: 'Wireless' },
          ]).map(({ key, label }) => (
            <button
              key={label}
              onClick={() => setTypeFilter(key)}
              className={clsx(
                'px-3 py-2 text-sm font-medium transition-colors',
                typeFilter === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* VLAN filter — populated from what the fleet actually uses, so the
            operator picks a real VLAN rather than guessing an id (#100). */}
        {vlanOptions.length > 0 && (
          <select
            className="input w-auto"
            value={vlanFilter ?? ''}
            onChange={(e) => setUrlFilter({ vlan: e.target.value || null })}
          >
            <option value="">All VLANs</option>
            {vlanOptions.map(v => <option key={v} value={v}>VLAN {v}</option>)}
          </select>
        )}

        {/* Signal band — the same buckets the AP density chart clusters by, which
            is what lets that chart link straight here (#99). */}
        {isWireless && (
          <select
            className="input w-auto"
            value={signalMin != null || signalMax != null ? `${signalMin ?? ''}:${signalMax ?? ''}` : ''}
            onChange={(e) => {
              const [lo, hi] = e.target.value.split(':');
              setUrlFilter({ smin: lo || null, smax: hi || null });
            }}
          >
            <option value="">Any signal</option>
            {RSSI_ZONES.map(z => (
              <option key={z.label} value={`${z.min}:${z.max}`}>
                {z.label} ({z.min} to {z.max} dBm)
              </option>
            ))}
          </select>
        )}

        {activeFilterCount > 0 && (
          <button
            onClick={() => setUrlFilter({ vlan: null, smin: null, smax: null })}
            className="px-3 py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700"
          >
            Clear {activeFilterCount} filter{activeFilterCount !== 1 ? 's' : ''}
          </button>
        )}

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
          <RefreshCw className="w-3.5 h-3.5 text-ink-4" />
          <select
            value={String(refreshInterval)}
            onChange={(e) => {
              const raw = e.target.value;
              handleIntervalChange(raw === 'null' ? null : Number(raw));
            }}
            className="text-sm rounded-lg border border-line bg-surface-2 text-ink px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
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
            <table className="w-full text-sm table-fixed">
              <colgroup>
                {(isWireless
                  ? ['20%', '11%', '11%', '11%', '9%', '6%', '12%', '9%', '11%']
                  : ['22%', '12%', '13%', '11%', '7%', '13%', '10%', '12%']
                ).map((w, i) => <col key={i} style={{ width: w }} />)}
                {showAll && <col style={{ width: '6%' }} />}
              </colgroup>
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  {([
                    { col: 'hostname',       label: 'Host / Vendor / MAC', align: 'left'  },
                    { col: 'ip_address',     label: 'IP Address',          align: 'left'  },
                    // When filtered to wireless, the Type column is redundant —
                    // show SSID + signal quality instead (not server-sortable).
                    ...(isWireless
                      ? [
                          { col: 'ssid',            label: 'SSID',   align: 'left' as const, noSort: true },
                          { col: 'signal_strength', label: 'Signal', align: 'left' as const, noSort: true },
                        ]
                      : [{ col: 'client_type', label: 'Type', align: 'left' as const }]),
                    { col: 'interface_name', label: 'Port',                align: 'left'  },
                    { col: 'vlan_id',        label: 'VLAN',                align: 'left'  },
                    { col: 'device_name',    label: 'Device',              align: 'left'  },
                    { col: 'traffic_today_bytes', label: 'Data (today)',   align: 'left'  },
                    { col: 'last_seen',      label: 'Last Seen',           align: 'left'  },
                  ] as { col: string; label: string; align: 'left' | 'right'; noSort?: boolean }[]).map(({ col, label, align, noSort }) => (
                    <th
                      key={col}
                      className={clsx('table-header px-4 py-2.5 select-none whitespace-nowrap', !noSort && 'cursor-pointer', `text-${align}`)}
                      onClick={noSort ? undefined : () => toggleSort(col)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {!noSort && (sortCol === col ? (
                          sortDir === 'asc'
                            ? <ChevronUp className="w-3 h-3 text-blue-500" />
                            : <ChevronDown className="w-3 h-3 text-blue-500" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 text-gray-300 dark:text-slate-600" />
                        ))}
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
                      <div className="flex items-center gap-1.5 min-w-0">
                        <CategoryIcon category={client.device_category} />
                        <button
                          onClick={() => navigate(`/clients/${encodeURIComponent(client.mac_address)}`)}
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left truncate"
                        >
                          {client.custom_name || client.hostname || (
                            <span className="text-gray-400 dark:text-slate-500 italic">No hostname</span>
                          )}
                        </button>
                        {client.custom_name && (
                          <span className="text-xs text-blue-500 dark:text-blue-400 ml-1 flex-shrink-0">custom</span>
                        )}
                        {canWrite && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingClient(client); }}
                            className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700 flex-shrink-0"
                            title="Edit name"
                          >
                            <Pencil className="w-3 h-3 text-gray-300 dark:text-slate-600 hover:text-gray-500 dark:hover:text-slate-400" />
                          </button>
                        )}
                      </div>
                      {client.vendor && (
                        <div className="text-xs text-gray-400 dark:text-slate-500 truncate">{client.vendor}</div>
                      )}
                      <div className="text-xs font-mono text-gray-400 dark:text-slate-500 truncate">
                        {client.mac_address}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-600 dark:text-slate-400 truncate">
                      {client.ip_address || '—'}
                    </td>
                    {isWireless ? (
                      <>
                        <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-slate-400 truncate">
                          {(client as Client & { ssid?: string }).ssid || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                          {client.signal_strength != null ? (
                            <span className={clsx('font-medium', signalColor(client.signal_strength))}>
                              {client.signal_strength} dBm
                              <span className="ml-1 font-normal opacity-75">({signalLabel(client.signal_strength)})</span>
                            </span>
                          ) : (
                            <span className="text-gray-400 dark:text-slate-500">—</span>
                          )}
                        </td>
                      </>
                    ) : (
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
                    )}
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400 truncate">
                      {client.interface_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                      {client.vlan_id != null
                        ? <span className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded font-mono">{client.vlan_id}</span>
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 truncate">
                      {client.device_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {client.traffic_today_bytes ? formatDataBytes(client.traffic_today_bytes) : '—'}
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
          {total > 0 && (() => {
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            return (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
                {/* Entries-per-page + range summary */}
                <div className="flex items-center gap-2 text-gray-500 dark:text-slate-400">
                  <span>Show</span>
                  <select
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                    className="text-sm rounded-lg border border-line bg-surface-2 text-ink px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <span>entries</span>
                  <span className="ml-1 hidden sm:inline">
                    ({page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total})
                  </span>
                </div>

                {/* Numbered page selection */}
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      aria-label="Previous page"
                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    {getPageList(page, totalPages).map((item, i) =>
                      item === 'ellipsis' ? (
                        <span key={`e${i}`} className="px-1.5 text-gray-400 dark:text-slate-500 select-none">…</span>
                      ) : (
                        <button
                          key={item}
                          onClick={() => setPage(item - 1)}
                          aria-current={item - 1 === page ? 'page' : undefined}
                          className={clsx(
                            'inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded-lg text-sm font-medium transition-colors',
                            item - 1 === page
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700'
                          )}
                        >
                          {item}
                        </button>
                      )
                    )}
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      aria-label="Next page"
                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
