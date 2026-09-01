import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, Trash2 } from 'lucide-react';
import { pollerApi, type PollerHealth } from '../../services/api';

/**
 * The poller's own health, in the UI rather than buried in an API response.
 *
 * A fleet that outruns its workers presents as stale data everywhere, which
 * reads as a device problem rather than a capacity one. Making queue depth and
 * headroom visible is what turns "polling frequency is set by guesswork" into an
 * arithmetic question (#114).
 */

const STATUS: Record<PollerHealth['status'], { label: string; tone: string; icon: typeof Activity; blurb: string }> = {
  ok: {
    label: 'Keeping up', tone: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/40',
    icon: CheckCircle2,
    blurb: 'Workers are clearing polls faster than the schedule creates them.',
  },
  draining: {
    label: 'Working through a backlog', tone: 'text-amber-800 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40',
    icon: Clock,
    blurb: 'Capacity is sufficient, but queued work from earlier is still clearing. Devices poll late until it does.',
  },
  saturated: {
    label: 'Cannot keep up', tone: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40',
    icon: AlertTriangle,
    blurb: 'Polls are being created faster than they can run, so the backlog grows every cycle and devices will go stale.',
  },
};

const fmtDuration = (sec: number | null): string => {
  if (sec == null) return 'not shrinking';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
};

function Stat({ label, value, hint, alarm }: {
  label: string; value: string; hint?: string; alarm?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
      <div className="text-xs text-gray-500 dark:text-slate-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${
        alarm ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>{value}</div>
      {hint && <div className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

export default function PollerHealthCard() {
  const queryClient = useQueryClient();
  const [drainResult, setDrainResult] = useState('');
  const [confirmDrain, setConfirmDrain] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['poller-health'],
    queryFn: () => pollerApi.health().then(r => r.data),
    refetchInterval: 15_000,
  });

  const drain = useMutation({
    mutationFn: () => pollerApi.drain(),
    onSuccess: (res) => {
      setDrainResult(res.data.message);
      setConfirmDrain(false);
      queryClient.invalidateQueries({ queryKey: ['poller-health'] });
    },
  });

  if (isLoading || !data) {
    return <div className="text-sm text-gray-500 dark:text-slate-400">Loading poller health…</div>;
  }

  const s = STATUS[data.status] ?? STATUS.ok;
  const Icon = s.icon;
  const cap = data.capacity;
  const backlog = cap.backlog;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <Icon className="w-5 h-5 mt-0.5 text-gray-400 dark:text-slate-500" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 dark:text-white">Polling</h3>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.tone}`}>{s.label}</span>
            </div>
            <p className="text-sm text-gray-600 dark:text-slate-300 mt-0.5 max-w-2xl">{s.blurb}</p>
          </div>
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['poller-health'] })}
          className="btn-secondary flex items-center gap-2 text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Capacity. headroom and backlog are shown together deliberately: headroom
          alone once reported "healthy" to an operator with 752k jobs queued. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Devices" value={String(cap.devices)} />
        <Stat
          label="Headroom"
          value={cap.headroom == null ? '—' : `${cap.headroom}×`}
          hint="capacity ÷ demand"
          alarm={cap.headroom != null && cap.headroom < 1}
        />
        <Stat
          label="Queued"
          value={backlog.toLocaleString()}
          hint={backlog > 0 ? `clears in ${fmtDuration(cap.drain_eta_sec)}` : 'nothing waiting'}
          alarm={backlog > cap.devices * 3}
        />
        <Stat label="Avg poll" value={cap.avg_fast_poll_ms == null ? '—' : `${cap.avg_fast_poll_ms} ms`} />
        <Stat label="Slowest (p90)" value={cap.p90_fast_poll_ms == null ? '—' : `${cap.p90_fast_poll_ms} ms`} />
        <Stat
          label="Workers"
          value={String(data.workers.concurrency)}
          hint={`${data.workers.poll_interval_ms / 1000}s interval`}
        />
      </div>

      {cap.headroom != null && cap.headroom < 1.5 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700/60 dark:bg-amber-900/20">
          <div className="font-medium text-amber-900 dark:text-amber-200">Little margin left</div>
          <p className="mt-0.5 text-amber-800 dark:text-amber-300">
            Demand is {cap.arrival_per_sec}/s against {cap.service_per_sec ?? '—'}/s of capacity. Slow
            devices push individual polls well past the average, so bursts will fall behind even while
            the average looks fine. Raise <code>POLLER_CONCURRENCY</code> or lengthen the interval.
          </p>
        </div>
      )}

      {/* Queues */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="py-2 pr-4 font-medium">Queue</th>
              <th className="py-2 pr-4 font-medium text-right">Waiting</th>
              <th className="py-2 pr-4 font-medium text-right">Active</th>
              <th className="py-2 pr-4 font-medium text-right">Failed</th>
            </tr>
          </thead>
          <tbody>
            {data.queues.map(q => (
              <tr key={q.name} className="border-b border-gray-100 dark:border-slate-800 last:border-0">
                <td className="py-2 pr-4 font-mono text-xs text-gray-900 dark:text-white">{q.name}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${
                  (q.waiting || 0) > 0 ? 'text-amber-700 dark:text-amber-400 font-medium'
                                       : 'text-gray-600 dark:text-slate-300'}`}>
                  {(q.waiting ?? 0).toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-600 dark:text-slate-300">{q.active ?? 0}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-600 dark:text-slate-300">{q.failed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Clearing the queue */}
      <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="text-xs text-gray-600 dark:text-slate-300 max-w-2xl">
            <span className="font-medium text-gray-900 dark:text-white">Clear the queue.</span>{' '}
            Discards everything currently queued. Nothing is lost — the scheduler re-enqueues whatever
            is still due on its next cycle, so the cost is at most one interval of freshness. Stale
            polls are also dropped automatically once they are older than their own cadence.
          </div>
          {confirmDrain ? (
            <div className="flex items-center gap-2">
              <button onClick={() => drain.mutate()} disabled={drain.isPending}
                      className="btn-danger text-xs flex items-center gap-1.5">
                {drain.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Confirm clear
              </button>
              <button onClick={() => setConfirmDrain(false)} className="btn-secondary text-xs">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDrain(true)} disabled={backlog === 0}
                    className="btn-secondary text-xs flex items-center gap-1.5 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Clear {backlog > 0 ? backlog.toLocaleString() : ''} queued
            </button>
          )}
        </div>
        {drainResult && <p className="mt-2 text-xs text-green-700 dark:text-green-400">{drainResult}</p>}
      </div>

      {/* Which devices are actually being missed */}
      <div>
        <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-2">
          Devices not polled recently {data.stale_devices.length > 0 && `(${data.stale_devices.length})`}
        </h4>
        {data.stale_devices.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Every device has been polled successfully in the last few minutes.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.stale_devices.map(d => (
              <li key={`${d.id}-${d.kind}`} className="text-xs flex flex-wrap gap-x-2 gap-y-0.5">
                <span className="font-medium text-gray-900 dark:text-white">{d.name}</span>
                <span className="text-gray-500 dark:text-slate-400">
                  {d.last_success_at
                    ? `last success ${fmtDuration(d.seconds_since_success)} ago`
                    : 'never polled successfully'}
                </span>
                {/* Attempt vs success is the distinction that says whether we
                    missed it or it did not answer. */}
                {d.last_error
                  ? <span className="text-red-600 dark:text-red-400">responded with: {d.last_error}</span>
                  : <span className="text-amber-700 dark:text-amber-400">not attempted recently</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
