import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, AlertTriangle, CheckCircle2, XCircle, MinusCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { sshFleetApi, tagsApi, type FleetKeyJob } from '../../services/api';
import { useSiteStore } from '../../store/siteStore';

/**
 * Installing SSH keys across the fleet (#160 follow-up).
 *
 * Keys could only be installed one device at a time from the device page, and
 * the fleet endpoint ran inside one HTTP request that a large fleet would
 * outlast. This is a preview, then a background job with progress.
 *
 * The preview names the accounts that will lose password SSH before anything
 * runs, because that is the one consequence an operator must agree to.
 */

const JOB_KEY = 'ssh-fleet-job';
const RUNNING: FleetKeyJob['status'][] = ['queued', 'active'];

export default function FleetSshKeysCard() {
  const qc = useQueryClient();
  const siteId = useSiteStore((s) => s.currentSiteId);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => {
    try { return localStorage.getItem(JOB_KEY); } catch { return null; }
  });
  const [startError, setStartError] = useState('');

  const { data: tags = [] } = useQuery({
    queryKey: ['tags'],
    queryFn: () => tagsApi.list().then((r) => r.data),
  });

  const preview = useQuery({
    queryKey: ['ssh-fleet-preview', siteId, tagIds],
    queryFn: () => sshFleetApi.preview(tagIds).then((r) => r.data),
    enabled: !jobId,
  });

  const job = useQuery({
    queryKey: ['ssh-fleet-job', jobId],
    queryFn: () => sshFleetApi.status(jobId!).then((r) => r.data),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && !RUNNING.includes(q.state.data.status) ? false : 1500),
    retry: false,
  });

  // A job that expired (24h) or belongs to a wiped Redis: forget it.
  useEffect(() => {
    if (jobId && job.isError) forgetJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.isError]);

  // Changing scope invalidates the acknowledgement: it was given for a list.
  useEffect(() => { setAcknowledged(false); }, [siteId, tagIds]);

  const start = useMutation({
    mutationFn: (ids: number[]) => sshFleetApi.start(ids).then((r) => r.data),
    onSuccess: (r) => {
      try { localStorage.setItem(JOB_KEY, r.job_id); } catch { /* private mode */ }
      setJobId(r.job_id);
      setStartError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setStartError(msg || 'Could not start the job');
    },
  });

  const cancel = useMutation({
    mutationFn: () => sshFleetApi.cancel(jobId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ssh-fleet-job', jobId] }),
  });

  function forgetJob() {
    try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ }
    setJobId(null);
    setAcknowledged(false);
    qc.invalidateQueries({ queryKey: ['ssh-fleet-preview'] });
  }

  const toggleTag = (id: number) =>
    setTagIds((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]));

  const p = preview.data;
  const usernames = useMemo(() => (p?.accounts ?? []).map((a) => a.username), [p]);

  return (
    <div className="card p-5 space-y-4 max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center flex-shrink-0">
          <KeyRound className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h2 className="font-semibold text-gray-900 dark:text-white">SSH keys for the fleet</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Installs a separate key on each device, so backups, config export and bulk commands stop
            using passwords over SSH. One device at a time, in the background. You can leave this page.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          Once a key is installed, RouterOS turns off <strong>password SSH for that user</strong> on
          the device. The API and WinBox keep working. To get password SSH back on a device, revoke
          its key on the device&apos;s System tab.
        </div>
      </div>

      {jobId ? <JobView job={job.data} loading={job.isLoading} onCancel={() => cancel.mutate()}
                        cancelling={cancel.isPending} onDone={forgetJob} /> : (
        <>
          {tags.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">
                Limit to tags (optional). The site picker at the top also applies.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTag(t.id)}
                    className={clsx(
                      'px-2 py-0.5 rounded-full text-xs border',
                      tagIds.includes(t.id)
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300'
                    )}
                  >
                    <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: t.color }} />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {preview.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Checking devices…</div>
          ) : preview.isError ? (
            <div className="text-sm text-red-600">Could not load the preview.</div>
          ) : p && (
            <>
              <div className="text-sm text-gray-700 dark:text-slate-300">
                <strong>{p.eligible.length}</strong> will get a key ·{' '}
                {p.keyed.length} already have one · {p.skipped.length} skipped
                <button onClick={() => preview.refetch()} className="ml-2 text-gray-400 hover:text-gray-600" title="Refresh">
                  <RefreshCw className={clsx('w-3.5 h-3.5 inline', preview.isFetching && 'animate-spin')} />
                </button>
              </div>

              {p.accounts.length > 0 && (
                <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 text-sm space-y-1">
                  <div className="text-xs font-medium text-gray-500 dark:text-slate-400">Accounts that will need the key for SSH</div>
                  {p.accounts.map((a) => (
                    <div key={a.username} className="text-gray-800 dark:text-slate-200">
                      <span className="mono">{a.username}</span> on {a.devices} device{a.devices === 1 ? '' : 's'}
                      {a.via_api_login > 0 && (
                        <span className="text-gray-500 dark:text-slate-400">
                          {' '}({a.via_api_login === a.devices ? 'all' : a.via_api_login} using the API login, as no SSH login is stored)
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {p.eligible.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-slate-300">Devices that will get a key ({p.eligible.length})</summary>
                  <table className="w-full mt-2 text-xs">
                    <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                      {p.eligible.map((d) => (
                        <tr key={d.id}>
                          <td className="py-1 pr-2 text-gray-900 dark:text-white">{d.name}</td>
                          <td className="py-1 pr-2 mono text-gray-500">{d.ip_address}</td>
                          <td className="py-1 pr-2 mono">{d.username}</td>
                          <td className="py-1 text-gray-500">{d.source === 'api' ? 'API login' : 'SSH login'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {p.skipped.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-slate-300">Skipped ({p.skipped.length})</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {p.skipped.map((d) => (
                      <li key={d.id}><span className="text-gray-900 dark:text-white">{d.name}</span>: <span className="text-gray-500">{d.reason}</span></li>
                    ))}
                  </ul>
                </details>
              )}

              {p.eligible.length > 0 && (
                <div className="space-y-3 pt-1">
                  <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                    <span>
                      I understand that password SSH will stop working for{' '}
                      <strong className="mono">{usernames.join(', ')}</strong> on these {p.eligible.length} device
                      {p.eligible.length === 1 ? '' : 's'}.
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    The job stops by itself after {p.halt_after} failures in a row. A device that fails is left as it was.
                  </p>
                  {startError && <div className="text-sm text-red-600">{startError}</div>}
                  <button
                    className="btn-primary flex items-center gap-2 text-sm"
                    disabled={!acknowledged || start.isPending}
                    onClick={() => start.mutate(p.eligible.map((d) => d.id))}
                  >
                    {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                    Install keys on {p.eligible.length} device{p.eligible.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function JobView({ job, loading, onCancel, cancelling, onDone }: {
  job: FleetKeyJob | undefined; loading: boolean; onCancel: () => void; cancelling: boolean; onDone: () => void;
}) {
  if (loading || !job) {
    return <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading job…</div>;
  }
  const running = RUNNING.includes(job.status);
  const pct = job.total ? Math.round((job.processed / job.total) * 100) : 0;
  const label: Record<FleetKeyJob['status'], string> = {
    queued: 'Waiting to start', active: 'Running', completed: 'Finished', cancelled: 'Cancelled',
    halted: 'Stopped', failed: 'Stopped unexpectedly',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-900 dark:text-white">
          {label[job.status]} · {job.processed} of {job.total}
          {job.current_name && running && <span className="text-gray-500 font-normal"> · {job.current_name}</span>}
        </span>
        {running ? (
          <button className="btn-secondary text-xs py-1" onClick={onCancel} disabled={cancelling}>Cancel</button>
        ) : (
          <button className="btn-secondary text-xs py-1" onClick={onDone}>Done</button>
        )}
      </div>
      <div className="h-2 rounded bg-gray-100 dark:bg-slate-700 overflow-hidden">
        <div className={clsx('h-full', job.status === 'halted' || job.status === 'failed' ? 'bg-red-500' : 'bg-blue-600')}
             style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-gray-600 dark:text-slate-300">
        {job.keyed ?? 0} keyed · {job.failed ?? 0} failed · {job.skipped ?? 0} skipped
      </div>
      {job.error && <div className="text-sm text-red-600">{job.error}</div>}
      {job.results.length > 0 && (
        <table className="w-full text-xs">
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
            {[...job.results].reverse().map((r) => (
              <tr key={r.device_id}>
                <td className="py-1 pr-2 w-5">
                  {r.outcome === 'keyed' ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                    : r.outcome === 'failed' ? <XCircle className="w-3.5 h-3.5 text-red-500" />
                    : <MinusCircle className="w-3.5 h-3.5 text-gray-400" />}
                </td>
                <td className="py-1 pr-2 text-gray-900 dark:text-white whitespace-nowrap">{r.name}</td>
                <td className="py-1 text-gray-500">{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
