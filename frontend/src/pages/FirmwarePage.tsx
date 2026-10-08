import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle, RefreshCw, CheckCircle, AlertTriangle, Clock, ShieldAlert, Rocket, Zap, HardDrive,
} from 'lucide-react';
import clsx from 'clsx';
import { firmwareApi, commandTemplatesApi } from '../services/api';
import UpdateChannelCard from '../components/firmware/UpdateChannelCard';
import { useCanWrite } from '../hooks/useCanWrite';
import { formatDistanceToNow } from 'date-fns';
import ChangelogModal from '../components/ChangelogModal';
import DeviceTypePill from '../components/devices/DeviceTypePill';
import TagChips from '../components/devices/TagChips';
import RolloutPanel from '../components/firmware/RolloutPanel';
import { ROLLOUT_STATUS } from '../components/firmware/rolloutStatus';

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
  // A command template to run on each device after its upgrade (#163).
  const [postTemplateId, setPostTemplateId] = useState<number | ''>('');
  const { data: templates = [] } = useQuery({
    queryKey: ['command-templates'],
    queryFn: () => commandTemplatesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  // 1 = sequential, the long-standing behaviour. Raising it trades canary
  // strictness for wall-clock time, which is the operator's call (#135).
  const [waveConcurrency, setWaveConcurrency] = useState(1);
  /** Where devices set up for the local mirror get their packages (#193). */
  const [packageSource, setPackageSource] = useState<'mirror' | 'mikrotik'>('mirror');
  const [scheduleAt, setScheduleAt] = useState('');
  /** Latest start; empty means up to an hour after scheduleAt. */
  const [scheduleUntil, setScheduleUntil] = useState('');
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
  // An update from MikroTik, or a newer version on the device's local mirror (#193).
  const hasUpdate = (d: (typeof devices)[number]) => d.firmware_update_available || !!d.mirror_update_available;
  const updatable = devices.filter(d => hasUpdate(d) && d.status === 'online');
  const upToDate = devices.filter(d => !hasUpdate(d) && d.ros_version).length;
  // Up-to-date devices (nothing for RouterOS or RouterBOOT) are hidden by
  // default (#204): on a big fleet they were most of the table, greyed out.
  const isCurrent = (d: (typeof devices)[number]) => !!d.ros_version && !hasUpdate(d) && !d.routerboard_upgrade_available;
  const [showCurrent, setShowCurrentState] = useState(() => {
    try { return localStorage.getItem('firmware.showUpToDate') === '1'; } catch { return false; }
  });
  const setShowCurrent = (v: boolean) => {
    setShowCurrentState(v);
    try { localStorage.setItem('firmware.showUpToDate', v ? '1' : '0'); } catch { /* private mode */ }
  };
  const currentCount = devices.filter(isCurrent).length;
  const tableDevices = showCurrent ? devices : devices.filter(d => !isCurrent(d));
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
    meta: { inlineError: true },
    mutationFn: () => firmwareApi.createRollout({
      name: rolloutName.trim() || `RouterOS upgrade ${new Date().toISOString().slice(0, 10)}`,
      halt_on_failure: haltOnFailure,
      pre_backup: preBackup,
      routerboot_after: routerbootAfter,
      post_template_id: postTemplateId === '' ? null : postTemplateId,
      wave_concurrency: waveConcurrency,
      package_source: packageSource,
      scheduled_at: scheduleAt ? new Date(scheduleAt).toISOString() : null,
      scheduled_until: scheduleAt && scheduleUntil ? new Date(scheduleUntil).toISOString() : null,
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
  /** The server rejects anything outside 1-9 (routes/firmware.ts). */
  const MAX_WAVE = 9;
  const setWave = (id: number, wave: number) => setSelected(prev => new Map(prev).set(id, wave));

  // Tags with at least one device that can be upgraded right now.
  const tagsInUse = (() => {
    const m = new Map<number, { id: number; name: string; color: string; count: number }>();
    for (const d of updatable) for (const t of d.tags ?? []) {
      const e = m.get(t.id) ?? { ...t, count: 0 };
      e.count++;
      m.set(t.id, e);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  const addTagAsWave = (tagId: number) => setSelected(prev => {
    const next = new Map(prev);
    const wave = prev.size ? Math.min(MAX_WAVE, Math.max(...prev.values()) + 1) : 1;
    for (const d of updatable) {
      // Devices already chosen keep the wave they were given.
      if (!next.has(d.id) && d.tags?.some(t => t.id === tagId)) next.set(d.id, wave);
    }
    return next;
  });

  const selectedCount = selected.size;
  const mirrorSelected = devices.filter(d => selected.has(d.id) && d.mirror?.status === 'ok').length;
  // Advisory only: which selected devices other selected devices reach the
  // network through. Discovered topology is incomplete, so this warns rather
  // than blocks (#135).
  const selectedIds = useMemo(() => [...selected.keys()].sort((a, b) => a - b), [selected]);
  const { data: upstreamCheck } = useQuery({
    queryKey: ['fw-upstream', selectedIds],
    queryFn: () => firmwareApi.upstreamCheck(selectedIds).then(r => r.data),
    enabled: waveConcurrency > 1 && selectedIds.length > 1,
  });
  const upstreamWarning = upstreamCheck?.upstream ?? [];

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
          <Link to="/firmware/mirror" className="btn-secondary flex items-center gap-2" title="Serve RouterOS packages to the fleet from a router you choose">
            <HardDrive className="w-4 h-4" /> Package mirror
          </Link>
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
          <div><div className="text-2xl font-bold text-gray-900 dark:text-white">{devices.filter(hasUpdate).length}</div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Updates available</div></div>
        </div>
        <div className="card p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20"><Rocket className="w-5 h-5 text-blue-600 dark:text-blue-400" /></div>
          <div><div className="text-2xl font-bold text-gray-900 dark:text-white">{overview?.runningRolloutId ? 'Running' : '—'}</div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Active rollout</div></div>
        </div>
      </div>

      <UpdateChannelCard devices={devices} canWrite={canWrite} />

      {/* Fleet table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Fleet versions</h3>
          {currentCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={showCurrent} onChange={(e) => setShowCurrent(e.target.checked)}
                className="rounded border-gray-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500" />
              Show up-to-date ({currentCount})
            </label>
          )}
          {canWrite && updatable.length > 0 && (
            <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
              {/* Tags work as groups here (#161). Each click adds that tag's
                  updatable devices as the next wave, so "canary" then
                  "production" gives a canary wave followed by the rest. */}
              {tagsInUse.map(t => (
                <button
                  key={t.id}
                  onClick={() => addTagAsWave(t.id)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                  style={{ background: `${t.color}22`, color: t.color }}
                  title={`Add the ${t.count} updatable device${t.count === 1 ? '' : 's'} tagged ${t.name} as the next wave`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />
                  {t.name} ({t.count})
                </button>
              ))}
              <button className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                onClick={() => setSelected(new Map(updatable.map((d, i) => [d.id, i === 0 ? 1 : 2])))}>
                Select all updatable ({updatable.length})
              </button>
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                  {canWrite && <th className="table-header px-4 py-[10px] w-8" />}
                  <th className="table-header px-4 py-[10px]">Device</th>
                  <th className="table-header px-4 py-[10px] w-[72px]">Type</th>
                  <th className="table-header px-4 py-[10px]">Model</th>
                  <th className="table-header px-4 py-[10px]">RouterOS</th>
                  <th className="table-header px-4 py-[10px]">Latest</th>
                  <th className="table-header px-4 py-[10px]">RouterBOOT</th>
                  <th className="table-header px-4 py-[10px]">Status</th>
                  {canWrite && <th className="table-header px-4 py-[10px]">Wave</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
                {tableDevices.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-6 text-center text-sm text-gray-400 dark:text-slate-500">
                    All {currentCount} device{currentCount === 1 ? ' is' : 's are'} up to date.
                  </td></tr>
                )}
                {tableDevices.map((d) => {
                  const isSel = selected.has(d.id);
                  const selectable = canWrite && hasUpdate(d) && d.status === 'online';
                  // Zebra striping comes from index.css, as it does on /devices.
                  // This table hand-rolled its own and so looked subtly
                  // different from the main one (#152).
                  return (
                    <tr key={d.id} className="transition-colors" style={isSel ? { background: 'var(--accent-soft)' } : undefined}>
                      {canWrite && (
                        <td className="px-4 py-2.5">
                          <input type="checkbox" className="w-4 h-4 rounded" checked={isSel} disabled={!selectable}
                            onChange={() => toggleDevice(d.id)} />
                        </td>
                      )}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="cell-primary">{d.name}</span>
                          <TagChips tags={d.tags} />
                          {d.status !== 'online' && <span className="text-[10px] text-red-400">offline</span>}
                        </div>
                      </td>
                      {/* Its own column after the name, as on Devices (#220). */}
                      <td className="px-4 py-2.5"><DeviceTypePill type={d.device_type} /></td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">{d.model || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-700 dark:text-slate-300">{d.ros_version || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {d.mirror_version && (
                          <div className="text-[11px] text-gray-500 dark:text-slate-400" title="The newest version on this device's local mirror">
                            <HardDrive className="w-3 h-3 inline mr-1" />{d.mirror_version}
                          </div>
                        )}
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
                        {hasUpdate(d)
                          ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">Update available</span>
                          : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Up to date</span>}
                      </td>
                      {canWrite && (
                        <td className="px-4 py-2.5">
                          {isSel && (
                            <select className="input py-0.5 text-xs w-auto" value={selected.get(d.id)}
                              onChange={e => setWave(d.id, parseInt(e.target.value, 10))}>
                              {/* 1-9, matching what the server accepts. Offering only 1-3
                                  meant a device placed in wave 4 displayed as "1 — canary". */}
                              {Array.from({ length: MAX_WAVE }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w === 1 ? '1 — canary' : String(w)}</option>)}
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
              <label
                className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300"
                title="Run a command template on each device once its upgrade is verified, over SSH and under Change Guard. Not on devices that didn't upgrade. If it fails, the upgrade stands but halt-on-failure applies."
              >
                Then run
                <select className="input py-1 text-xs w-auto max-w-[14rem]" value={postTemplateId}
                  onChange={(e) => setPostTemplateId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">nothing</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label
                className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300"
                title="How many devices in the same wave may upgrade at once. 1 upgrades them one at a time."
              >
                <Zap className="w-4 h-4 text-gray-400" />
                At once
                <select
                  className="input py-1 text-xs w-auto"
                  value={waveConcurrency}
                  onChange={e => setWaveConcurrency(parseInt(e.target.value, 10))}
                >
                  {[1, 2, 3, 5, 8, 10].map(n => (
                    <option key={n} value={n}>{n === 1 ? '1 — one at a time' : n}</option>
                  ))}
                </select>
              </label>
              {mirrorSelected > 0 && (
                <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300"
                  title="Devices set up for the local mirror pull their packages from it. Others always download from MikroTik.">
                  <HardDrive className="w-4 h-4 text-gray-400" />
                  Packages from
                  <select className="input py-1 text-xs w-auto" value={packageSource}
                    onChange={e => setPackageSource(e.target.value as 'mirror' | 'mikrotik')}>
                    <option value="mirror">Local mirror</option>
                    <option value="mikrotik">MikroTik</option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300">
                <Clock className="w-4 h-4 text-gray-400" />
                <input type="datetime-local" className="input py-1 text-xs w-auto" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
              </label>
              {scheduleAt && (
                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-400"
                       title="If the manager can't start it by then (it was down, or another rollout ran long), the rollout is marked missed instead of starting late.">
                  Don&apos;t start after
                  <input type="datetime-local" className="input py-1 text-xs w-auto" value={scheduleUntil}
                         min={scheduleAt} onChange={e => setScheduleUntil(e.target.value)} />
                  {!scheduleUntil && <span className="text-gray-400">(1 hour later if blank)</span>}
                </label>
              )}
            </div>

            {mirrorSelected > 0 && packageSource === 'mirror' && mirrorSelected < selectedCount && (
              <p className="text-xs text-gray-500 dark:text-slate-400">
                {mirrorSelected} of {selectedCount} selected devices pull from the local mirror; the rest download from MikroTik.
              </p>
            )}
            {waveConcurrency > 1 && (
              <div className="flex items-start gap-2 text-xs rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-3 py-2 text-amber-800 dark:text-amber-300">
                <ShieldAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                <div className="space-y-1">
                  <p>
                    Up to {waveConcurrency} devices in a wave will reboot at the same time, and a
                    failure stops the rollout at the <em>end</em> of the wave — so up to{' '}
                    {waveConcurrency} devices can take a bad build before it halts.
                  </p>
                  {upstreamWarning.length > 0 && (
                    <p>
                      <span className="font-semibold">
                        {upstreamWarning.map(u => u.name).join(', ')}
                      </span>{' '}
                      {upstreamWarning.length === 1 ? 'carries' : 'carry'} traffic for other selected
                      devices. Rebooting {upstreamWarning.length === 1 ? 'it' : 'them'} alongside those
                      devices can cut the path to them mid-upgrade. Consider putting{' '}
                      {upstreamWarning.length === 1 ? 'it' : 'them'} in a later wave.
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <button className="btn-primary flex items-center gap-2" disabled={createRollout.isPending}
                onClick={() => {
                  // Upgrades and reboots devices, so it asks first (U10).
                  if (!scheduleAt && !confirm(`Start upgrading ${selectedCount} device${selectedCount !== 1 ? 's' : ''} now? Each one reboots.`)) return;
                  createRollout.mutate();
                }}>
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

      {/* Past rollouts: the latest few here, everything on its own page (#202). */}
      {rollouts.length > 1 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">History</h3>
            <Link to="/firmware/history" className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">
              All upgrade history
            </Link>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/50">
            {rollouts.slice(0, 5).map(r => (
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
