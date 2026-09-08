import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HardDrive, Plus, Download, RotateCcw, Trash2, AlertCircle, AlertTriangle,
  Loader2, X, Search, GitCompare, FileText, FilterX,
} from 'lucide-react';
import { backupsApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import type { Backup } from '../types';
import BackupViewerModal from '../components/backups/BackupViewerModal';
import { orderForDiff } from '../utils/backupCompare';
import { format } from 'date-fns';
import clsx from 'clsx';

/** One home for backup-type wording, used by the filter and the table badge. */
const TYPE_LABEL: Record<string, string> = {
  'config-snapshot': 'Config Snapshot',
  scheduled: 'Scheduled',
  manual: 'Manual',
  'pre-upgrade': 'Pre-upgrade',
};

function formatBytes(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function BackupsPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [selectedDevice, setSelectedDevice] = useState('');
  const [notes, setNotes] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  // Config-snapshot backups are confirmed via a modal (deleting also removes the snapshot).
  const [snapshotDeleteTarget, setSnapshotDeleteTarget] = useState<Backup | null>(null);
  const [error, setError] = useState('');

  // Filters (#134). Held together so the query key is a single object.
  const [filters, setFilters] = useState({ deviceId: '', type: '', from: '', to: '', search: '' });
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const clearFilters = () => setFilters({ deviceId: '', type: '', from: '', to: '', search: '' });

  const [selected, setSelected] = useState<number[]>([]);
  const [viewing, setViewing] = useState<number[] | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const { data: backups = [], isLoading } = useQuery({
    queryKey: ['backups', filters],
    queryFn: () => backupsApi.list(filters).then((r) => r.data),
  });

  const { data: types = [] } = useQuery({
    queryKey: ['backup-types'],
    queryFn: () => backupsApi.types().then((r) => r.data),
  });

  // What a bulk delete would actually remove, including the config snapshots
  // that go with it. Fetched before asking, so the confirmation can be specific
  // rather than "are you sure?".
  const { data: bulkPreview } = useQuery({
    queryKey: ['backup-bulk-preview', selected],
    queryFn: () => backupsApi.bulkDeletePreview(selected).then((r) => r.data),
    enabled: bulkConfirm && selected.length > 0,
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: () => backupsApi.bulkDelete(selected).then((r) => r.data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      queryClient.invalidateQueries({ queryKey: ['backup-types'] });
      setBulkConfirm(false);
      setSelected([]);
      if (res.failures.length > 0) {
        setError(`${res.deleted} deleted, ${res.failures.length} failed.`);
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Bulk delete failed');
      setBulkConfirm(false);
    },
  });

  const toggle = (id: number) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const allShownSelected = backups.length > 0 && backups.every((b) => selected.includes(b.id));
  const toggleAll = () =>
    setSelected(allShownSelected ? [] : backups.map((b) => b.id));

  // Exactly two, oldest first, so the diff reads forwards in time (tested in
  // utils/backupCompare — a reversed diff shows additions as deletions and
  // looks perfectly normal while doing it).
  const comparePair = orderForDiff(selected, backups);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: () => backupsApi.create(parseInt(selectedDevice), notes || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      setShowCreateForm(false);
      setSelectedDevice('');
      setNotes('');
      setError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Backup failed');
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => backupsApi.restore(id),
    onSuccess: () => setRestoreConfirm(null),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Restore failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => backupsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      setDeleteConfirm(null);
      setSnapshotDeleteTarget(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Delete failed');
      setSnapshotDeleteTarget(null);
    },
  });

  const downloadBackup = async (id: number, filename: string) => {
    const res = await backupsApi.download(id);
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Backups
          {backups.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({backups.length} total)
            </span>
          )}
        </h1>
        {canWrite && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Backup
          </button>
        )}
      </div>

      {/* Create backup form */}
      {showCreateForm && (
        <div className="card p-5 border-blue-200 dark:border-blue-700">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4">New Backup</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Device</label>
              <select
                className="input"
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
              >
                <option value="">Select a device...</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.ip_address})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Notes (optional)</label>
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Pre-upgrade backup..."
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => { setShowCreateForm(false); setError(''); }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={() => createMutation.mutate()}
              disabled={!selectedDevice || createMutation.isPending}
              className="btn-primary flex items-center gap-2"
            >
              {createMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <HardDrive className="w-4 h-4" />
              )}
              {createMutation.isPending ? 'Creating...' : 'Create Backup'}
            </button>
          </div>
          <p className="text-xs text-gray-400 dark:text-slate-500 mt-2">
            Backup uses SSH export. Make sure SSH credentials are configured for this device.
          </p>
        </div>
      )}

      {/* Filters (#134) */}
      <div className="card p-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[180px]">
          <label className="label text-[11px]">Search</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              className="input pl-8"
              placeholder="Device, filename or note…"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
          </div>
        </div>
        <div className="min-w-[150px]">
          <label className="label text-[11px]">Device</label>
          <select
            className="input"
            value={filters.deviceId}
            onChange={(e) => setFilters((f) => ({ ...f, deviceId: e.target.value }))}
          >
            <option value="">All devices</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="min-w-[140px]">
          <label className="label text-[11px]">Type</label>
          <select
            className="input"
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t.type} value={t.type}>{TYPE_LABEL[t.type] ?? t.type} ({t.count})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label text-[11px]">From</label>
          <input type="date" className="input"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </div>
        <div>
          <label className="label text-[11px]">To</label>
          <input type="date" className="input"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </div>
        {activeFilterCount > 0 && (
          <button onClick={clearFilters} className="btn-secondary flex items-center gap-1.5 text-xs">
            <FilterX className="w-3.5 h-3.5" /> Clear
          </button>
        )}
      </div>

      {/* Selection actions */}
      {selected.length > 0 && (
        <div className="card px-4 py-2.5 flex flex-wrap items-center gap-3 border-blue-200 dark:border-blue-800">
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {selected.length} selected
          </span>
          <button onClick={() => setSelected([])} className="text-xs text-gray-400 hover:text-gray-600">
            Clear
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => comparePair && setViewing(comparePair)}
              disabled={!comparePair}
              title={comparePair ? 'Compare the two selected backups' : 'Select exactly two backups to compare'}
              className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40"
            >
              <GitCompare className="w-3.5 h-3.5" /> Compare
            </button>
            {canWrite && (
              <button
                onClick={() => setBulkConfirm(true)}
                className="btn-danger flex items-center gap-1.5 text-xs"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete {selected.length}
              </button>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading...</div>
      ) : backups.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-4 text-center">
          <HardDrive className="w-16 h-16 text-gray-300 dark:text-slate-600" />
          <div>
            <p className="font-medium text-gray-700 dark:text-slate-300">
              {activeFilterCount > 0 ? 'No backups match these filters' : 'No backups yet'}
            </p>
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
              {activeFilterCount > 0
                ? 'Try widening the date range or clearing a filter.'
                : 'Create a backup to save your device configurations'}
            </p>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="btn-secondary mt-3 text-xs">Clear filters</button>
            )}
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700">
                <th className="table-header px-3 py-2.5 w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={allShownSelected}
                    onChange={toggleAll}
                    className="cursor-pointer"
                  />
                </th>
                <th className="table-header px-4 py-2.5 text-left">Device</th>
                <th className="table-header px-4 py-2.5 text-left">Type</th>
                <th className="table-header px-4 py-2.5 text-left">Size</th>
                <th className="table-header px-4 py-2.5 text-left">Created</th>
                <th className="table-header px-4 py-2.5 text-left">Notes</th>
                <th className="table-header px-4 py-2.5 text-left w-36">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {backups.map((backup) => (
                <tr
                  key={backup.id}
                  onClick={() => setViewing([backup.id])}
                  title="Click to preview"
                  className={clsx(
                    'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/30',
                    selected.includes(backup.id) && 'bg-blue-50/60 dark:bg-blue-900/10'
                  )}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${backup.filename}`}
                      checked={selected.includes(backup.id)}
                      onChange={() => toggle(backup.id)}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                    {backup.device_name || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={clsx(
                        'inline-flex text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap',
                        backup.backup_type === 'config-snapshot' &&
                          'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
                        backup.backup_type === 'scheduled' &&
                          'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
                        backup.backup_type === 'manual' &&
                          'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                      )}
                      title={
                        backup.backup_type === 'config-snapshot'
                          ? 'Auto-created by Config History — tied to a config snapshot'
                          : undefined
                      }
                    >
                      {TYPE_LABEL[backup.backup_type ?? ''] ?? backup.backup_type ?? 'Manual'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">
                    {formatBytes(backup.size_bytes)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">
                    {format(new Date(backup.created_at), 'MMM d, yyyy HH:mm')}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500 italic">
                    {backup.notes || ''}
                  </td>
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setViewing([backup.id])}
                        className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        title="Preview"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => downloadBackup(backup.id, backup.filename)}
                        className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        title="Download"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>

                      {canWrite && (restoreConfirm === backup.id ? (
                        <div className="flex gap-1 text-xs">
                          <button
                            onClick={() => restoreMutation.mutate(backup.id)}
                            disabled={restoreMutation.isPending}
                            className="text-orange-500 hover:text-orange-600 font-medium"
                          >
                            {restoreMutation.isPending ? '...' : 'Restore?'}
                          </button>
                          <button
                            onClick={() => setRestoreConfirm(null)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setRestoreConfirm(backup.id)}
                          className="p-1.5 rounded text-gray-400 hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors"
                          title="Restore"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      ))}

                      {canWrite && (deleteConfirm === backup.id ? (
                        <div className="flex gap-1 text-xs">
                          <button
                            onClick={() => deleteMutation.mutate(backup.id)}
                            className="text-red-500 hover:text-red-600 font-medium"
                          >
                            Delete?
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() =>
                            backup.backup_type === 'config-snapshot'
                              ? setSnapshotDeleteTarget(backup)
                              : setDeleteConfirm(backup.id)
                          }
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {viewing && (
        <BackupViewerModal
          ids={viewing}
          onClose={() => setViewing(null)}
          onDownload={downloadBackup}
        />
      )}

      {/* Bulk delete confirmation.
          Backups and their config snapshots are deliberately one artifact, so a
          bulk delete can remove restore points the operator never looked at.
          The confirmation therefore names exactly what goes, per device, and
          says plainly that there is no undo. */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="card w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                Delete {selected.length} backup{selected.length === 1 ? '' : 's'}?
              </h3>
              <button
                onClick={() => setBulkConfirm(false)}
                disabled={bulkDeleteMutation.isPending}
                className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {!bulkPreview ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Checking what this removes…
                </div>
              ) : (
                <>
                  <div className="text-sm text-gray-600 dark:text-slate-300">
                    <ul className="space-y-1">
                      {bulkPreview.devices.map((d) => (
                        <li key={d.name} className="flex justify-between gap-4">
                          <span className="text-gray-900 dark:text-white">{d.name}</span>
                          <span className="text-gray-400">{d.count} backup{d.count === 1 ? '' : 's'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {bulkPreview.snapshots > 0 && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3">
                      <p className="text-sm text-amber-800 dark:text-amber-300">
                        <span className="font-semibold">{bulkPreview.snapshots}</span> of these
                        {bulkPreview.snapshots === 1 ? ' is' : ' are'} tied to a{' '}
                        <span className="font-medium">Config History snapshot</span>. Deleting
                        {bulkPreview.snapshots === 1 ? ' it' : ' them'} also removes
                        {bulkPreview.snapshots === 1 ? ' that snapshot' : ' those snapshots'} and the
                        ability to roll back to {bulkPreview.snapshots === 1 ? 'it' : 'them'}.
                      </p>
                    </div>
                  )}

                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    This cannot be undone.
                  </p>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setBulkConfirm(false)}
                  disabled={bulkDeleteMutation.isPending}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={() => bulkDeleteMutation.mutate()}
                  disabled={bulkDeleteMutation.isPending || !bulkPreview}
                  className="btn-danger inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {bulkDeleteMutation.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                  Delete {bulkPreview?.backups ?? selected.length}
                  {bulkPreview && bulkPreview.snapshots > 0 ? ' + snapshots' : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm deletion of a snapshot-linked backup (removes the config snapshot too) */}
      {snapshotDeleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                Delete config snapshot backup?
              </h3>
              <button
                onClick={() => setSnapshotDeleteTarget(null)}
                disabled={deleteMutation.isPending}
                className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600 dark:text-slate-300">
                This backup is tied to a <span className="font-medium">Config History snapshot</span> for{' '}
                <span className="font-medium text-gray-900 dark:text-white">{snapshotDeleteTarget.device_name || 'this device'}</span>.
              </p>
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3">
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  Deleting it will also <span className="font-semibold">permanently remove that snapshot from the
                  device&apos;s Config History</span>, and you will no longer be able to roll back to it.
                </p>
              </div>
              <p className="text-xs text-gray-500 dark:text-slate-400 font-mono break-all">
                {snapshotDeleteTarget.filename}
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSnapshotDeleteTarget(null)}
                  disabled={deleteMutation.isPending}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(snapshotDeleteTarget.id)}
                  disabled={deleteMutation.isPending}
                  className="btn-danger inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Delete backup &amp; snapshot
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
