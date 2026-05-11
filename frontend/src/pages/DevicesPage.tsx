import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, RefreshCw, Router, Wifi, Trash2, ChevronRight, Search,
  Radar, ArrowUpCircle, Cpu, Pencil, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import { devicesApi, topologyApi, metricsApi } from '../services/api';
import type { Device } from '../types';
import type { DiscoveredDevice } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import clsx from 'clsx';
import AddDeviceModal from '../components/devices/AddDeviceModal';
import EditDeviceModal from '../components/devices/EditDeviceModal';
import TryAllDiscoveredModal from '../components/devices/TryAllDiscoveredModal';

type DeviceSortKey = 'name' | 'ip_address' | 'model' | 'ros_version' | 'status' | 'last_seen';
type DiscoveredSortKey = 'identity' | 'address' | 'mac_address' | 'seen_by' | 'discovered_at';
type SortDir = 'asc' | 'desc';

function SortableHeader({
  label,
  active,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'center' | 'right';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 text-inherit transition-colors',
        align === 'center' && 'justify-center',
        align === 'right' && 'justify-end'
      )}
      style={{ color: 'inherit' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--ink)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'inherit')}
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      {active ? (dir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />) : (
        <ArrowUpDown className="w-3.5 h-3.5 opacity-50" />
      )}
    </button>
  );
}

function GlowDot({ status }: { status: Device['status'] }) {
  const color = status === 'online' ? 'var(--good)' : status === 'offline' ? 'var(--bad)' : 'var(--ink-4)';
  return (
    <span
      style={{
        width: 8, height: 8, borderRadius: 999, display: 'inline-block',
        background: color, flexShrink: 0,
        boxShadow: status === 'online' ? `0 0 0 2px ${color}33, 0 0 8px ${color}88` : 'none',
      }}
    />
  );
}

function TypePill({ type }: { type: Device['device_type'] }) {
  const map: Record<string, { label: string; color: string }> = {
    wireless_ap: { label: 'AP',  color: 'var(--info)' },
    switch:      { label: 'SW',  color: 'var(--accent)' },
    router:      { label: 'RTR', color: 'var(--violet)' },
  };
  const { label, color } = map[type as string] ?? { label: (type as string)?.slice(0, 3)?.toUpperCase() ?? '?', color: 'var(--ink-3)' };
  return (
    <span
      className="mono text-[10.5px] font-medium px-[6px] py-[2px] rounded-full"
      style={{ color, border: '1px solid var(--line)' }}
    >
      {label}
    </span>
  );
}

function CpuValue({ value }: { value: number | undefined }) {
  if (value == null) return <span className="mono text-[11px]" style={{ color: 'var(--ink-4)' }}>—</span>;
  const color = value > 70 ? 'var(--bad)' : value > 40 ? 'var(--warn)' : 'var(--accent)';
  return (
    <span className="mono num-tab text-[12px] font-medium" style={{ color }}>{value}%</span>
  );
}

function LoadSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <span className="mono text-[11px]" style={{ color: 'var(--ink-4)' }}>—</span>;
  const max = Math.max(...data) || 1;
  const w = 72, h = 20;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - (v / max) * (h - 2) - 1,
  ]);
  const d = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke="var(--ink-3)" strokeWidth="1.2" />
    </svg>
  );
}

export default function DevicesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [showAddModal, setShowAddModal] = useState(false);
  const [addPrefill, setAddPrefill] = useState<{ name?: string; ip_address?: string } | undefined>();
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const [search, setSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [hideDuplicates, setHideDuplicates] = useState(true);
  const [showTryAllModal, setShowTryAllModal] = useState(false);
  const [deviceSort, setDeviceSort] = useState<{ key: DeviceSortKey; dir: SortDir }>({ key: 'name', dir: 'asc' });
  const [discoveredSort, setDiscoveredSort] = useState<{ key: DiscoveredSortKey; dir: SortDir }>({
    key: 'discovered_at',
    dir: 'desc',
  });
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'updates'>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: discovered = [] } = useQuery({
    queryKey: ['devices-discovered'],
    queryFn: () => devicesApi.discovered().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const syncMutation = useMutation({
    mutationFn: (id: number) => devicesApi.sync(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => devicesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      setDeleteConfirm(null);
    },
  });

  // Fetch 1h CPU history for all devices (for LOAD sparkline column)
  const cpuHistoryResults = useQueries({
    queries: devices.map(d => ({
      queryKey: ['device-resources-history', d.id],
      queryFn: () => metricsApi.deviceResources(d.id, '1h').then(r => r.data),
      staleTime: 60_000,
      enabled: d.status === 'online',
    })),
  });
  const cpuHistories = useMemo(
    () => Object.fromEntries(
      devices.map((d, i) => {
        const pts = cpuHistoryResults[i]?.data ?? [];
        return [d.id, pts.map((p: { cpu_load?: number }) => p.cpu_load ?? 0).filter((v: number) => v > 0)];
      })
    ) as Record<number, number[]>,
    [devices, cpuHistoryResults],
  );

  const filtered = useMemo(() => {
    const base = devices.filter(d => {
      if (search &&
        !d.name.toLowerCase().includes(search.toLowerCase()) &&
        !d.ip_address.includes(search) &&
        !d.model?.toLowerCase().includes(search.toLowerCase())
      ) return false;
      if (statusFilter === 'online' && d.status !== 'online') return false;
      if (statusFilter === 'offline' && d.status !== 'offline') return false;
      if (statusFilter === 'updates' && !d.firmware_update_available && !d.routerboard_upgrade_available) return false;
      if (typeFilter === 'AP' && d.device_type !== 'wireless_ap') return false;
      if (typeFilter === 'SW' && d.device_type !== 'switch') return false;
      if (typeFilter === 'RTR' && d.device_type !== 'router') return false;
      return true;
    });
    const sorted = [...base].sort((a, b) => {
      const val = (x: Device): string | number => {
        switch (deviceSort.key) {
          case 'name': return x.name || '';
          case 'ip_address': return x.ip_address || '';
          case 'model': return x.model || '';
          case 'ros_version': return x.ros_version || '';
          case 'status': return x.status || '';
          case 'last_seen': return x.last_seen ? new Date(x.last_seen).getTime() : 0;
          default: return '';
        }
      };
      const av = val(a);
      const bv = val(b);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return deviceSort.dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [devices, search, statusFilter, typeFilter, deviceSort]);

  const discoveredList = discovered as DiscoveredDevice[];
  const duplicateCount = useMemo(
    () => discoveredList.filter((d) => d.duplicate_of_device_id != null).length,
    [discoveredList]
  );
  const visibleDiscovered = useMemo(() => {
    const base = hideDuplicates ? discoveredList.filter((d) => d.duplicate_of_device_id == null) : discoveredList;
    const sorted = [...base].sort((a, b) => {
      const val = (x: DiscoveredDevice): string | number => {
        switch (discoveredSort.key) {
          case 'identity': return x.identity || '';
          case 'address': return x.address || '';
          case 'mac_address': return x.mac_address || '';
          case 'seen_by': return x.seen_by || '';
          case 'discovered_at': return x.discovered_at ? new Date(x.discovered_at).getTime() : 0;
          default: return '';
        }
      };
      const av = val(a);
      const bv = val(b);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return discoveredSort.dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [discoveredList, hideDuplicates, discoveredSort]);

  const flipSort = <K extends string>(
    current: { key: K; dir: SortDir },
    key: K,
    set: (v: { key: K; dir: SortDir }) => void
  ) => {
    if (current.key === key) {
      set({ key, dir: current.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      set({ key, dir: 'asc' });
    }
  };

  const onlineCount = devices.filter(d => d.status === 'online').length;
  const updatesCount = devices.filter(d => d.firmware_update_available || d.routerboard_upgrade_available).length;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[28px] font-semibold leading-none" style={{ color: 'var(--ink)', letterSpacing: '-0.01em' }}>
          Devices
        </h1>
        <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          {devices.length} total · {onlineCount} online{updatesCount > 0 ? ` · ${updatesCount} update${updatesCount !== 1 ? 's' : ''}` : ''}
        </span>
        {canWrite && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={async () => {
                setSearching(true);
                try {
                  await topologyApi.discover();
                  setTimeout(() => {
                    queryClient.invalidateQueries({ queryKey: ['devices-discovered'] });
                    setSearching(false);
                  }, 8000);
                } catch {
                  setSearching(false);
                }
              }}
              disabled={searching}
              className="btn-secondary flex items-center gap-2 text-[12px] py-[6px]"
            >
              <RefreshCw className={clsx('w-3.5 h-3.5', searching && 'animate-spin')} />
              {searching ? 'Searching…' : 'Discover'}
            </button>
            <button
              onClick={() => { setAddPrefill(undefined); setShowAddModal(true); }}
              className="btn-primary flex items-center gap-2 text-[12px] py-[6px]"
            >
              <Plus className="w-3.5 h-3.5" />
              Add device
            </button>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="card-subtle flex flex-wrap items-center gap-[6px] p-[6px]">
        <div className="flex items-center gap-2 flex-1 min-w-[160px] px-[10px] py-[6px]" style={{ color: 'var(--ink-3)' }}>
          <Search className="w-3.5 h-3.5 flex-shrink-0" />
          <input
            type="text"
            className="bg-transparent text-[13px] outline-none w-full"
            style={{ color: 'var(--ink)' }}
            placeholder="Filter devices…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {(['all', 'online', 'offline', 'updates'] as const).map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className="mono text-[11.5px] px-[10px] py-[4px] rounded-[5px] transition-colors capitalize"
            style={{
              background: statusFilter === f ? 'var(--surface-3)' : 'transparent',
              color: statusFilter === f ? 'var(--ink)' : 'var(--ink-3)',
              border: 'none',
            }}
          >
            {f}
          </button>
        ))}
        <div className="w-px h-[18px] mx-1" style={{ background: 'var(--line)' }} />
        {(['AP', 'SW', 'RTR'] as const).map(t => {
          const colors: Record<string, string> = { AP: 'var(--info)', SW: 'var(--accent)', RTR: 'var(--violet)' };
          return (
            <button
              key={t}
              onClick={() => setTypeFilter(f => f === t ? null : t)}
              className="mono text-[11px] px-[8px] py-[4px] rounded-[5px] transition-colors"
              style={{
                background: typeFilter === t ? 'var(--surface-3)' : 'transparent',
                color: typeFilter === t ? colors[t] : 'var(--ink-3)',
                border: '1px solid var(--line)',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {/* Device table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48" style={{ color: 'var(--ink-4)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'var(--surface-2)' }}>
            <Router className="w-8 h-8" style={{ color: 'var(--ink-4)' }} />
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--ink-2)' }}>
              {search || statusFilter !== 'all' || typeFilter ? 'No devices match your filters' : 'No devices added yet'}
            </p>
            <p className="text-[13px] mt-1" style={{ color: 'var(--ink-4)' }}>
              {!search && statusFilter === 'all' && !typeFilter && 'Click "Add device" to connect your first Mikrotik device'}
            </p>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  {[
                    { key: null,         label: '',           w: 22  },
                    { key: 'name',       label: 'DEVICE',     w: null },
                    { key: null,         label: 'TYPE',       w: 72  },
                    { key: 'model',      label: 'MODEL',      w: null },
                    { key: 'ip_address', label: 'IP ADDRESS', w: null },
                    { key: 'ros_version',label: 'ROS',        w: 110 },
                    { key: null,         label: 'CPU',        w: 110 },
                    { key: null,         label: 'LOAD',       w: 100 },
                    { key: 'last_seen',  label: 'SEEN',       w: 90  },
                    { key: null,         label: '',           w: 56  },
                  ].map(({ key, label, w }, i) => (
                    <th
                      key={i}
                      className="table-header px-4 py-[10px] text-left"
                      style={w ? { width: w } : undefined}
                    >
                      {key ? (
                        <SortableHeader
                          label={label}
                          active={deviceSort.key === key as DeviceSortKey}
                          dir={deviceSort.dir}
                          onClick={() => flipSort(deviceSort, key as DeviceSortKey, setDeviceSort)}
                        />
                      ) : label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((device, i) => {
                  const cpuSpark = cpuHistories[device.id] ?? [];
                  return (
                    <tr
                      key={device.id}
                      className="cursor-pointer transition-colors"
                      style={{
                        borderBottom: i < filtered.length - 1 ? '1px solid var(--line-soft)' : 'none',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => navigate(`/devices/${device.id}`)}
                    >
                      <td className="px-4 py-[12px]">
                        <GlowDot status={device.status} />
                      </td>
                      <td className="px-4 py-[12px]">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>{device.name}</div>
                      </td>
                      <td className="px-4 py-[12px]">
                        <TypePill type={device.device_type} />
                      </td>
                      <td className="px-4 py-[12px]">
                        <span className="mono text-[11.5px]" style={{ color: 'var(--ink-2)' }}>{device.model || '—'}</span>
                      </td>
                      <td className="px-4 py-[12px]">
                        <span className="mono num-tab text-[12px]" style={{ color: 'var(--ink-2)' }}>{device.ip_address}</span>
                      </td>
                      <td className="px-4 py-[12px]">
                        <span
                          className="mono text-[11.5px] flex items-center gap-[4px]"
                          style={{ color: device.firmware_update_available || device.routerboard_upgrade_available ? 'var(--warn)' : 'var(--ink-3)' }}
                        >
                          {(device.firmware_update_available || device.routerboard_upgrade_available) && (
                            <span
                              className="text-[9px] font-bold px-[4px] py-[1px] rounded-[3px]"
                              style={{ background: 'var(--warn)', color: 'var(--accent-fg)' }}
                            >↑</span>
                          )}
                          {device.ros_version || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-[12px]">
                        <CpuValue value={(() => { const arr = cpuHistories[device.id]; return arr && arr.length > 0 ? arr[arr.length - 1] : undefined; })()} />
                      </td>
                      <td className="px-4 py-[12px]">
                        <LoadSparkline data={cpuSpark} />
                      </td>
                      <td className="px-4 py-[12px]">
                        <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
                          {device.last_seen
                            ? new Date(device.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-[12px]">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={e => e.stopPropagation()}
                        >
                          {canWrite && (
                            <>
                              <button
                                onClick={() => syncMutation.mutate(device.id)}
                                disabled={syncMutation.isPending}
                                className="p-1.5 rounded transition-colors"
                                style={{ color: 'var(--ink-4)' }}
                                title="Sync now"
                                onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                                onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
                              >
                                <RefreshCw className={clsx('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
                              </button>
                              <button
                                onClick={() => setEditDevice(device)}
                                className="p-1.5 rounded transition-colors"
                                style={{ color: 'var(--ink-4)' }}
                                title="Edit device"
                                onMouseEnter={e => (e.currentTarget.style.color = 'var(--ink-2)')}
                                onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {deleteConfirm === device.id ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => deleteMutation.mutate(device.id)}
                                    className="text-[11px] font-medium px-1"
                                    style={{ color: 'var(--bad)' }}
                                  >Confirm</button>
                                  <button
                                    onClick={() => setDeleteConfirm(null)}
                                    className="text-[11px] px-1"
                                    style={{ color: 'var(--ink-4)' }}
                                  >Cancel</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setDeleteConfirm(device.id)}
                                  className="p-1.5 rounded transition-colors"
                                  style={{ color: 'var(--ink-4)' }}
                                  title="Delete device"
                                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--bad)')}
                                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}
                          <ChevronRight className="w-4 h-4" style={{ color: 'var(--ink-4)' }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Discovered (unmanaged) MikroTik neighbors */}
      {discoveredList.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Radar className="w-4 h-4" style={{ color: 'var(--warn)' }} />
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--ink-2)' }}>
              Discovered Devices
            </h2>
            <span className="mono text-[11px]" style={{ color: 'var(--ink-4)' }}>
              — MikroTik neighbors seen by managed devices, not yet added
            </span>
            <label
              className="ml-auto flex items-center gap-2 select-none mono text-[11px]"
              style={{ color: duplicateCount === 0 ? 'var(--ink-4)' : 'var(--ink-3)', cursor: duplicateCount === 0 ? 'not-allowed' : 'pointer' }}
              title={
                duplicateCount === 0
                  ? 'No duplicates of already-managed devices detected'
                  : `${duplicateCount} row(s) match a device that's already managed (by MAC, IP, or identity)`
              }
            >
              <input
                type="checkbox"
                checked={hideDuplicates}
                disabled={duplicateCount === 0}
                onChange={(e) => setHideDuplicates(e.target.checked)}
              />
              Hide duplicates
              {duplicateCount > 0 && (
                <span style={{ color: 'var(--ink-4)' }}>({duplicateCount})</span>
              )}
            </label>
            {canWrite && visibleDiscovered.length > 0 && (
              <button
                onClick={() => setShowTryAllModal(true)}
                className="btn-primary text-[12px] py-[5px] px-3"
                title="Try adding all discovered devices with one credential method"
              >
                Try All
              </button>
            )}
          </div>
          {visibleDiscovered.length === 0 ? (
            <div className="card p-4 text-center mono text-[11px]" style={{ color: 'var(--ink-4)' }}>
              All {discoveredList.length} discovered neighbor(s) are already managed devices.
            </div>
          ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  {(['Identity', 'IP Address', 'MAC Address', 'Seen By', 'Last Seen', ''] as const).map((label, i) => (
                    <th key={i} className="table-header px-4 py-[10px] text-left" style={i === 5 ? { width: 140 } : undefined}>
                      {label === 'Identity' && (
                        <SortableHeader label="IDENTITY" active={discoveredSort.key === 'identity'} dir={discoveredSort.dir} onClick={() => flipSort(discoveredSort, 'identity', setDiscoveredSort)} />
                      )}
                      {label === 'IP Address' && (
                        <SortableHeader label="IP ADDRESS" active={discoveredSort.key === 'address'} dir={discoveredSort.dir} onClick={() => flipSort(discoveredSort, 'address', setDiscoveredSort)} />
                      )}
                      {label === 'MAC Address' && (
                        <SortableHeader label="MAC" active={discoveredSort.key === 'mac_address'} dir={discoveredSort.dir} onClick={() => flipSort(discoveredSort, 'mac_address', setDiscoveredSort)} />
                      )}
                      {label === 'Seen By' && (
                        <SortableHeader label="SEEN BY" active={discoveredSort.key === 'seen_by'} dir={discoveredSort.dir} onClick={() => flipSort(discoveredSort, 'seen_by', setDiscoveredSort)} />
                      )}
                      {label === 'Last Seen' && (
                        <SortableHeader label="LAST SEEN" active={discoveredSort.key === 'discovered_at'} dir={discoveredSort.dir} onClick={() => flipSort(discoveredSort, 'discovered_at', setDiscoveredSort)} />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleDiscovered.map((d, i) => (
                  <tr
                    key={d.mac_address || d.address || i}
                    style={{
                      borderBottom: i < visibleDiscovered.length - 1 ? '1px solid var(--line-soft)' : 'none',
                      opacity: d.duplicate_of_device_id != null ? 0.6 : 1,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="px-4 py-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>{d.identity || '—'}</span>
                        {d.duplicate_of_device_id != null && (
                          <span
                            className="mono text-[9.5px] uppercase tracking-wide px-[6px] py-[2px] rounded"
                            style={{ background: 'var(--good-bg)', color: 'var(--good)' }}
                            title={`Matches managed device: ${d.duplicate_of_device_name ?? ''}`}
                          >
                            managed{d.duplicate_of_device_name ? ` · ${d.duplicate_of_device_name}` : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-[11px]">
                      {d.address ? (
                        <span className="mono num-tab text-[12px]" style={{ color: 'var(--ink-2)' }}>{d.address}</span>
                      ) : (
                        <span className="mono text-[11px] italic" style={{ color: 'var(--warn)' }}>
                          Not detected — enter manually
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-[11px]">
                      <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>{d.mac_address || '—'}</span>
                    </td>
                    <td className="px-4 py-[11px]">
                      <span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>{d.seen_by}</span>
                    </td>
                    <td className="px-4 py-[11px]">
                      <span className="mono text-[11px]" style={{ color: 'var(--ink-4)' }}>
                        {new Date(d.discovered_at).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-[11px]">
                      {canWrite && d.duplicate_of_device_id == null && (
                        <button
                          onClick={() => {
                            setAddPrefill({ name: d.identity || '', ip_address: d.address });
                            setShowAddModal(true);
                          }}
                          className="btn-primary text-[12px] py-[5px] px-3 flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" />
                          Add to Manager
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          )}
        </div>
      )}

      {showAddModal && (
        <AddDeviceModal
          prefill={addPrefill}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            queryClient.invalidateQueries({ queryKey: ['devices'] });
            queryClient.invalidateQueries({ queryKey: ['devices-discovered'] });
          }}
        />
      )}

      {editDevice && (
        <EditDeviceModal
          device={editDevice}
          onClose={() => setEditDevice(null)}
          onSuccess={() => {
            setEditDevice(null);
            queryClient.invalidateQueries({ queryKey: ['devices'] });
            queryClient.invalidateQueries({ queryKey: ['devices-discovered'] });
          }}
        />
      )}

      {showTryAllModal && (
        <TryAllDiscoveredModal
          discoveredDevices={visibleDiscovered.filter((d) => d.duplicate_of_device_id == null && !!d.address)}
          onClose={() => setShowTryAllModal(false)}
          onSuccess={() => {
            setShowTryAllModal(false);
            queryClient.invalidateQueries({ queryKey: ['devices'] });
            queryClient.invalidateQueries({ queryKey: ['devices-discovered'] });
          }}
        />
      )}
    </div>
  );
}
