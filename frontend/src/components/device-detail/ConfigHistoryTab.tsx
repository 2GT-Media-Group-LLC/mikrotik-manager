import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  History, Camera, RotateCcw, Trash2, AlertCircle, CheckCircle, Loader2, GitCompare,
} from 'lucide-react';
import { configHistoryApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { lineDiff } from '../../utils/lineDiff';
import { format } from 'date-fns';
import clsx from 'clsx';

interface Props {
  deviceId: number;
}

export default function ConfigHistoryTab({ deviceId }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['config-history', deviceId],
    queryFn: () => configHistoryApi.list(deviceId).then((r) => r.data),
    refetchInterval: 60_000,
  });

  // Default the comparison to "previous → latest" until the user picks otherwise.
  // Derived during render (no effect) so an unselected dropdown still shows a diff.
  const effectiveToId = toId ?? history[0]?.id ?? null;
  const effectiveFromId = fromId ?? history[1]?.id ?? null;

  const { data: diff } = useQuery({
    queryKey: ['config-diff', deviceId, effectiveFromId, effectiveToId],
    queryFn: () => configHistoryApi.diff(deviceId, effectiveFromId!, effectiveToId!).then((r) => r.data),
    enabled: effectiveFromId !== null && effectiveToId !== null && effectiveFromId !== effectiveToId,
  });

  const flash = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(''), 4000);
  };
  const fail = (err: unknown, fallback: string) => {
    const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
    setError(msg || fallback);
    setTimeout(() => setError(''), 20000);
  };

  const captureMutation = useMutation({
    mutationFn: () => configHistoryApi.capture(deviceId),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['config-history', deviceId] });
      flash(r.data.message || 'Snapshot captured');
    },
    onError: (err) => fail(err, 'Capture failed'),
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: number) => configHistoryApi.rollback(deviceId, id),
    onSuccess: (r) => {
      setRollbackConfirm(null);
      flash(r.data.message || 'Rolled back.');
    },
    onError: (err) => {
      setRollbackConfirm(null);
      fail(err, 'Rollback failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => configHistoryApi.delete(deviceId, id),
    onSuccess: () => {
      setDeleteConfirm(null);
      queryClient.invalidateQueries({ queryKey: ['config-history', deviceId] });
    },
    onError: (err) => {
      setDeleteConfirm(null);
      fail(err, 'Delete failed');
    },
  });

  const diffRows = diff ? lineDiff(diff.from.text, diff.to.text) : [];
  const addCount = diffRows.filter((r) => r.type === 'add').length;
  const delCount = diffRows.filter((r) => r.type === 'del').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Configuration History</h2>
        </div>
        {canWrite && (
          <button
            onClick={() => captureMutation.mutate()}
            disabled={captureMutation.isPending}
            className="btn-primary flex items-center gap-2"
          >
            {captureMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
            Capture snapshot
          </button>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-slate-400">
        Snapshots are captured automatically when the device configuration changes. Each one links a restorable
        backup so you can roll back to it.
      </p>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
          <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
          <p className="text-sm text-green-700 dark:text-green-400">{success}</p>
        </div>
      )}

      {/* History table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : history.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-4 text-center">
          <History className="w-14 h-14 text-gray-300 dark:text-slate-600" />
          <div>
            <p className="font-medium text-gray-700 dark:text-slate-300">No configuration snapshots yet</p>
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
              One will appear after the next config change, or capture one now.
            </p>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700">
                <th className="table-header px-4 py-2.5 text-left">Captured</th>
                <th className="table-header px-4 py-2.5 text-left">Change</th>
                <th className="table-header px-4 py-2.5 text-left">Rollback</th>
                <th className="table-header px-4 py-2.5 text-left w-40">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {history.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2.5 text-gray-900 dark:text-white whitespace-nowrap">
                    {format(new Date(s.collected_at), 'MMM d, yyyy HH:mm:ss')}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600 dark:text-slate-300 text-xs">
                    {s.change_summary || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {s.has_backup ? (
                      <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                        available
                      </span>
                    ) : (
                      <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                        no backup
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      {canWrite && (rollbackConfirm === s.id ? (
                        <span className="flex items-center gap-1 text-xs">
                          <button
                            onClick={() => rollbackMutation.mutate(s.id)}
                            disabled={rollbackMutation.isPending}
                            className="text-orange-600 hover:text-orange-700 font-medium"
                          >
                            {rollbackMutation.isPending ? 'Rolling back…' : 'Confirm rollback'}
                          </button>
                          <button onClick={() => setRollbackConfirm(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setRollbackConfirm(s.id)}
                          disabled={!s.has_backup}
                          title={s.has_backup ? 'Roll back to this configuration' : 'No backup linked to this snapshot'}
                          className="p-1.5 rounded text-gray-400 hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 disabled:cursor-not-allowed"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      ))}
                      {canWrite && (deleteConfirm === s.id ? (
                        <span className="flex items-center gap-1 text-xs">
                          <button
                            onClick={() => deleteMutation.mutate(s.id)}
                            disabled={deleteMutation.isPending}
                            className="text-red-600 hover:text-red-700 font-medium"
                          >
                            {deleteMutation.isPending ? '…' : 'Delete?'}
                          </button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(s.id)}
                          title="Delete this snapshot"
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
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
      )}

      {/* Compare / diff */}
      {history.length >= 2 && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h3 className="font-semibold text-sm text-gray-900 dark:text-white">Compare snapshots</h3>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <select
              className="input max-w-xs"
              value={effectiveFromId ?? ''}
              onChange={(e) => setFromId(e.target.value ? parseInt(e.target.value) : null)}
            >
              <option value="">Base (older)…</option>
              {history.map((s) => (
                <option key={s.id} value={s.id}>{format(new Date(s.collected_at), 'MMM d HH:mm:ss')}</option>
              ))}
            </select>
            <span className="text-gray-400">→</span>
            <select
              className="input max-w-xs"
              value={effectiveToId ?? ''}
              onChange={(e) => setToId(e.target.value ? parseInt(e.target.value) : null)}
            >
              <option value="">Compare (newer)…</option>
              {history.map((s) => (
                <option key={s.id} value={s.id}>{format(new Date(s.collected_at), 'MMM d HH:mm:ss')}</option>
              ))}
            </select>
            {diff && (
              <span className="text-xs ml-1">
                <span className="text-green-600 dark:text-green-400">+{addCount}</span>{' '}
                <span className="text-red-600 dark:text-red-400">−{delCount}</span>
              </span>
            )}
          </div>

          {effectiveFromId === effectiveToId ? (
            <p className="text-sm text-gray-400">Select two different snapshots to compare.</p>
          ) : diff ? (
            addCount + delCount === 0 ? (
              <p className="text-sm text-gray-400">No differences between these snapshots.</p>
            ) : (
              <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700 rounded-lg p-3 overflow-auto max-h-[28rem] leading-relaxed">
                {diffRows.map((row, idx) => (
                  <div
                    key={idx}
                    className={clsx(
                      'whitespace-pre-wrap',
                      row.type === 'add' && 'bg-green-100/70 dark:bg-green-900/30 text-green-800 dark:text-green-300',
                      row.type === 'del' && 'bg-red-100/70 dark:bg-red-900/30 text-red-800 dark:text-red-300',
                      row.type === 'ctx' && 'text-gray-500 dark:text-slate-500'
                    )}
                  >
                    {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
                    {row.text}
                  </div>
                ))}
              </pre>
            )
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading diff…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
