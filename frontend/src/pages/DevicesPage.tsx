import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Router, Wifi, Trash2, ChevronRight, Search, Radar, ArrowUpCircle, Pencil } from 'lucide-react';
import { devicesApi, topologyApi } from '../services/api';
import type { Device } from '../types';
import type { DiscoveredDevice } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import clsx from 'clsx';
import AddDeviceModal from '../components/devices/AddDeviceModal';
import EditDeviceModal from '../components/devices/EditDeviceModal';

function StatusDot({ status }: { status: Device['status'] }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium',
        status === 'online' && 'status-online',
        status === 'offline' && 'status-offline',
        status === 'unknown' && 'status-unknown'
      )}
    >
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full',
          status === 'online' && 'bg-green-500',
          status === 'offline' && 'bg-red-500',
          status === 'unknown' && 'bg-gray-400'
        )}
      />
      {status}
    </span>
  );
}

function DeviceTypeIcon({ type }: { type: Device['device_type'] }) {
  if (type === 'wireless_ap') return <Wifi className="w-5 h-5 text-blue-500" />;
  return <Router className="w-5 h-5 text-blue-500" />;
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

  const filtered = devices.filter(
    (d) =>
      !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.ip_address.includes(search) ||
      d.model?.toLowerCase().includes(search.toLowerCase())
  );

  const discoveredList = discovered as DiscoveredDevice[];
  const duplicateCount = useMemo(
    () => discoveredList.filter((d) => d.duplicate_of_device_id != null).length,
    [discoveredList]
  );
  const visibleDiscovered = useMemo(
    () => (hideDuplicates ? discoveredList.filter((d) => d.duplicate_of_device_id == null) : discoveredList),
    [discoveredList, hideDuplicates]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Devices
          {devices.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({devices.filter((d) => d.status === 'online').length}/{devices.length} online)
            </span>
          )}
        </h1>
        {canWrite && (
          <div className="flex items-center gap-2 flex-shrink-0">
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
              className="btn-secondary flex items-center gap-2"
            >
              <RefreshCw className={clsx('w-4 h-4', searching && 'animate-spin')} />
              {searching ? 'Searching…' : 'Search for Devices'}
            </button>
            <button
              onClick={() => { setAddPrefill(undefined); setShowAddModal(true); }}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add Device
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative w-full sm:max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          className="input pl-9"
          placeholder="Search devices..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Device list */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 bg-gray-100 dark:bg-slate-700 rounded-full flex items-center justify-center">
            <Router className="w-8 h-8 text-gray-400" />
          </div>
          <div>
            <p className="text-gray-700 dark:text-slate-300 font-medium">
              {search ? 'No devices match your search' : 'No devices added yet'}
            </p>
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
              {!search && 'Click "Add Device" to connect your first Mikrotik device'}
            </p>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700">
                <th className="table-header px-4 py-3">Device</th>
                <th className="table-header px-4 py-3">IP Address</th>
                <th className="table-header px-4 py-3">Model</th>
                <th className="table-header px-4 py-3">ROS Version</th>
                <th className="table-header px-4 py-3">Status</th>
                <th className="table-header px-4 py-3">Last Seen</th>
                <th className="table-header px-4 py-3 w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {filtered.map((device) => (
                <tr
                  key={device.id}
                  className="hover:bg-gray-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors"
                  onClick={() => navigate(`/devices/${device.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <DeviceTypeIcon type={device.device_type} />
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                          {device.name}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-slate-500">
                          {{ router: 'Router', switch: 'Switch', wireless_ap: 'Wireless AP', other: 'Other' }[device.device_type] ?? device.device_type}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600 dark:text-slate-400">
                    {device.ip_address}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-slate-400">
                    {device.model || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-slate-400">
                    <span className="flex items-center gap-1.5">
                      {device.ros_version || '—'}
                      {device.firmware_update_available && (
                        <span
                          title={device.latest_ros_version ? `Update available: ${device.latest_ros_version}` : 'Firmware update available'}
                          className="flex-shrink-0"
                        >
                          <ArrowUpCircle className="w-3.5 h-3.5 text-amber-500" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusDot status={device.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 dark:text-slate-500">
                    {device.last_seen
                      ? new Date(device.last_seen).toLocaleString()
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canWrite && (
                        <>
                          <button
                            onClick={() => syncMutation.mutate(device.id)}
                            disabled={syncMutation.isPending}
                            className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                            title="Sync now"
                          >
                            <RefreshCw
                              className={clsx('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')}
                            />
                          </button>
                          <button
                            onClick={() => setEditDevice(device)}
                            className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                            title="Edit device"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {deleteConfirm === device.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => deleteMutation.mutate(device.id)}
                                className="text-xs text-red-500 hover:text-red-600 font-medium px-1"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="text-xs text-gray-400 hover:text-gray-600 px-1"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(device.id)}
                              className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                              title="Delete device"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      <ChevronRight className="w-4 h-4 text-gray-300 dark:text-slate-600" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Discovered (unmanaged) MikroTik neighbors */}
      {discoveredList.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Radar className="w-4 h-4 text-amber-500" />
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-300">
              Discovered Devices
            </h2>
            <span className="text-xs text-gray-400 dark:text-slate-500">
              — Mikrotik neighbors seen by your managed devices, not yet added to management
            </span>
            <label
              className={clsx(
                'ml-auto flex items-center gap-2 text-xs select-none',
                duplicateCount === 0
                  ? 'text-gray-300 dark:text-slate-600 cursor-not-allowed'
                  : 'text-gray-600 dark:text-slate-400 cursor-pointer'
              )}
              title={
                duplicateCount === 0
                  ? 'No duplicates of already-managed devices detected'
                  : `${duplicateCount} row(s) match a device that's already managed (by MAC, IP, or identity)`
              }
            >
              <input
                type="checkbox"
                className="rounded border-gray-300 dark:border-slate-600"
                checked={hideDuplicates}
                disabled={duplicateCount === 0}
                onChange={(e) => setHideDuplicates(e.target.checked)}
              />
              Hide duplicates of managed devices
              {duplicateCount > 0 && (
                <span className="text-gray-400 dark:text-slate-500">({duplicateCount})</span>
              )}
            </label>
          </div>
          {visibleDiscovered.length === 0 ? (
            <div className="card p-4 text-xs text-gray-500 dark:text-slate-400 text-center">
              All {discoveredList.length} discovered neighbor(s) are already managed devices.
            </div>
          ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                  <th className="table-header px-4 py-2.5 text-left">Identity</th>
                  <th className="table-header px-4 py-2.5 text-left">IP Address</th>
                  <th className="table-header px-4 py-2.5 text-left">MAC Address</th>
                  <th className="table-header px-4 py-2.5 text-left">Seen By</th>
                  <th className="table-header px-4 py-2.5 text-left">Last Seen</th>
                  <th className="table-header px-4 py-2.5 w-36" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {visibleDiscovered.map((d, i) => (
                  <tr
                    key={d.mac_address || d.address || i}
                    className={clsx(
                      'hover:bg-amber-50/50 dark:hover:bg-amber-900/10',
                      d.duplicate_of_device_id != null && 'opacity-70'
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                      <div className="flex items-center gap-2">
                        <span>{d.identity || '—'}</span>
                        {d.duplicate_of_device_id != null && (
                          <span
                            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            title={`Matches managed device: ${d.duplicate_of_device_name ?? ''}`}
                          >
                            Already managed
                            {d.duplicate_of_device_name ? ` · ${d.duplicate_of_device_name}` : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-gray-600 dark:text-slate-400">
                      {d.address ? (
                        d.address
                      ) : (
                        <span className="text-amber-500 dark:text-amber-400 italic text-xs font-sans">
                          Not detected — enter manually
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-500">
                      {d.mac_address || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400 text-xs">
                      {d.seen_by}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 dark:text-slate-500 text-xs">
                      {new Date(d.discovered_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      {canWrite && d.duplicate_of_device_id == null && (
                        <button
                          onClick={() => {
                            setAddPrefill({ name: d.identity || '', ip_address: d.address });
                            setShowAddModal(true);
                          }}
                          className="btn-primary text-xs py-1 px-3 flex items-center gap-1"
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
    </div>
  );
}
