import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIsFleetAdmin } from '../../hooks/useCanWrite';
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, Trash2 } from 'lucide-react';
import { pollerApi, settingsApi, type PollerHealth, type PollerPhases } from '../../services/api';

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

/** Fallback capacity, so a partial or unexpected payload cannot blank the page. */
const EMPTY_CAPACITY: PollerHealth['capacity'] = {
  devices: 0, avg_fast_poll_ms: null, p90_fast_poll_ms: null,
  arrival_per_sec: 0, service_per_sec: null, headroom: null,
  backlog: 0, drain_eta_sec: 0,
};

export default function PollerHealthCard() {
  const queryClient = useQueryClient();
  const [drainResult, setDrainResult] = useState('');
  const [confirmDrain, setConfirmDrain] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
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

  if (isLoading) {
    return <div className="text-sm text-gray-500 dark:text-slate-400">Loading poller health…</div>;
  }

  /**
   * Failure has to be visible here of all places.
   *
   * This panel previously rendered "Loading…" forever on an error and threw
   * outright on an unexpected payload, blanking the whole page — the worst
   * possible behaviour for the one screen you open when monitoring looks broken.
   * Whatever comes back, say something useful about it.
   */
  if (isError || !data || typeof data !== 'object') {
    const msg = (error as { response?: { data?: { error?: string } }; message?: string } | null);
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-700/60 dark:bg-red-900/20">
        <div className="flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" /> Could not read poller health
        </div>
        <p className="mt-1 text-red-700 dark:text-red-300">
          {msg?.response?.data?.error || msg?.message || 'The server returned an unexpected response.'}
        </p>
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Polling itself may still be running — this panel only reports on it. Check the backend logs
          if this persists.
        </p>
        <button onClick={() => queryClient.invalidateQueries({ queryKey: ['poller-health'] })}
                className="btn-secondary mt-3 flex items-center gap-2 text-xs">
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  // Every field below is defaulted. A backend a version behind, or one that
  // answered partially, degrades the panel rather than destroying the page.
  const s = STATUS[data.status] ?? STATUS.ok;
  const Icon = s.icon;
  const cap = data.capacity ?? EMPTY_CAPACITY;
  const backlog = cap.backlog ?? 0;
  const queues = Array.isArray(data.queues) ? data.queues : [];
  const staleDevices = Array.isArray(data.stale_devices) ? data.stale_devices : [];
  const workers = data.workers ?? { concurrency: 0, job_timeout_ms: 0, poll_interval_ms: 0 };

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
        <Stat label="Devices" value={String(cap.devices ?? 0)} />
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
          value={String(workers.concurrency)}
          hint={(workers.processes?.length ?? 0) > 1
            ? `in ${workers.processes!.length} processes · fast poll every ${workers.fast_interval_sec ?? '?'}s`
            : workers.fast_interval_sec ? `fast poll every ${workers.fast_interval_sec}s` : `${(workers.poll_interval_ms || 0) / 1000}s interval`}
        />
      </div>

      {data.phases && <PhasesPanel phases={data.phases} onSaved={() => queryClient.invalidateQueries({ queryKey: ['poller-health'] })} />}

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
            {queues.map(q => (
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
          Devices not polled recently {staleDevices.length > 0 && `(${staleDevices.length})`}
        </h4>
        {staleDevices.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Every device has been polled successfully in the last few minutes.
          </p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {staleDevices.map(d => (
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

/**
 * Where a fast poll's time goes (#301): opening a session (TCP, TLS, login)
 * against reusing one, and the work itself, with the switch for keeping
 * sessions open between polls.
 */
function PhasesPanel({ phases, onSaved }: { phases: PollerPhases; onSaved: () => void }) {
  const isFleetAdmin = useIsFleetAdmin();
  const save = useMutation({
    mutationFn: (v: { key: 'poller_persistent_sessions' | 'poller_pipelined_reads'; on: boolean }) => settingsApi.update({ [v.key]: v.on }),
    onSuccess: onSaved,
  });
  const ms = (v: number | null | undefined) => (v == null ? '—' : `${v} ms`);
  const other = phases.avg_collect_ms != null && phases.avg_device_ms != null ? Math.max(0, phases.avg_collect_ms - phases.avg_device_ms) : null;
  const slowest = phases.slowest ?? [];
  const widest = Math.max(1, ...slowest.map((r) => r.total_ms));
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-medium text-gray-700 dark:text-slate-200">Where a fast poll’s time goes</div>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300" title="Off by default: each poll opens its own connection. On: one API session per device is kept open and reused, which saves the handshake and login on every poll">
            <input type="checkbox" checked={phases.persistent_sessions} disabled={!isFleetAdmin || save.isPending}
              onChange={(e) => save.mutate({ key: 'poller_persistent_sessions', on: e.target.checked })} />
            Keep sessions open between polls
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300" title="Send a fast poll’s reads together, in one round trip, instead of one after another">
            <input type="checkbox" checked={phases.pipelined_reads} disabled={!isFleetAdmin || save.isPending}
              onChange={(e) => save.mutate({ key: 'poller_pipelined_reads', on: e.target.checked })} />
            Send reads together
          </label>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div><div className="text-gray-500">Connecting</div><div className="font-medium tabular-nums">{ms(phases.avg_connect_new_ms)}</div></div>
        <div><div className="text-gray-500">Waiting on the device</div><div className="font-medium tabular-nums">{ms(phases.avg_device_ms)}</div></div>
        <div><div className="text-gray-500">Database and processing</div><div className="font-medium tabular-nums">{ms(other)}</div></div>
        <div>
          <div className="text-gray-500">Sessions kept open</div>
          <div className="font-medium tabular-nums">
            {phases.persistent_sessions
              ? <>{phases.reused_pct == null ? '—' : `${phases.reused_pct}% reused`} · {phases.open_sessions} open{phases.avg_connect_reused_ms != null ? ` · ${phases.avg_connect_reused_ms} ms` : ''}</>
              : 'Off'}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-400">
        Connecting is a TCP and TLS handshake and a login: a few round trips, plus work on the router’s CPU. Waiting on the
        device is the round trips and the router answering; the rest is this server. Averages over the last fast poll of{' '}
        {phases.devices_measured === 1 ? 'one device' : `${phases.devices_measured} devices`}.
      </p>

      {slowest.length > 0 && (
        <div>
          <div className="flex items-center gap-3 text-[11px] text-gray-500 mb-1.5 flex-wrap">
            <span className="font-medium text-gray-700 dark:text-slate-200">Slowest fast polls</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" />connecting</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" />waiting on the device</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-400" />database and processing</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-500 sticky top-0 bg-white dark:bg-slate-800">
                <tr>
                  <th className="text-left font-medium py-1">Device</th>
                  <th className="text-right font-medium px-2">Total</th>
                  <th className="text-right font-medium px-2">Connect</th>
                  <th className="text-right font-medium px-2">Device</th>
                  <th className="text-right font-medium px-2">Other</th>
                  <th className="font-medium w-40" />
                </tr>
              </thead>
              <tbody>
                {slowest.map((r) => {
                  const w = (v: number | null) => `${((v ?? 0) / widest) * 100}%`;
                  return (
                    <tr key={r.id} className="border-t border-gray-100 dark:border-slate-700/50" title={r.error ?? undefined}>
                      <td className="py-1 pr-2 min-w-0">
                        <Link to={`/devices/${r.id}`} className="hover:underline text-gray-900 dark:text-white">{r.name}</Link>
                        {r.site && <span className="text-gray-400"> · {r.site}</span>}
                        {r.reused && <span className="text-gray-400"> · reused session</span>}
                        {r.error && <span className="text-red-500"> · failed</span>}
                      </td>
                      <td className="text-right px-2 tabular-nums font-medium">{r.total_ms} ms</td>
                      <td className="text-right px-2 tabular-nums">{ms(r.connect_ms)}</td>
                      <td className="text-right px-2 tabular-nums">{ms(r.device_ms)}</td>
                      <td className="text-right px-2 tabular-nums">{ms(r.other_ms)}</td>
                      <td className="pl-2">
                        <div className="flex h-2 rounded-sm overflow-hidden bg-gray-100 dark:bg-slate-700" style={{ width: w(r.total_ms) }}>
                          {r.connect_ms != null && r.device_ms != null ? (
                            <>
                              <div className="bg-amber-400" style={{ width: `${(r.connect_ms / Math.max(1, r.total_ms)) * 100}%` }} />
                              <div className="bg-blue-500" style={{ width: `${(r.device_ms / Math.max(1, r.total_ms)) * 100}%` }} />
                              <div className="bg-gray-400 flex-1" />
                            </>
                          ) : <div className="bg-gray-300 flex-1" />}
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
    </div>
  );
}
