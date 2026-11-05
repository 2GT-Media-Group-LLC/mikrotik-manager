import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { HardDriveDownload, RefreshCw, AlertTriangle, Plus, Pencil, Trash2, Power, X, Check, Download, PackagePlus, PackageMinus, Lock } from 'lucide-react';
import clsx from 'clsx';
import { netinstallApi, type NetinstallDeviceView, type NetinstallFleetDevice, type RosRow } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { useGuardedWrite, GuardedWriteUi } from '../components/ChangeGuardDialog';
import ReviewChangesButton from '../components/common/ReviewChangesButton';
import DeviceTypePill from '../components/devices/DeviceTypePill';
import { apiErrorMessage } from '../utils/apiError';
import {
  ARCHES, KNOWN_EXTRA_PACKAGES, entryErrors, entryBody, entryForm, cacheDirectoryError, versionError, packagesError,
  normalizeMac, formatMb, type EntryForm,
} from '../utils/netinstall';

const yes = (v: string | undefined) => v === 'true';
const label = 'block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1';
const fieldError = (msg?: string) => msg ? <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{msg}</p> : null;

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className={clsx('bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-h-[90vh] overflow-y-auto', wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, children, disabled }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm text-gray-700 dark:text-slate-200', disabled && 'opacity-50')}>
      <input type="checkbox" className="mt-0.5" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function PackagePicker({ value, onChange, known }: { value: string[]; onChange: (v: string[]) => void; known: string[] }) {
  const options = [...new Set([...KNOWN_EXTRA_PACKAGES, ...known.filter((k) => k !== 'routeros')])].sort();
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((p) => {
        const on = value.includes(p);
        return (
          <button key={p} type="button" onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
            className={clsx('px-2 py-0.5 rounded-full text-xs border', on
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400')}>
            {p}
          </button>
        );
      })}
    </div>
  );
}

// ─── Server entry form ───────────────────────────────────────────────────────

function EntryModal({ view, existing, onClose }: { view: NetinstallDeviceView; existing?: RosRow; onClose: () => void }) {
  const qc = useQueryClient();
  const deviceId = view.device.id;
  const [f, setF] = useState<EntryForm>(() => entryForm(existing));
  const set = <K extends keyof EntryForm>(k: K, v: EntryForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const errors = entryErrors(f, { interfaces: view.interfaces, packages: view.packages, hadMac: !!existing?.['mac-address'], hadRange: !!existing?.['ip-range'] });
  const valid = Object.keys(errors).length === 0;
  const request = () => existing ? netinstallApi.updateEntry(deviceId, existing['.id'], entryBody(f, true)) : netinstallApi.addEntry(deviceId, entryBody(f));
  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: request,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['netinstall-device', deviceId] }); onClose(); },
  });

  return (
    <Modal title={`${existing ? 'Edit' : 'Add'} Netinstall entry on ${view.device.name}`} onClose={onClose} wide>
      <div className="p-5 space-y-4">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          A device on the chosen interface that etherboots is reinstalled from here, and its storage erased. The entry has to name that
          device&apos;s MAC address, or wait for each install to be started from this page.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>Interface *</label>
            <select className="input w-full" value={f.interface} onChange={(e) => set('interface', e.target.value)}>
              <option value="">Choose…</option>
              {view.interfaces.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
            {fieldError(errors.interface)}
          </div>
          <div>
            <label className={label}>MAC address of the device to install</label>
            <input className="input w-full font-mono" value={f.mac} onChange={(e) => set('mac', e.target.value)} placeholder="01:23:45:67:89:AB"
              disabled={!!existing?.['mac-address']} />
            {fieldError(errors.mac)}
          </div>
          <div>
            <label className={label}>Address range for the install</label>
            <input className="input w-full font-mono" value={f.ipRange} onChange={(e) => set('ipRange', e.target.value)} placeholder="192.168.88.10-192.168.88.20" />
            {fieldError(errors.ipRange)}
          </div>
          <div>
            <label className={label}>RouterOS version</label>
            <input className="input w-full" value={f.version} onChange={(e) => set('version', e.target.value)} placeholder="Latest in the update channel" />
            {fieldError(errors.version)}
          </div>
          <div>
            <label className={label}>After installing</label>
            <select className="input w-full" value={f.autoReboot} onChange={(e) => set('autoReboot', e.target.value as EntryForm['autoReboot'])}>
              <option value="reboot">Reboot</option>
              <option value="shutdown">Shut down</option>
              <option value="none">Do nothing</option>
            </select>
          </div>
          <div>
            <label className={label}>Comment</label>
            <input className="input w-full" value={f.comment} onChange={(e) => set('comment', e.target.value)} />
            {fieldError(errors.comment)}
          </div>
        </div>
        <div>
          <label className={label}>Extra packages (RouterOS itself is always installed)</label>
          <PackagePicker value={f.extraPackages} onChange={(v) => set('extraPackages', v)} known={view.packages} />
          {fieldError(errors.extraPackages)}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Toggle on={f.wait} onChange={(v) => set('wait', v)}><b>Wait</b>: hold each device until its install is started here</Toggle>
          <Toggle on={f.keepOld} onChange={(v) => set('keepOld', v)}>Keep the old configuration and users</Toggle>
          <Toggle on={f.applyDefault} onChange={(v) => set('applyDefault', v)}>Apply the default configuration</Toggle>
          <Toggle on={f.installOnce} onChange={(v) => set('installOnce', v)}>Install each device only once</Toggle>
          <Toggle on={f.removeBranding} onChange={(v) => set('removeBranding', v)}>Remove a branding package</Toggle>
          <Toggle on={f.allowEtherboot} onChange={(v) => set('allowEtherboot', v)}>Answer etherboot</Toggle>
          <Toggle on={f.allowFlashfig} onChange={(v) => set('allowFlashfig', v)}>Answer FlashFig</Toggle>
          <Toggle on={f.disabled} onChange={(v) => set('disabled', v)}>Disabled</Toggle>
        </div>
        {fieldError(errors.applyDefault)}
        {view.space_problem && !f.disabled && <p className="text-xs text-red-600 dark:text-red-400">{view.space_problem}</p>}
      </div>
      <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
          <Check className="w-3.5 h-3.5" />{save.isPending ? 'Saving…' : 'Save'}
        </button>
        <ReviewChangesButton request={request} onApply={() => save.mutate()} applyLabel="Save" deviceName={view.device.name} disabled={!valid || save.isPending} />
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        {save.isError && <span className="text-xs text-red-500">{apiErrorMessage(save.error)}</span>}
      </div>
    </Modal>
  );
}

// ─── Starting an install ─────────────────────────────────────────────────────

function InstallModal({ view, target, onClose }: { view: NetinstallDeviceView; target: NetinstallDeviceView['devices'][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const deviceId = view.device.id;
  const [confirm, setConfirm] = useState('');
  const [version, setVersion] = useState('');
  const [extras, setExtras] = useState<string[]>([]);
  const [autoReboot, setAutoReboot] = useState('reboot');
  const mac = target['mac-address'] ?? '';
  const errors: Record<string, string> = {};
  const v = versionError(version); if (v) errors.version = v;
  const p = packagesError(extras, view.packages); if (p) errors.extras = p;
  const confirmed = !!mac && normalizeMac(confirm) === normalizeMac(mac);
  const body = () => ({ mac, confirm_mac: confirm, version: version.trim(), 'extra-packages': extras.join(','), 'auto-reboot': autoReboot });
  const request = () => netinstallApi.install(deviceId, body());
  const run = useMutation({
    meta: { inlineError: true },
    mutationFn: request,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['netinstall-device', deviceId] }); onClose(); },
  });
  const ok = confirmed && Object.keys(errors).length === 0;
  return (
    <Modal title={`Reinstall ${mac}`} onClose={onClose}>
      <div className="p-5 space-y-4">
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            This reformats {target.model ? `the ${target.model}` : 'the device'} at {mac} and installs RouterOS from {view.device.name}.
            Its files and anything not kept by the entry are erased.
            {target.managed && <> It&apos;s <Link to={`/devices/${target.managed.id}`} className="underline font-semibold">{target.managed.name}</Link>, a managed device.</>}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <dt className="text-gray-400">Interface</dt><dd>{target.interface || '—'}</dd>
          <dt className="text-gray-400">Model / architecture</dt><dd>{[target.model, target.arch].filter(Boolean).join(' · ') || '—'}</dd>
          <dt className="text-gray-400">State</dt><dd>{target.state || '—'}</dd>
        </dl>
        <div>
          <label className={label}>RouterOS version</label>
          <input className="input w-full" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="As the entry says" />
          {fieldError(errors.version)}
        </div>
        <div>
          <label className={label}>Extra packages</label>
          <PackagePicker value={extras} onChange={setExtras} known={view.packages} />
          {fieldError(errors.extras)}
        </div>
        <div>
          <label className={label}>After installing</label>
          <select className="input w-full" value={autoReboot} onChange={(e) => setAutoReboot(e.target.value)}>
            <option value="reboot">Reboot</option><option value="shutdown">Shut down</option><option value="none">Do nothing</option>
          </select>
        </div>
        <div>
          <label className={label}>Type the MAC address to confirm</label>
          <input className="input w-full font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={mac} />
        </div>
        {view.space_problem && <p className="text-xs text-red-600 dark:text-red-400">{view.space_problem}</p>}
      </div>
      <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => run.mutate()} disabled={!ok || run.isPending}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
          <HardDriveDownload className="w-3.5 h-3.5" />{run.isPending ? 'Starting…' : 'Reinstall'}
        </button>
        <ReviewChangesButton request={request} onApply={() => run.mutate()} applyLabel="Reinstall" deviceName={view.device.name} disabled={!ok || run.isPending} />
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        {run.isError && <span className="text-xs text-red-500">{apiErrorMessage(run.error)}</span>}
      </div>
    </Modal>
  );
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function CacheModal({ view, onClose }: { view: NetinstallDeviceView; onClose: () => void }) {
  const qc = useQueryClient();
  const deviceId = view.device.id;
  const [arch, setArch] = useState(view.server_arch && (ARCHES as readonly string[]).includes(view.server_arch) ? view.server_arch : 'arm64');
  const [version, setVersion] = useState('');
  const [extras, setExtras] = useState<string[]>([]);
  const errors: Record<string, string> = {};
  const v = versionError(version); if (v) errors.version = v;
  const p = packagesError(extras, view.packages); if (p) errors.extras = p;
  const request = () => netinstallApi.addCache(deviceId, { arch, version: version.trim(), packages: extras.join(',') });
  const run = useMutation({
    meta: { inlineError: true },
    mutationFn: request,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['netinstall-device', deviceId] }); onClose(); },
  });
  const ok = Object.keys(errors).length === 0;
  return (
    <Modal title={`Download install files to ${view.device.name}`} onClose={onClose}>
      <div className="p-5 space-y-4">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Optional: an install downloads what it needs anyway. Downloading first means installs don&apos;t wait for it, and work without internet.
        </p>
        <div>
          <label className={label}>Architecture of the devices to install</label>
          <select className="input w-full" value={arch} onChange={(e) => setArch(e.target.value)}>
            {ARCHES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>RouterOS version</label>
          <input className="input w-full" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Latest in the update channel" />
          {fieldError(errors.version)}
        </div>
        <div>
          <label className={label}>Extra packages</label>
          <PackagePicker value={extras} onChange={setExtras} known={view.packages} />
          {fieldError(errors.extras)}
        </div>
      </div>
      <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => run.mutate()} disabled={!ok || run.isPending}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
          <Download className="w-3.5 h-3.5" />{run.isPending ? 'Starting…' : 'Download'}
        </button>
        <ReviewChangesButton request={request} onApply={() => run.mutate()} applyLabel="Download" deviceName={view.device.name} disabled={!ok || run.isPending} />
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        {run.isError && <span className="text-xs text-red-500">{apiErrorMessage(run.error)}</span>}
      </div>
    </Modal>
  );
}

function CacheFolderModal({ view, onClose }: { view: NetinstallDeviceView; onClose: () => void }) {
  const qc = useQueryClient();
  const deviceId = view.device.id;
  const [dir, setDir] = useState(view.cache_directory);
  const err = cacheDirectoryError(dir, view.disks.map((d) => d.name));
  const request = () => netinstallApi.setCacheDirectory(deviceId, dir.trim());
  const run = useMutation({
    meta: { inlineError: true },
    mutationFn: request,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['netinstall-device', deviceId] }); onClose(); },
  });
  return (
    <Modal title="Cache folder" onClose={onClose}>
      <div className="p-5 space-y-3">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Where install files are kept. At the root they&apos;re in {view.storage.kind === 'ram' && !view.storage.disk ? 'RAM on this device' : 'the device\'s flash'};
          a folder on a disk keeps them there.
        </p>
        <input className="input w-full font-mono" value={dir} onChange={(e) => setDir(e.target.value)} />
        {fieldError(err ?? undefined)}
        {view.disks.length > 0 && (
          <div className="text-xs text-gray-500 dark:text-slate-400">
            Disks: {view.disks.map((d) => (
              <button key={d.name} type="button" className="underline mr-2" onClick={() => setDir(`${d.name}/NetinstallCache/`)}>
                {d.name}{d.type === 'tmpfs' ? ' (RAM)' : ''} {d.free !== null ? `· ${formatMb(d.free)} free` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => run.mutate()} disabled={!!err || run.isPending}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
          <Check className="w-3.5 h-3.5" />{run.isPending ? 'Saving…' : 'Save'}
        </button>
        <ReviewChangesButton request={request} onApply={() => run.mutate()} applyLabel="Save" deviceName={view.device.name} disabled={!!err || run.isPending} />
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        {run.isError && <span className="text-xs text-red-500">{apiErrorMessage(run.error)}</span>}
      </div>
    </Modal>
  );
}

// ─── One Netinstall server ───────────────────────────────────────────────────

function Flags({ e }: { e: RosRow }) {
  const tags = [
    yes(e.wait) && 'waits',
    yes(e['keep-old-configuration']) ? 'keeps config' : yes(e['apply-default-configuration']) ? 'default config' : 'empty config',
    yes(e['install-once']) && 'once',
    yes(e['allow-flashfig']) && 'FlashFig',
    e['allow-etherboot'] === 'false' && 'no etherboot',
    yes(e['remove-branding']) && 'no branding',
  ].filter(Boolean) as string[];
  return <span className="text-xs text-gray-500 dark:text-slate-400">{tags.join(' · ')}</span>;
}

function ServerCard({ device, onPackage }: { device: NetinstallFleetDevice; onPackage: (d: NetinstallFleetDevice, action: 'install' | 'remove') => void }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const guard = useGuardedWrite();
  const [entryForm, setEntryForm] = useState<RosRow | 'new' | null>(null);
  const [installing, setInstalling] = useState<NetinstallDeviceView['devices'][number] | null>(null);
  const [caching, setCaching] = useState(false);
  const [folder, setFolder] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const { data: view, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['netinstall-device', device.id],
    queryFn: () => netinstallApi.device(device.id).then((r) => r.data),
    enabled: device.status === 'online',
    // Faster while devices are etherbooting, so their progress shows, and
    // while an entry is still starting (RouterOS calls it invalid for a few seconds).
    refetchInterval: (q) => {
      const v = q.state.data as NetinstallDeviceView | undefined;
      return v?.devices.length || v?.entries.some((e) => yes(e.invalid)) ? 5_000 : 60_000;
    },
  });
  const done = () => { setWriteError(null); qc.invalidateQueries({ queryKey: ['netinstall-device', device.id] }); };
  const write = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (res) => { guard.onSuccess(res); done(); },
    onError: (e) => setWriteError(apiErrorMessage(e)),
  });

  return (
    <div className="card overflow-hidden">
      {view && entryForm && <EntryModal view={view} existing={entryForm === 'new' ? undefined : entryForm} onClose={() => setEntryForm(null)} />}
      {view && installing && <InstallModal view={view} target={installing} onClose={() => setInstalling(null)} />}
      {view && caching && <CacheModal view={view} onClose={() => setCaching(false)} />}
      {view && folder && <CacheFolderModal view={view} onClose={() => setFolder(false)} />}

      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex-wrap">
        <DeviceTypePill type={device.device_type} />
        <Link to={`/devices/${device.id}`} className="cell-primary hover:underline">{device.name}</Link>
        <span className="text-xs text-gray-400">{[device.model, device.ros_version, view?.server_arch ?? device.architecture].filter(Boolean).join(' · ')}</span>
        {device.status !== 'online' && <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><AlertTriangle className="w-3.5 h-3.5" />{device.status}</span>}
        <div className="ml-auto flex items-center gap-2">
          {view && (
            <span className="text-xs text-gray-500 dark:text-slate-400" title={`Cache folder ${view.cache_directory}`}>
              Cache in {view.storage.kind === 'ram' ? 'RAM' : view.storage.kind === 'disk' ? view.storage.disk : 'flash'}, {formatMb(view.storage.free)} free
            </span>
          )}
          {canWrite && view?.package?.installed && (
            <button onClick={() => onPackage(device, 'remove')} className="text-xs text-gray-500 hover:text-red-600 inline-flex items-center gap-1" title="Remove the netinstall package (reboots the device)">
              <PackageMinus className="w-3.5 h-3.5" /> Remove package
            </button>
          )}
          <button onClick={() => refetch()} disabled={isFetching} title="Refresh" aria-label="Refresh"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-50">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <GuardedWriteUi state={guard} deviceId={device.id} deviceName={device.name} pending={write.isPending} />
        {writeError && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{writeError}</div>}
        {device.status !== 'online' && <p className="text-sm text-gray-400">The device is {device.status}, so its Netinstall can&apos;t be read.</p>}
        {isLoading && <p className="text-sm text-gray-400">Reading the device…</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(error)}</p>}

        {view && !view.package?.installed && (
          <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-3">
            <span>The netinstall package isn&apos;t installed on this device any more{view.package?.scheduled ? ` (${view.package.scheduled})` : ''}.</span>
            {canWrite && view.package && !view.package.scheduled && (
              <button onClick={() => onPackage(device, 'install')} className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                <PackagePlus className="w-3.5 h-3.5" /> Install package
              </button>
            )}
          </p>
        )}
        {view?.package?.installed && (
          <>
            {view.entries.some((e) => e.open) && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>An entry here has no MAC address and doesn&apos;t wait, so any device on its interface that etherboots is reinstalled. Give it a MAC address, turn on Wait, or disable it.</span>
              </div>
            )}
            {view.space_problem && <p className="text-sm text-amber-700 dark:text-amber-400">{view.space_problem}</p>}

            {/* Server entries */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Server entries ({view.entries.length})</h3>
                {canWrite && (
                  <button onClick={() => setEntryForm('new')} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg">
                    <Plus className="w-3 h-3" />Add entry
                  </button>
                )}
              </div>
              {view.entries.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">No entries, so this device doesn&apos;t answer etherboot.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                      <th className="px-3 py-2">Interface</th><th className="px-3 py-2">Installs</th><th className="px-3 py-2">Version</th>
                      <th className="px-3 py-2">Packages</th><th className="px-3 py-2">Settings</th>{canWrite && <th className="px-3 py-2 text-right">Actions</th>}
                    </tr></thead>
                    <tbody>
                      {view.entries.map((e) => {
                        const disabled = yes(e.disabled);
                        return (
                          <tr key={e['.id']} className={clsx('border-b border-gray-100 dark:border-slate-800', disabled && 'opacity-60')}>
                            <td className="px-3 py-2">{e.interface}{yes(e.invalid) && <span className="ml-1 text-xs text-amber-600" title="RouterOS reports this entry as invalid. That's usual for a few seconds after it's added or changed; if it stays, check the interface.">invalid</span>}{disabled && <span className="ml-1 text-xs text-gray-400">disabled</span>}</td>
                            <td className="px-3 py-2 text-xs">
                              {e['mac-address'] ? <span className="font-mono">{e['mac-address']}</span> : e.open ? <span className="text-red-600 font-medium">any device</span> : <span className="text-gray-500">any device, when started here</span>}
                              {e.managed && <span className="ml-1 text-amber-600">({e.managed.name})</span>}
                              {e['ip-range'] && <div className="text-gray-400 font-mono">{e['ip-range']}</div>}
                              {e.comment && <div className="text-gray-400">{e.comment}</div>}
                            </td>
                            <td className="px-3 py-2 text-xs">{e.version || 'latest'}</td>
                            <td className="px-3 py-2 text-xs">{e['extra-packages'] || '—'}</td>
                            <td className="px-3 py-2"><Flags e={e} /></td>
                            {canWrite && (
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  <button title={disabled ? 'Enable' : 'Disable'} onClick={() => write.mutate(() => netinstallApi.updateEntry(device.id, e['.id'], { disabled: !disabled }))}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600"><Power className="w-3.5 h-3.5" /></button>
                                  <button title="Edit" onClick={() => setEntryForm(e)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600"><Pencil className="w-3.5 h-3.5" /></button>
                                  <button title="Delete" onClick={() => { if (confirm(`Delete the Netinstall entry on ${e.interface}?`)) write.mutate(() => netinstallApi.removeEntry(device.id, e['.id'])); }}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Devices it sees */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Devices seen ({view.devices.length})</h3>
                {canWrite && view.devices.length > 0 && (
                  <button onClick={() => write.mutate(() => netinstallApi.clearDevices(device.id))} className="text-xs text-gray-500 hover:text-gray-700 underline">Clear list</button>
                )}
              </div>
              {view.devices.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">No device has etherbooted to it since it started.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                      <th className="px-3 py-2">MAC</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">State</th>
                      <th className="px-3 py-2">Installs</th><th className="px-3 py-2">Updated</th>{canWrite && <th className="px-3 py-2" />}
                    </tr></thead>
                    <tbody>
                      {view.devices.map((d) => (
                        <tr key={d['mac-address']} className="border-b border-gray-100 dark:border-slate-800">
                          <td className="px-3 py-2 text-xs">
                            <span className="font-mono">{d['mac-address']}</span> <span className="text-gray-400">on {d.interface}</span>
                            {yes(d.flashfig) && <span className="ml-1 text-gray-400">FlashFig</span>}
                            {d.managed && <div><Link to={`/devices/${d.managed.id}`} className="text-amber-600 hover:underline">{d.managed.name} (managed)</Link></div>}
                          </td>
                          <td className="px-3 py-2 text-xs">{[d.model, d.arch].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="px-3 py-2 text-xs">{d.state || '—'}{d['last-state'] && <div className="text-gray-400">{d['last-state']}</div>}</td>
                          <td className="px-3 py-2 text-xs">{[d.version, d['extra-packages']].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{d['last-state-update'] ? `${d['last-state-update']} ago` : '—'}</td>
                          {canWrite && (
                            <td className="px-3 py-2 text-right">
                              <button onClick={() => setInstalling(d)} className="px-2 py-1 text-xs rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">Reinstall…</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Cache */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Cache ({view.cache.length}) · <span className="font-mono normal-case">{view.cache_directory}</span></h3>
                {canWrite && (
                  <div className="flex items-center gap-3">
                    <button onClick={() => setFolder(true)} className="text-xs text-gray-500 hover:text-gray-700 underline">Cache folder</button>
                    <button onClick={() => setCaching(true)} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg">
                      <Download className="w-3 h-3" />Download files
                    </button>
                  </div>
                )}
              </div>
              {view.cache.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">Nothing downloaded yet. Files are fetched when an install needs them{view.storage.kind === 'ram' ? ', and kept in RAM until the device reboots' : ''}.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <tbody>
                      {view.cache.map((c) => (
                        <tr key={c.path} className="border-b border-gray-100 dark:border-slate-800">
                          <td className="px-3 py-2 text-xs font-mono">{(c.path ?? '').split('/').pop()}</td>
                          <td className="px-3 py-2 text-xs text-gray-400 truncate max-w-xs" title={c.url}>{c.url}</td>
                          <td className="px-3 py-2 text-xs">{c.status}</td>
                          {canWrite && (
                            <td className="px-3 py-2 text-right">
                              <button title="Remove" onClick={() => write.mutate(() => netinstallApi.removeCache(device.id, c.path))} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const SUPPORT_TEXT: Record<string, string> = {
  'too-old': 'needs RouterOS 7.24 or later',
  unsupported: 'SMIPS: no netinstall package',
  unknown: 'not polled yet',
};

/**
 * Netinstall (#310): reinstall RouterOS on devices from a managed router
 * running the netinstall package (RouterOS 7.24+). Always in the sidebar:
 * a fleet without it yet can install the package from here.
 */
export default function NetworkServicesNetinstallPage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [pkg, setPkg] = useState<{ device: NetinstallFleetDevice; action: 'install' | 'remove' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['netinstall-fleet'],
    queryFn: () => netinstallApi.fleet().then((r) => r.data),
    refetchInterval: (q) => ((q.state.data as { devices: NetinstallFleetDevice[] } | undefined)?.devices.some((d) => d.package_change) ? 10_000 : 60_000),
  });
  // RouterOS may install a newer release along with the package; the server says which, and it's allowed here.
  const [allowUpgrade, setAllowUpgrade] = useState(false);
  const change = useMutation({
    meta: { inlineError: true },
    mutationFn: (p: { device: NetinstallFleetDevice; action: 'install' | 'remove' }) => netinstallApi.changePackage(p.device.id, p.action, allowUpgrade),
    onSuccess: (r) => { setNotice(r.data.message); setPkg(null); setAllowUpgrade(false); qc.invalidateQueries({ queryKey: ['netinstall-fleet'] }); },
  });
  const upgradeTo = (change.error as { response?: { data?: { upgrade_to?: string } } } | null)?.response?.data?.upgrade_to ?? null;
  const closePkg = () => { setPkg(null); setAllowUpgrade(false); change.reset(); };
  const devices = data?.devices ?? [];
  const changing = devices.filter((d) => d.package_change);
  const servers = devices.filter((d) => d.support === 'installed' && !d.package_change);
  const available = devices.filter((d) => d.support === 'available' && !d.package_change);
  const others = devices.filter((d) => d.support !== 'installed' && d.support !== 'available' && !d.package_change);

  return (
    <div className="space-y-6">
      {pkg && (
        <Modal title={`${pkg.action === 'install' ? 'Install' : 'Remove'} the netinstall package on ${pkg.device.name}`} onClose={closePkg}>
          <div className="p-5 space-y-3 text-sm text-gray-700 dark:text-slate-200">
            <p className="flex gap-2"><AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <span>{pkg.device.name} reboots to {pkg.action === 'install' ? 'install' : 'remove'} the package, so it&apos;s offline for a minute or two.
                {pkg.action === 'install' ? ' Installing it doesn\'t make the device answer anything: that only starts with an entry added here.' : ' It stops answering etherboot.'}</span>
            </p>
            {upgradeTo && (
              <Toggle on={allowUpgrade} onChange={setAllowUpgrade}>
                Also upgrade RouterOS to {upgradeTo}. RouterOS may install it with the package; without this, nothing is changed.
              </Toggle>
            )}
          </div>
          <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
            <button onClick={() => change.mutate(pkg)} disabled={change.isPending || (!!upgradeTo && !allowUpgrade)}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              {pkg.action === 'install' ? <PackagePlus className="w-3.5 h-3.5" /> : <PackageMinus className="w-3.5 h-3.5" />}
              {change.isPending ? 'Sending…' : `${pkg.action === 'install' ? 'Install' : 'Remove'} and reboot`}
            </button>
            <ReviewChangesButton request={() => netinstallApi.changePackage(pkg.device.id, pkg.action, allowUpgrade)} onApply={() => change.mutate(pkg)}
              applyLabel={`${pkg.action === 'install' ? 'Install' : 'Remove'} and reboot`} deviceName={pkg.device.name} disabled={change.isPending} />
            <button onClick={closePkg} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            {change.isError && <span className="text-xs text-red-500">{apiErrorMessage(change.error)}</span>}
          </div>
        </Modal>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Netinstall</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Reinstall RouterOS on a device from a router running the netinstall package (RouterOS 7.24 or later) on the same layer 2 segment.
            An install erases the device it installs.
          </p>
        </div>
        <button onClick={() => void refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 text-sm flex-shrink-0">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {notice && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-800 dark:text-blue-300 flex items-start gap-2">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      {isLoading && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}

      {!isLoading && servers.length === 0 && (
        <div className="card p-6 text-sm text-gray-500 dark:text-slate-400">
          No device in this site runs Netinstall yet. {available.length > 0 ? 'Install the package on one of the devices below to use it as a Netinstall server.' : 'A device needs RouterOS 7.24 or later for the package.'}
        </div>
      )}

      {changing.map((d) => (
        <div key={d.id} className="card px-5 py-3 flex items-center gap-2 text-sm">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
          <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
          <span className="text-gray-500 dark:text-slate-400">
            {d.package_change === 'install' ? 'installing' : 'removing'} the netinstall package{d.status !== 'online' ? ', rebooting' : ''}…
          </span>
        </div>
      ))}

      {servers.map((d) => <ServerCard key={d.id} device={d} onPackage={(dev, action) => setPkg({ device: dev, action })} />)}

      {available.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-200">
            Can run Netinstall ({available.length})
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
            {available.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-5 py-2">
                <DeviceTypePill type={d.device_type} />
                <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
                <span className="text-xs text-gray-400">{[d.model, d.ros_version, d.architecture].filter(Boolean).join(' · ')}</span>
                {canWrite && (
                  <button onClick={() => setPkg({ device: d, action: 'install' })} disabled={d.status !== 'online'}
                    title={d.status !== 'online' ? `${d.name} is ${d.status}` : 'Install the netinstall package (reboots the device)'}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 disabled:no-underline">
                    <PackagePlus className="w-3.5 h-3.5" /> Install package
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div className="card overflow-hidden">
          <button onClick={() => setShowOthers((v) => !v)} className="w-full text-left px-5 py-3 text-sm font-semibold text-gray-700 dark:text-slate-200 flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-gray-400" /> Can&apos;t run Netinstall ({others.length}) <span className="text-xs font-normal text-gray-400">{showOthers ? 'hide' : 'show'}</span>
          </button>
          {showOthers && (
            <div className="divide-y divide-gray-100 dark:divide-slate-700/60 border-t border-gray-200 dark:border-slate-700">
              {others.map((d) => (
                <div key={d.id} className="flex items-center gap-2 px-5 py-2">
                  <DeviceTypePill type={d.device_type} />
                  <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
                  <span className="text-xs text-gray-400">{[d.model, d.ros_version, d.architecture].filter(Boolean).join(' · ')}</span>
                  <span className="ml-auto text-xs text-gray-500">{SUPPORT_TEXT[d.support] ?? d.support}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
