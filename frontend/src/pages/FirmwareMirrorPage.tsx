import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, HardDrive, RefreshCw, Trash2, Server, AlertTriangle, CheckCircle, Settings2, Plus } from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import {
  mirrorApi, devicesApi, sitesApi,
  type FirmwareMirror, type MirrorDevice, type MirrorClientResult, type MirrorDisk,
} from '../services/api';
import { useAuthStore } from '../store/authStore';

const STATUS_STYLE: Record<FirmwareMirror['status'], string> = {
  new: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
  deployed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  syncing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  ready: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};
const STATUS_LABEL: Record<FirmwareMirror['status'], string> = {
  new: 'Not set up', deployed: 'Set up, not synced', syncing: 'Syncing…', ready: 'Ready', error: 'Needs attention',
};

function mb(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1048576)} MB`;
}
/**
 * Where on the package server the packages go (Discussion #85): internal
 * storage or a mounted disk such as an SD card. `value` undefined means "not
 * chosen yet", and the suggestion (most free space, never a RAM disk) is taken.
 */
function DiskPicker({ deviceId, value, onChange }: {
  deviceId: number; value: string | null | undefined; onChange: (disk: string | null) => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['fw-mirror-disks', deviceId],
    queryFn: () => mirrorApi.disks(deviceId).then((r) => r.data),
    staleTime: 60_000,
  });
  const disks: MirrorDisk[] = data?.disks ?? [];
  const current = value === undefined ? data?.suggested ?? null : value;
  useEffect(() => {
    if (value === undefined && data) onChange(data.suggested ?? null);
  }, [value, data, onChange]);
  const chosen = disks.find((d) => d.mount_point === current);
  return (
    <label className="space-y-1">
      <span className="text-xs text-gray-500 dark:text-slate-400">Store packages on</span>
      <select className="input w-full" value={current ?? ''} disabled={isLoading || isError}
        onChange={(e) => onChange(e.target.value || null)}>
        {isLoading && <option value="">Reading disks…</option>}
        {isError && <option value="">Internal storage (couldn’t read its disks)</option>}
        {disks.map((d) => (
          <option key={d.mount_point ?? ''} value={d.mount_point ?? ''}>
            {d.label}: {mb(d.free_bytes)} free of {mb(d.size_bytes)}{d.ram ? ' (emptied on every reboot)' : ''}
          </option>
        ))}
      </select>
      {chosen?.ram && (
        <span className="block text-xs text-amber-600 dark:text-amber-400">
          A RAM disk loses its contents on every reboot; the mirror would need a sync after each one.
        </span>
      )}
      {data && disks.length === 1 && (
        <span className="block text-xs text-gray-500 dark:text-slate-400">
          No SD card, USB or other disk on this router; packages go on its internal storage.
        </span>
      )}
    </label>
  );
}

const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

/** RouterOS 7.17 or later: local-update, the client side, needs it. */
function canServe(v?: string | null): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v || '');
  return !!m && Number(m[1]) === 7 && Number(m[2]) >= 17;
}

/**
 * Local firmware mirror (#193): a router the manager keeps stocked with the
 * RouterOS packages the fleet runs, which devices pull from instead of each
 * downloading from MikroTik.
 */
export default function FirmwareMirrorPage() {
  const user = useAuthStore((st) => st.user);
  const siteRoles = (user as { siteRoles?: Record<string, string> } | null)?.siteRoles;
  const fleetAdmin = user?.role === 'admin' && !siteRoles;
  const adminSites = siteRoles ? Object.entries(siteRoles).filter(([, r]) => r === 'admin').map(([id]) => Number(id)) : [];
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['fw-mirrors'],
    queryFn: () => mirrorApi.list().then((r) => r.data),
    // Faster while a sync runs, so its progress shows.
    refetchInterval: (q) => (q.state.data?.mirrors.some((m) => m.status === 'syncing') ? 4_000 : 30_000),
  });
  const mirrors = data?.mirrors ?? [];
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 300_000 });
  const takenSites = new Set(mirrors.map((m) => m.site?.id ?? 0));
  const siteChoices = (fleetAdmin ? sites : sites.filter((s) => adminSites.includes(s.id))).filter((s) => !takenSites.has(s.id));
  const canAddFleet = fleetAdmin && !takenSites.has(0);
  const canAdd = canAddFleet || siteChoices.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link to="/firmware" className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Firmware
          </Link>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Package mirror</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            Devices pull RouterOS packages from a router you choose, instead of each downloading them from MikroTik
          </p>
        </div>
        {canAdd && mirrors.length > 0 && !adding && (
          <button className="btn-secondary flex items-center gap-2" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4" /> {canAddFleet ? 'Set up the fleet mirror' : 'Add a mirror for a site'}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="card p-8 text-center text-sm text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
      ) : (
        <>
          {(mirrors.length === 0 || adding) && (
            canAdd ? (
              <SetupCard
                canAddFleet={canAddFleet}
                siteChoices={siteChoices}
                onDone={() => setAdding(false)}
                onCancel={mirrors.length > 0 ? () => setAdding(false) : undefined}
              />
            ) : mirrors.length === 0 ? (
              <div className="card p-6 text-sm text-gray-500 dark:text-slate-400">
                No package mirror is set up. An administrator can set one up here.
              </div>
            ) : null
          )}
          {mirrors.map((m) => <MirrorCard key={m.id} mirror={m} />)}
        </>
      )}
    </div>
  );
}

function SetupCard({ canAddFleet, siteChoices, onDone, onCancel }: {
  canAddFleet: boolean;
  siteChoices: { id: number; name: string }[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [siteId, setSiteId] = useState<number | null>(canAddFleet ? null : siteChoices[0]?.id ?? null);
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [folder, setFolder] = useState('mtm-packages');
  // undefined until the server's disks are read; the picker then fills in the suggestion.
  const [disk, setDisk] = useState<string | null | undefined>(undefined);
  const [serveAddress, setServeAddress] = useState('');
  const [keep, setKeep] = useState(3);
  const [autoSync, setAutoSync] = useState(true);
  const [channel, setChannel] = useState<'stable' | 'long-term'>('stable');
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list().then((r) => r.data), staleTime: 60_000 });
  const candidates = devices
    .filter((d) => siteId == null || d.site_id === siteId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = devices.find((d) => d.id === deviceId);

  const create = useMutation({
    meta: { inlineError: true },
    mutationFn: () => mirrorApi.create({
      device_id: Number(deviceId), site_id: siteId, folder: folder.trim(), disk: disk ?? null,
      serve_address: serveAddress.trim() || null, keep_versions: keep, auto_sync: autoSync, channel,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fw-mirrors'] }); onDone(); },
  });

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20"><Server className="w-5 h-5 text-blue-600 dark:text-blue-400" /></div>
        <div className="text-sm text-gray-600 dark:text-slate-300 space-y-1">
          <p className="font-semibold text-gray-900 dark:text-white">Set up a package server</p>
          <p>
            Pick a router to hold the packages. The manager fetches each RouterOS release once from MikroTik, checks it against
            MikroTik&apos;s checksum, and keeps this router stocked with only the architectures and packages your devices run.
            Devices on RouterOS 7.17 or later then pull from it during a rollout.
          </p>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            It creates a login named <span className="font-mono">mtm-mirror</span> on that router, in a group of its own that can read
            files but not change anything. Because that login can read every file on the router, use a router that holds nothing
            sensitive. Packages go in a folder, never the top level, so the router never installs them itself. It needs room for every
            architecture you run: a CHR, a router with real storage, or one with an SD card or USB stick (choose it under
            Store packages on).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Serves</span>
          <select className="input w-full" value={siteId ?? ''} onChange={(e) => { setSiteId(e.target.value ? Number(e.target.value) : null); setDeviceId(''); }}>
            {canAddFleet && <option value="">The whole fleet</option>}
            {siteChoices.map((s) => <option key={s.id} value={s.id}>Site: {s.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Package server</span>
          <select className="input w-full" value={deviceId} onChange={(e) => { setDeviceId(e.target.value ? Number(e.target.value) : ''); setDisk(undefined); }}>
            <option value="">Choose a router…</option>
            {candidates.map((d) => (
              <option key={d.id} value={d.id} disabled={!canServe(d.ros_version)}>
                {d.name.trim()} ({d.ip_address}){canServe(d.ros_version) ? '' : ` — RouterOS ${d.ros_version || '?'} is too old`}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Address devices reach it on</span>
          <input className="input w-full" value={serveAddress} onChange={(e) => setServeAddress(e.target.value)}
            placeholder={chosen ? `${chosen.ip_address} (its management address)` : 'Its management address'} />
        </label>
        {deviceId !== '' && <DiskPicker deviceId={Number(deviceId)} value={disk} onChange={setDisk} />}
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Folder on the router</span>
          <input className="input w-full font-mono" value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Versions kept</span>
          <select className="input w-full" value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 3 ? ' (default)' : ''}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Release channel</span>
          <select className="input w-full" value={channel} onChange={(e) => setChannel(e.target.value as 'stable' | 'long-term')}>
            <option value="stable">Stable</option>
            <option value="long-term">Long-term</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
        <input type="checkbox" className="w-4 h-4 rounded" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
        Fetch new releases automatically (checked every 6 hours)
      </label>

      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!deviceId || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Setting up…' : 'Set up package server'}
        </button>
        {onCancel && <button className="btn-secondary" onClick={onCancel}>Cancel</button>}
        {create.isError && (
          <span className="text-xs text-red-500 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />{errText(create.error, 'Setup failed')}
          </span>
        )}
      </div>
    </div>
  );
}

function MirrorCard({ mirror: m }: { mirror: FirmwareMirror }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['fw-mirrors'] });
    qc.invalidateQueries({ queryKey: ['fw-mirror-devices', m.id] });
    qc.invalidateQueries({ queryKey: ['fw-overview'] });
  };

  const sync = useMutation({ meta: { inlineError: true }, mutationFn: () => mirrorApi.sync(m.id), onSuccess: refresh });
  const remove = useMutation({
    meta: { inlineError: true },
    mutationFn: () => mirrorApi.remove(m.id),
    onSuccess: (r) => {
      if (r.data.notes.length) alert(`Mirror removed. A few things need a look:\n\n${r.data.notes.join('\n')}`);
      refresh();
    },
  });
  const usedPct = m.total_bytes ? Math.round(((m.total_bytes - (m.free_bytes ?? 0)) / m.total_bytes) * 100) : null;
  const lowSpace = m.free_bytes != null && m.free_bytes < 50 * 1048576;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
        <HardDrive className="w-4 h-4 text-gray-400" />
        <div>
          <div className="text-sm font-semibold text-gray-900 dark:text-white">
            {m.server?.name ?? 'Missing device'} <span className="font-normal text-gray-400 font-mono text-xs">{m.effective_address}</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-slate-400">
            {m.site ? `Site: ${m.site.name}` : 'Whole fleet'} · folder <span className="font-mono">{m.path}/</span> · keeps {m.keep_versions} version{m.keep_versions === 1 ? '' : 's'} ·{' '}
            {m.channel} · {m.auto_sync ? 'fetches new releases automatically' : 'synced by hand'}
          </div>
        </div>
        <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_STYLE[m.status])}>{STATUS_LABEL[m.status]}</span>
        {m.can_manage && (
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-primary flex items-center gap-2 text-sm" disabled={m.status === 'syncing' || sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw className={clsx('w-4 h-4', m.status === 'syncing' && 'animate-spin')} />
              {m.status === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn-secondary p-2" title="Settings" onClick={() => setEditing((v) => !v)}><Settings2 className="w-4 h-4" /></button>
            <button className="btn-secondary p-2" title="Remove the mirror" disabled={remove.isPending}
              onClick={() => {
                if (confirm(`Remove this mirror? Devices stop using it, and the packages, the mtm-mirror login and its group are removed from ${m.server?.name ?? 'the router'}.`)) remove.mutate();
              }}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div className="px-5 py-4 space-y-4">
        {(m.last_error || sync.isError || remove.isError) && (
          <div className="flex items-start gap-2 text-xs rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-3 py-2 text-red-700 dark:text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
            <span>{sync.isError ? errText(sync.error, 'Sync failed') : remove.isError ? errText(remove.error, 'Remove failed') : m.last_error}</span>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Last synced" value={m.last_sync_at ? formatDistanceToNow(new Date(m.last_sync_at), { addSuffix: true }) : 'Never'} />
          <Stat label="Packages held" value={`${mb(m.used_bytes)} · ${m.versions.length} version${m.versions.length === 1 ? '' : 's'}`} />
          <Stat label="Free on the router" value={mb(m.free_bytes)} warn={lowSpace}
            hint={usedPct != null ? `${usedPct}% of ${mb(m.total_bytes)} used` : undefined} />
          <Stat label="Devices using it" value={String(m.clients.filter((c) => c.status === 'ok').length)}
            hint={m.clients.some((c) => c.status === 'error') ? `${m.clients.filter((c) => c.status === 'error').length} need attention` : undefined} />
        </div>

        {editing && m.can_manage && <SettingsForm mirror={m} onDone={() => setEditing(false)} />}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-2">Versions</h3>
          {m.versions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-slate-400">Nothing yet. {m.can_manage ? 'Sync now fetches the latest release.' : ''}</p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700/50 rounded-lg border border-gray-200 dark:border-slate-700">
              {m.versions.map((v, i) => {
                const archs = [...new Set(v.files.map((f) => f.architecture))].sort();
                const pkgs = [...new Set(v.files.map((f) => f.package))].sort();
                return (
                  <div key={v.version}>
                    <button className="w-full px-3 py-2 flex flex-wrap items-center gap-3 text-left text-sm hover:bg-gray-50 dark:hover:bg-slate-700/40"
                      onClick={() => setOpenVersion(openVersion === v.version ? null : v.version)}>
                      <span className="font-mono font-semibold text-gray-900 dark:text-white w-16">{v.version}</span>
                      {i === 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">newest</span>}
                      <span className="text-xs text-gray-500 dark:text-slate-400">{v.files.length} files · {mb(v.total_bytes)}</span>
                      <span className="text-xs text-gray-500 dark:text-slate-400 font-mono">{archs.join(', ')}</span>
                      <span className="text-xs text-gray-400 dark:text-slate-500 truncate">{pkgs.join(', ')}</span>
                    </button>
                    {openVersion === v.version && (
                      <div className="px-3 pb-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 text-xs font-mono text-gray-600 dark:text-slate-400">
                        {v.files.map((f) => (
                          <div key={f.filename} className="flex justify-between gap-2 py-0.5">
                            <span className="truncate">{f.filename}</span><span className="text-gray-400">{mb(f.size_bytes)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <ClientDevices mirror={m} onChanged={refresh} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
      <div className="text-[11px] text-gray-500 dark:text-slate-400">{label}</div>
      <div className={clsx('text-sm font-semibold', warn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white')}>{value}</div>
      {hint && <div className="text-[11px] text-gray-400 dark:text-slate-500">{hint}</div>}
    </div>
  );
}

function SettingsForm({ mirror: m, onDone }: { mirror: FirmwareMirror; onDone: () => void }) {
  const qc = useQueryClient();
  const [serveAddress, setServeAddress] = useState(m.serve_address ?? '');
  const [keep, setKeep] = useState(m.keep_versions);
  const [autoSync, setAutoSync] = useState(m.auto_sync);
  const [channel, setChannel] = useState(m.channel);
  const [disk, setDisk] = useState<string | null>(m.disk);
  const moving = (disk ?? null) !== (m.disk ?? null);
  const [notes, setNotes] = useState<MirrorClientResult[] | null>(null);
  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => mirrorApi.update(m.id, {
      serve_address: serveAddress.trim() || null, keep_versions: keep, auto_sync: autoSync, channel,
      ...(moving ? { disk } : {}),
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['fw-mirrors'] });
      const failed = (r.data.clients ?? []).filter((c) => !c.ok);
      if (failed.length) setNotes(failed); else onDone();
    },
  });
  const redeploy = useMutation({
    meta: { inlineError: true },
    mutationFn: () => mirrorApi.deploy(m.id),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['fw-mirrors'] }); setNotes(r.data.clients.filter((c) => !c.ok)); },
  });
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
        <label className="space-y-1 md:col-span-2">
          <span className="text-xs text-gray-500 dark:text-slate-400">Address devices reach it on</span>
          <input className="input w-full" value={serveAddress} onChange={(e) => setServeAddress(e.target.value)}
            placeholder={`${m.server?.ip_address ?? ''} (its management address)`} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Versions kept</span>
          <select className="input w-full" value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400">Release channel</span>
          <select className="input w-full" value={channel} onChange={(e) => setChannel(e.target.value as 'stable' | 'long-term')}>
            <option value="stable">Stable</option>
            <option value="long-term">Long-term</option>
          </select>
        </label>
      </div>
      {m.server && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <DiskPicker deviceId={m.server.id} value={disk} onChange={setDisk} />
          {moving && (
            <p className="text-xs text-amber-600 dark:text-amber-400 self-end">
              Saving removes the packages from {m.disk ?? 'internal storage'}; the next sync puts them on {disk ?? 'internal storage'}.
              Devices keep using the same address.
            </p>
          )}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
        <input type="checkbox" className="w-4 h-4 rounded" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
        Fetch new releases automatically
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button className="btn-secondary text-sm" disabled={redeploy.isPending}
          title="Give the mtm-mirror login a new password and tell every device using the mirror"
          onClick={() => redeploy.mutate()}>{redeploy.isPending ? 'Working…' : 'New login password'}</button>
        <button className="text-sm text-gray-500 hover:underline" onClick={onDone}>Close</button>
        {(save.isError || redeploy.isError) && (
          <span className="text-xs text-red-500">{errText(save.error ?? redeploy.error, 'That didn’t work')}</span>
        )}
      </div>
      {notes && notes.length > 0 && (
        <div className="text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
          <p>These devices couldn&apos;t be updated:</p>
          {notes.map((n) => <p key={n.device_id}>{n.name}: {n.message}</p>)}
        </div>
      )}
    </div>
  );
}

function ClientDevices({ mirror: m, onChanged }: { mirror: FirmwareMirror; onChanged: () => void }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<MirrorClientResult[] | null>(null);
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fw-mirror-devices', m.id],
    queryFn: () => mirrorApi.devices(m.id).then((r) => r.data),
  });
  const change = useMutation({
    meta: { inlineError: true },
    mutationFn: (enable: boolean) => mirrorApi.setClients(m.id, [...picked], enable),
    onSuccess: (r) => { setResults(r.data.results); setPicked(new Set()); onChanged(); },
  });
  const selectable = (d: MirrorDevice) => d.supported && !d.is_server;
  const eligible = useMemo(() => devices.filter(selectable), [devices]);
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const stateOf = (d: MirrorDevice): { text: string; tone: 'ok' | 'warn' | 'muted' | 'err' } => {
    if (d.is_server) return { text: 'Package server', tone: 'muted' };
    if (!d.supported) return { text: `RouterOS ${d.ros_version || '?'}: needs 7.17`, tone: 'muted' };
    if (d.client?.this_mirror) return d.client.status === 'ok' ? { text: 'Uses this mirror', tone: 'ok' } : { text: d.client.error || 'Couldn’t be set up', tone: 'err' };
    if (d.client) return { text: 'Uses another mirror', tone: 'warn' };
    return { text: 'Downloads from MikroTik', tone: 'muted' };
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Devices</h3>
        {m.can_manage && (
          <div className="ml-auto flex items-center gap-2">
            <button className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setPicked(new Set(eligible.map((d) => d.id)))}>Select all eligible ({eligible.length})</button>
            <button className="btn-primary text-xs py-1" disabled={!picked.size || change.isPending}
              onClick={() => change.mutate(true)}>
              Use this mirror{picked.size ? ` (${picked.size})` : ''}
            </button>
            <button className="btn-secondary text-xs py-1" disabled={!picked.size || change.isPending} onClick={() => change.mutate(false)}>
              Stop using it
            </button>
          </div>
        )}
      </div>
      {results && (
        <div className="mb-2 text-xs space-y-0.5">
          {results.map((r) => (
            <p key={r.device_id} className={r.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
              {r.ok ? <CheckCircle className="w-3 h-3 inline mr-1" /> : <AlertTriangle className="w-3 h-3 inline mr-1" />}
              {r.name}: {r.message}
            </p>
          ))}
        </div>
      )}
      {change.isError && <p className="mb-2 text-xs text-red-500">{errText(change.error, 'That didn’t work')}</p>}
      {isLoading ? (
        <p className="text-sm text-gray-400">Loading devices…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                {m.can_manage && <th className="table-header px-3 py-2 w-8" />}
                <th className="table-header px-3 py-2">Device</th>
                <th className="table-header px-3 py-2">RouterOS</th>
                <th className="table-header px-3 py-2">Architecture</th>
                <th className="table-header px-3 py-2">Packages</th>
                <th className="table-header px-3 py-2">Updates from</th>
              </tr>
            </thead>
            <tbody className="table-zebra">
              {devices.map((d) => {
                const st = stateOf(d);
                return (
                  <tr key={d.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                    {m.can_manage && (
                      <td className="px-3 py-2">
                        <input type="checkbox" className="w-4 h-4 rounded" disabled={!selectable(d)} checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2 cell-primary">{d.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{d.ros_version || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{d.architecture || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">{d.packages.join(', ') || '—'}</td>
                    <td className={clsx('px-3 py-2 text-xs', {
                      'text-green-700 dark:text-green-400': st.tone === 'ok',
                      'text-amber-700 dark:text-amber-400': st.tone === 'warn',
                      'text-red-600 dark:text-red-400': st.tone === 'err',
                      'text-gray-500 dark:text-slate-400': st.tone === 'muted',
                    })}>{st.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
