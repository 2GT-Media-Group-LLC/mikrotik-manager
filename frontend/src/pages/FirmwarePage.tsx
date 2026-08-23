import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle, RefreshCw, CheckCircle, XCircle, AlertTriangle, Clock,
  HardDrive, ShieldAlert, Rocket, Ban, ChevronRight, Cpu,
} from 'lucide-react';
import clsx from 'clsx';
import { firmwareApi } from '../services/api';
import type { FirmwareRolloutDevice } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { formatDistanceToNow } from 'date-fns';
import ChangelogModal from '../components/ChangelogModal';

const ITEM_STATUS: Record<string, { label: string; cls: string; spin?: boolean }> = {
  pending:    { label: 'Pending',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
  backing_up: { label: 'Backing up',   cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400', spin: true },
  upgrading:  { label: 'Upgrading',    cls: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400', spin: true },
  rebooting:  { label: 'Rebooting',    cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', spin: true },
  verifying:  { label: 'Verifying',    cls: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400', spin: true },
  success:    { label: 'Success',      cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  failed:     { label: 'Failed',       cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  skipped:    { label: 'Skipped',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
};

const ROLLOUT_STATUS: Record<string, string> = {
  pending:   'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300',
  running:   'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed:    'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  cancelled: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400',
};

function TypePill({ type }: { type: string }) {
  const label = type === 'wireless_ap' ? 'AP' : type === 'switch' ? 'SW' : type === 'router' ? 'RTR' : '—';
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">{label}</span>;
}

// ─── Rollout progress panel ────────────────────────────────────────────────────

function RolloutPanel({ rolloutId, canWrite }: { rolloutId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data: rollout } = useQuery({
    queryKey: ['fw-rollout', rolloutId],
    queryFn: () => firmwareApi.getRollout(rolloutId).then(r => r.data),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'running' || s === 'pending' ? 4_000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => firmwareApi.cancelRollout(rolloutId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fw-rollout', rolloutId] }),
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
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-gray-400 dark:text-slate-500">
          {rollout.pre_backup && <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />pre-backup</span>}
          {rollout.halt_on_failure && <span className="flex items-center gap-1"><ShieldAlert className="w-3 h-3" />halt on failure</span>}
          {rollout.routerboot_after && <span className="flex items-center gap-1"><Cpu className="w-3 h-3" />+ RouterBOOT</span>}
          {canWrite && active && (
            <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <Ban className="w-3 h-3" />Cancel
            </button>
          )}
        </span>
      </div>

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
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{d.device_name}</span>
                <span className="font-mono text-xs text-gray-400 dark:text-slate-500 flex items-center gap-1 flex-shrink-0">
                  {d.from_version || '—'}
                  {(d.to_version || d.status === 'success') && <><ChevronRight className="w-3 h-3" />{d.to_version || '?'}</>}
                </span>
                {d.error && <span className="text-xs text-red-500 truncate" title={d.error}>{d.error}</span>}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FirmwarePage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [selected, setSelected] = useState<Map<number, number>>(new Map()); // deviceId → wave
  const [rolloutName, setRolloutName] = useState('');
  const [preBackup, setPreBackup] = useState(true);
  const [haltOnFailure, setHaltOnFailure] = useState(true);
  // Off by default: it is a second flash and a second reboot per device (#113).
  const [routerbootAfter, setRouterbootAfter] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [viewRolloutId, setViewRolloutId] = useState<number | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [changelogVersion, setChangelogVersion] = useState<string | null>(null);

  const { data: overview, isLoading } = useQuery({
    queryKey: ['fw-overview'],
    queryFn: () => firmwareApi.overview().then(r => r.data),
    refetchInterval: 30_000,
  });
  const { data: rollouts = [] } = useQuery({
    queryKey: ['fw-rollouts'],
    queryFn: () => firmwareApi.listRollouts().then(r => r.data),
    refetchInterval: 15_000,
  });

  const devices = overview?.devices ?? [];
  const updatable = devices.filter(d => d.firmware_update_available && d.status === 'online');
  const upToDate = devices.filter(d => !d.firmware_update_available && d.ros_version).length;
  const activeRolloutId = viewRolloutId ?? overview?.runningRolloutId ?? overview?.latestRolloutId ?? null;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['fw-overview'] });
    qc.invalidateQueries({ queryKey: ['fw-rollouts'] });
    // Firmware flags also drive the Devices page badges, dashboard insights,
    // and Security Center findings — keep those screens in sync too.
    qc.invalidateQueries({ queryKey: ['devices'] });
    qc.invalidateQueries({ queryKey: ['ops-insights'] });
    qc.invalidateQueries({ queryKey: ['security-fleet'] });
  };

  const checkAll = useMutation({
    mutationFn: () => firmwareApi.checkAll(),
    onSuccess: (r) => {
      const avail = r.data.results.filter(x => x.ok && x.available).length;
      const failed = r.data.results.filter(x => !x.ok).length;
      setCheckResult(`Checked ${r.data.results.length} device(s): ${avail} update(s) available${failed ? `, ${failed} unreachable` : ''}`);
      setTimeout(() => setCheckResult(null), 6000);
      invalidate();
    },
  });

  const createRollout = useMutation({
    mutationFn: () => firmwareApi.createRollout({
      name: rolloutName.trim() || `RouterOS upgrade ${new Date().toISOString().slice(0, 10)}`,
      halt_on_failure: haltOnFailure,
      pre_backup: preBackup,
      routerboot_after: routerbootAfter,
      scheduled_at: scheduleAt ? new Date(scheduleAt).toISOString() : null,
      start: !scheduleAt,
      devices: [...selected.entries()].map(([device_id, wave]) => ({ device_id, wave })),
    }),
    onSuccess: (r) => {
      setSelected(new Map());
      setViewRolloutId(r.data.id);
      invalidate();
    },
  });

  const toggleDevice = (id: number) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, next.size === 0 ? 1 : 2); // first pick becomes the canary
      return next;
    });
  };
  const setWave = (id: number, wave: number) => setSelected(prev => new Map(prev).set(id, wave));

  const selectedCount = selected.size;
  const waveSummary = useMemo(() => {
    const byWave = new Map<number, number>();
    for (const w of selected.values()) byWave.set(w, (byWave.get(w) ?? 0) + 1);
    return [...byWave.entries()].sort((a, b) => a[0] - b[0]).map(([w, n]) => `wave ${w}: ${n}`).join(' · ');
  }, [selected]);

  return (
    <div className="space-y-5">
      {changelogVersion && (
        <ChangelogModal version={changelogVersion} onClose={() => setChangelogVersion(null)} />
      )}
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Firmware</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            Staged RouterOS upgrades — canary first, wave by wave, with pre-backups and health verification
          </p>
        </div>
        <div className="flex items-center gap-2">
          {checkResult && <span className="text-xs text-green-600 dark:text-green-400">{checkResult}</span>}
          {canWrite && (
            <button className="btn-secondary flex items-center gap-2" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              <RefreshCw className={clsx('w-4 h-4', checkAll.isPending && 'animate-spin')} />
              {checkAll.isPending ? 'Checking fleet…' : 'Check all for updates'}
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="card p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-green-50 dark:bg-green-900/20"><CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" /></div>
          <div><div className="text-2xl font-bold text-gray-900 dark:text-white">{upToDate}</div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Up to date</div></div>
        </div>
        <div className="card p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20"><ArrowUpCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" /></div>
          <div><div className="text-2xl font-bold text-gray-900 dark:text-white">{devices.filter(d => d.firmware_update_available).length}</div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Updates available</div></div>
        </div>
        <div className="card p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20"><Rocket className="w-5 h-5 text-blue-600 dark:text-blue-400" /></div>
          <div><div className="text-2xl font-bold text-gray-900 dark:text-white">{overview?.runningRolloutId ? 'Running' : '—'}</div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Active rollout</div></div>
        </div>
      </div>

      {/* Fleet table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Fleet versions</h3>
          {canWrite && updatable.length > 0 && (
            <button className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setSelected(new Map(updatable.map((d, i) => [d.id, i === 0 ? 1 : 2])))}>
              Select all updatable ({updatable.length})
            </button>
          )}
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                  {canWrite && <th className="px-4 py-2.5 w-8" />}
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Device</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Model</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">RouterOS</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Latest</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">RouterBOOT</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Status</th>
                  {canWrite && <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Wave</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
                {devices.map((d, i) => {
                  const isSel = selected.has(d.id);
                  const selectable = canWrite && d.firmware_update_available && d.status === 'online';
                  return (
                    <tr key={d.id} className={clsx('transition-colors', isSel ? 'bg-blue-50/60 dark:bg-blue-900/10' : i % 2 === 0 ? 'bg-white dark:bg-slate-900/20' : 'bg-gray-50 dark:bg-slate-800/40')}>
                      {canWrite && (
                        <td className="px-4 py-2.5">
                          <input type="checkbox" className="w-4 h-4 rounded" checked={isSel} disabled={!selectable}
                            onChange={() => toggleDevice(d.id)} />
                        </td>
                      )}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <TypePill type={d.device_type} />
                          <span className="font-medium text-gray-900 dark:text-white">{d.name}</span>
                          {d.status !== 'online' && <span className="text-[10px] text-red-400">offline</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">{d.model || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-700 dark:text-slate-300">{d.ros_version || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {d.latest_ros_version ? (
                          <button
                            onClick={() => setChangelogVersion(d.latest_ros_version)}
                            className="text-blue-600 dark:text-blue-400 hover:underline"
                            title={`View MikroTik's release notes for ${d.latest_ros_version}`}
                          >
                            {d.latest_ros_version}
                          </button>
                        ) : (
                          <span className="text-gray-500 dark:text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {d.routerboard_upgrade_available
                          ? <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-mono">{d.firmware_version} → {d.upgrade_firmware_version}</span>
                          : <span className="font-mono text-gray-400 dark:text-slate-500">{d.firmware_version || '—'}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {d.firmware_update_available
                          ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">Update available</span>
                          : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Up to date</span>}
                      </td>
                      {canWrite && (
                        <td className="px-4 py-2.5">
                          {isSel && (
                            <select className="input py-0.5 text-xs w-auto" value={selected.get(d.id)}
                              onChange={e => setWave(d.id, parseInt(e.target.value, 10))}>
                              {[1, 2, 3].map(w => <option key={w} value={w}>{w === 1 ? '1 — canary' : String(w)}</option>)}
                            </select>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Rollout builder bar */}
        {canWrite && selectedCount > 0 && (
          <div className="px-5 py-4 border-t border-gray-200 dark:border-slate-700 bg-blue-50/40 dark:bg-blue-900/10 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input className="input w-64" placeholder={`RouterOS upgrade ${new Date().toISOString().slice(0, 10)}`}
                value={rolloutName} onChange={e => setRolloutName(e.target.value)} />
              <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 rounded" checked={preBackup} onChange={e => setPreBackup(e.target.checked)} />
                Pre-upgrade backup
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 rounded" checked={haltOnFailure} onChange={e => setHaltOnFailure(e.target.checked)} />
                Halt on failure
              </label>
              <label
                className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300 cursor-pointer"
                title="After each RouterOS upgrade verifies, apply any pending RouterBOOT upgrade. This is a second flash and a second reboot per device."
              >
                <input type="checkbox" className="w-4 h-4 rounded" checked={routerbootAfter} onChange={e => setRouterbootAfter(e.target.checked)} />
                Then RouterBOOT
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300">
                <Clock className="w-4 h-4 text-gray-400" />
                <input type="datetime-local" className="input py-1 text-xs w-auto" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button className="btn-primary flex items-center gap-2" disabled={createRollout.isPending}
                onClick={() => createRollout.mutate()}>
                {createRollout.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                {scheduleAt ? 'Schedule rollout' : 'Start rollout now'} ({selectedCount} device{selectedCount !== 1 ? 's' : ''})
              </button>
              <span className="text-xs text-gray-500 dark:text-slate-400">{waveSummary}</span>
              {createRollout.isError && (
                <span className="text-xs text-red-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {(createRollout.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to create rollout'}
                </span>
              )}
              {scheduleAt && (
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  Tip: schedule inside a maintenance window to avoid disrupting users.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Latest / running rollout */}
      {activeRolloutId && <RolloutPanel rolloutId={activeRolloutId} canWrite={canWrite} />}

      {/* Past rollouts */}
      {rollouts.length > 1 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">History</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/50">
            {rollouts.map(r => (
              <button key={r.id} onClick={() => setViewRolloutId(r.id)}
                className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium capitalize flex-shrink-0', ROLLOUT_STATUS[r.status])}>{r.status}</span>
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</span>
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  {r.success_count}/{r.device_count} succeeded{(r.failed_count ?? 0) > 0 ? ` · ${r.failed_count} failed` : ''}
                </span>
                <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500 flex-shrink-0">
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
