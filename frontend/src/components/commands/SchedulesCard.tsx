import { useState } from 'react';
import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, Play, Pencil, Trash2, Zap } from 'lucide-react';
import { commandsApi, type CommandSchedule } from '../../services/api';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';

const STATUS: Record<string, string> = {
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  halted: 'text-red-600 dark:text-red-400',
  missed: 'text-amber-600 dark:text-amber-400',
  pending: 'text-blue-600 dark:text-blue-400',
  running: 'text-blue-600 dark:text-blue-400',
};

/** Scheduled bulk commands (#359): when each runs next, how the last went, and its controls. */
export default function SchedulesCard({ schedules, timeZone, canWrite, onEdit, onOpenRun }: {
  schedules: CommandSchedule[];
  timeZone: string;
  canWrite: boolean;
  onEdit: (s: CommandSchedule) => void;
  onOpenRun: (runId: number) => void;
}) {
  const queryClient = useQueryClient();
  const { formatDateTime } = useDateTimeFormat();
  // In the manager's zone, which is the one schedules run in and the header names.
  const inZone = (iso: string) => { try { return formatDateTime(iso, { timeZone }); } catch { return formatDateTime(iso); } };
  const [error, setError] = useState('');
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['command-schedules'] });
    queryClient.invalidateQueries({ queryKey: ['command-runs'] });
  };
  const fail = (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'That didn’t work');
  const toggle = useMutation({ mutationFn: (s: CommandSchedule) => commandsApi.setScheduleEnabled(s.id, !s.enabled), onSuccess: refresh, onError: fail });
  const runNow = useMutation({ mutationFn: (s: CommandSchedule) => commandsApi.runScheduleNow(s.id), onSuccess: (r) => { refresh(); onOpenRun(r.data.id); }, onError: fail });
  const remove = useMutation({ mutationFn: (s: CommandSchedule) => commandsApi.deleteSchedule(s.id), onSuccess: refresh, onError: fail });

  if (schedules.length === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Schedules</h2>
        <span className="text-xs text-gray-400 dark:text-slate-500 ml-auto">Times in {timeZone}</span>
      </div>
      {error && <div className="px-5 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {schedules.map((s) => (
          <div key={s.id} className={clsx('px-5 py-3 flex items-start gap-3', !s.enabled && 'opacity-60')}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{s.name}</div>
              <div className="font-mono text-xs text-gray-500 dark:text-slate-400 truncate">{s.command.split('\n')[0]}</div>
              <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                {s.description}
                {' · '}{s.target_count} device{s.target_count === 1 ? '' : 's'} now
                {s.maintenance_only && ' · in maintenance windows only'}
                {!s.use_change_guard && ' · without Change Guard'}
              </div>
            </div>
            <div className="text-xs text-right shrink-0 space-y-0.5">
              <div className="text-gray-600 dark:text-slate-300">
                {s.enabled ? (s.next_run_at ? <>Next {inZone(s.next_run_at)}</> : 'Done') : 'Paused'}
              </div>
              {s.last_status && (
                <button className={clsx('hover:underline', STATUS[s.last_status] ?? 'text-gray-500')} onClick={() => s.last_run_id && onOpenRun(s.last_run_id)}>
                  Last: {s.last_status}
                </button>
              )}
            </div>
            {canWrite && (
              <div className="flex items-center gap-0.5 shrink-0">
                <button className="p-1.5 text-gray-400 hover:text-blue-600" title="Run now" disabled={runNow.isPending}
                  onClick={() => { if (confirm(`Run "${s.name}" now on its ${s.target_count} device${s.target_count === 1 ? '' : 's'}?`)) runNow.mutate(s); }}>
                  <Zap className="w-4 h-4" />
                </button>
                <button className="p-1.5 text-gray-400 hover:text-blue-600" title={s.enabled ? 'Pause' : 'Resume'} onClick={() => toggle.mutate(s)}>
                  {s.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <button className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit" onClick={() => onEdit(s)}><Pencil className="w-4 h-4" /></button>
                <button className="p-1.5 text-gray-400 hover:text-red-500" title="Delete"
                  onClick={() => { if (confirm(`Delete the schedule "${s.name}"? Its past runs stay in the history.`)) remove.mutate(s); }}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
