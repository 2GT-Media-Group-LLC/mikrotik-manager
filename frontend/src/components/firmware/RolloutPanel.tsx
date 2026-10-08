import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckCircle, XCircle, Clock, HardDrive, ShieldAlert, Rocket, Ban, ChevronRight, Cpu, Zap, Server } from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { firmwareApi, type FirmwareRolloutDevice } from '../../services/api';
import { ITEM_STATUS, ROLLOUT_STATUS } from './rolloutStatus';

// ─── Rollout progress panel ────────────────────────────────────────────────────

export default function RolloutPanel({ rolloutId, canWrite }: { rolloutId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data: rollout } = useQuery({
    queryKey: ['fw-rollout', rolloutId],
    queryFn: () => firmwareApi.getRollout(rolloutId).then(r => r.data),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'running' || s === 'pending' ? 4_000 : false;
    },
  });

  // The API answers a cancel with a note explaining that the device currently
  // being upgraded is never interrupted mid-write. That note was discarded, so
  // pressing Cancel looked like it did nothing at all (#138).
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const cancelMutation = useMutation({
    mutationFn: () => firmwareApi.cancelRollout(rolloutId).then(r => r.data),
    onSuccess: (data) => {
      setCancelNote(
        data?.note ?? 'Rollout cancelled. No further devices will be upgraded.'
      );
      qc.invalidateQueries({ queryKey: ['fw-rollout', rolloutId] });
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } } };
      setCancelNote(err.response?.data?.error ?? 'Could not cancel the rollout.');
    },
  });

  if (!rollout) return null;
  const waves = [...new Set((rollout.devices ?? []).map(d => d.wave))].sort((a, b) => a - b);
  const active = rollout.status === 'running' || rollout.status === 'pending';

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
        <Rocket className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{rollout.name}</h3>
        <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium capitalize', ROLLOUT_STATUS[rollout.status])}>
          {rollout.status}
        </span>
        {rollout.scheduled_at && rollout.status === 'pending' && (
          <span className="text-xs text-gray-400 dark:text-slate-500 flex items-center gap-1">
            <Clock className="w-3 h-3" />starts {formatDistanceToNow(new Date(rollout.scheduled_at), { addSuffix: true })}
            {' '}(not after {new Date(rollout.scheduled_until ?? new Date(rollout.scheduled_at).getTime() + 60 * 60_000).toLocaleString()})
          </span>
        )}
        {rollout.status === 'missed' && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Missed its start window, so it didn&apos;t run. Nothing was upgraded; schedule it again when it suits.
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-gray-400 dark:text-slate-500">
          {rollout.pre_backup && <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />pre-backup</span>}
          {rollout.halt_on_failure && <span className="flex items-center gap-1"><ShieldAlert className="w-3 h-3" />halt on failure</span>}
          {rollout.routerboot_after && <span className="flex items-center gap-1"><Cpu className="w-3 h-3" />+ RouterBOOT</span>}
          {rollout.post_command && (
            <span className="flex items-center gap-1" title={rollout.post_command}>
              <Zap className="w-3 h-3" />then {rollout.post_template_name ? `"${rollout.post_template_name}"` : 'commands'}
            </span>
          )}
          {rollout.package_source === 'mirror' && <span className="flex items-center gap-1" title="Devices set up for the local mirror pulled from it"><Server className="w-3 h-3" />local mirror</span>}
          {(rollout.wave_concurrency ?? 1) > 1 && (
            <span className="flex items-center gap-1" title="Devices in a wave upgrading at once">
              <Zap className="w-3 h-3" />{rollout.wave_concurrency} at once
            </span>
          )}
          {canWrite && active && (
            <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending || !!cancelNote}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50">
              <Ban className="w-3 h-3" />
              {cancelMutation.isPending ? 'Cancelling…' : cancelNote ? 'Cancelling' : 'Cancel'}
            </button>
          )}
        </span>
      </div>

      {cancelNote && (
        <div className="px-5 py-2 flex items-start gap-2 text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-900">
          <Ban className="w-3.5 h-3.5 mt-px flex-shrink-0" />
          <span>{cancelNote}</span>
        </div>
      )}

      {waves.map(w => (
        <div key={w}>
          <div className="px-5 py-1.5 bg-gray-50 dark:bg-slate-800/50 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
            Wave {w}{w === 1 ? ' — canary' : ''}
          </div>
          {(rollout.devices ?? []).filter(d => d.wave === w).map((d: FirmwareRolloutDevice) => {
            const meta = ITEM_STATUS[d.status] ?? ITEM_STATUS.pending;
            return (
              <div key={d.id} className="px-5 py-2.5 flex items-center gap-3 border-t border-gray-100 dark:border-slate-700/60">
                <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1 flex-shrink-0', meta.cls)}>
                  {meta.spin && <RefreshCw className="w-3 h-3 animate-spin" />}
                  {d.status === 'success' && <CheckCircle className="w-3 h-3" />}
                  {d.status === 'failed' && <XCircle className="w-3 h-3" />}
                  {meta.label}
                </span>
                <span className="cell-primary truncate">{d.device_name}</span>
                <span className="font-mono text-xs text-gray-400 dark:text-slate-500 flex items-center gap-1 flex-shrink-0">
                  {d.from_version || '—'}
                  {(d.to_version || d.status === 'success') && <><ChevronRight className="w-3 h-3" />{d.to_version || '?'}</>}
                </span>
                {d.error && <span className="text-xs text-red-500 truncate" title={d.error}>{d.error}</span>}
                {d.post_status && (
                  <span title={(d.post_status === 'ok' ? d.post_output : d.post_error) || undefined}
                    className={clsx('text-xs flex-shrink-0', d.post_status === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-500')}>
                    {d.post_status === 'ok' ? 'commands ran' : 'commands failed'}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500 flex-shrink-0">
                  {d.finished_at ? formatDistanceToNow(new Date(d.finished_at), { addSuffix: true }) : ''}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
