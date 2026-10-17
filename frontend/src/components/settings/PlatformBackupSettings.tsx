import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HardDrive, Download, RotateCcw, Trash2, Plus, Pencil, Check, X, RefreshCw, AlertTriangle, CheckCircle2,
  XCircle, Upload, Cloud, Server, Mail, Clock, Loader2, Eye, EyeOff,
} from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import {
  platformBackupApi, alertsApi,
  type PlatformBackupContents, type PlatformBackupDestination, type PlatformBackupRow, type PlatformBackupHeader,
  type PlatformBackupSchedule, type PlatformRestoreState,
} from '../../services/api';
import { useAuthStore } from '../../store/authStore';

const errText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error)?.message || 'That didn’t work';
const mb = (n: number | null) => (n == null ? '—' : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const CONTENTS_LABEL: Record<PlatformBackupContents, string> = { config: 'Configuration', 'config+database': 'Configuration + database' };
const TYPE_ICON = { s3: Cloud, sftp: Server, email: Mail } as const;
const TYPE_LABEL = { s3: 'S3-compatible', sftp: 'SFTP', email: 'Email' } as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function Note({ ok, text, onClose }: { ok: boolean; text: string; onClose?: () => void }) {
  return (
    <div className={clsx('flex items-start gap-2 p-3 rounded-lg border text-sm',
      ok ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
        : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
      {ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
      <p className="flex-1">{text}</p>
      {onClose && <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>}
    </div>
  );
}

function PassphraseInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input className="input pr-9 font-mono" type={show ? 'text' : 'password'} value={value} autoFocus={autoFocus}
        autoComplete="new-password" placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" onClick={() => setShow((s) => !s)}
        title={show ? 'Hide' : 'Show'}>{show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
    </div>
  );
}

function DestinationPicker({ all, chosen, onChange }: { all: PlatformBackupDestination[]; chosen: number[]; onChange: (ids: number[]) => void }) {
  if (!all.length) return <p className="text-xs text-gray-400">Only this server. Add a destination below to also copy backups off it.</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      <span className="flex items-center gap-1.5 text-sm text-gray-500"><input type="checkbox" checked disabled /> This server</span>
      {all.map((d) => {
        const Icon = TYPE_ICON[d.type];
        return (
          <label key={d.id} className={clsx('flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300', !d.enabled && 'opacity-50')}>
            <input type="checkbox" disabled={!d.enabled} checked={chosen.includes(d.id)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))} />
            <Icon className="w-3.5 h-3.5 text-gray-400" /> {d.name}
          </label>
        );
      })}
    </div>
  );
}

// ─── Back up now ────────────────────────────────────────────────────────────

function BackupNowCard({ hasSaved, min, destinations, onDone }: { hasSaved: boolean; min: number; destinations: PlatformBackupDestination[]; onDone: (msg: string) => void }) {
  const [contents, setContents] = useState<PlatformBackupContents>('config');
  const [useSaved, setUseSaved] = useState(hasSaved);
  const [pass, setPass] = useState('');
  const [dests, setDests] = useState<number[]>([]);
  const [err, setErr] = useState('');
  const go = useMutation({
    mutationFn: () => platformBackupApi.backupNow({ contents, destination_ids: dests, ...(useSaved ? { use_saved_passphrase: true } : { passphrase: pass }) }),
    onSuccess: () => { setErr(''); setPass(''); onDone('Backup started. It appears in the list below when it finishes.'); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-semibold text-gray-900 dark:text-white">Back up now</h3>
      <div className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(CONTENTS_LABEL) as PlatformBackupContents[]).map((c) => (
          <label key={c} className="flex items-center gap-2 text-gray-700 dark:text-slate-300">
            <input type="radio" checked={contents === c} onChange={() => setContents(c)} /> {CONTENTS_LABEL[c]}
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-400">
        {contents === 'config'
          ? 'Devices and their stored logins, sites, users and roles, settings, alerting, templates, secrets, tags and topology layout. Small; no history.'
          : 'Everything in the database, history included (events, clients, change history). Larger, and slower to make.'}
      </p>
      <div className="space-y-2">
        {hasSaved && (
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
            <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} /> Use the schedule’s saved passphrase
          </label>
        )}
        {!useSaved && <div className="max-w-sm"><label className="label">Passphrase (at least {min} characters)</label><PassphraseInput value={pass} onChange={setPass} /></div>}
      </div>
      <div><label className="label">Send to</label><DestinationPicker all={destinations} chosen={dests} onChange={setDests} /></div>
      {err && <Note ok={false} text={err} onClose={() => setErr('')} />}
      <button className="btn-primary flex items-center gap-2 text-sm" disabled={go.isPending || (!useSaved && pass.length < min)} onClick={() => go.mutate()}>
        {go.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />} Back up now
      </button>
    </div>
  );
}

// ─── Schedule ───────────────────────────────────────────────────────────────

function ScheduleCard({ schedule, min, destinations, onSaved }: { schedule: PlatformBackupSchedule; min: number; destinations: PlatformBackupDestination[]; onSaved: (msg: string) => void }) {
  const [f, setF] = useState(schedule);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setF(schedule); }, [schedule]);
  const save = useMutation({
    mutationFn: () => platformBackupApi.saveSchedule({
      enabled: f.enabled, frequency: f.frequency, time_of_day: f.time_of_day, weekday: f.weekday, monthday: f.monthday,
      contents: f.contents, keep: f.keep, destination_ids: f.destination_ids, ...(pass ? { passphrase: pass } : {}),
    }),
    onSuccess: () => { setErr(''); setPass(''); setPass2(''); onSaved('Schedule saved.'); },
    onError: (e) => setErr(errText(e)),
  });
  const passMismatch = pass !== '' && pass !== pass2;
  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-blue-500" />
        <h3 className="font-semibold text-gray-900 dark:text-white">Schedule</h3>
        {schedule.last_run_at && <span className="text-xs text-gray-400">last ran {formatDistanceToNow(new Date(schedule.last_run_at), { addSuffix: true })}</span>}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Back up automatically
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div><label className="label">How often</label>
          <select className="input" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as PlatformBackupSchedule['frequency'] })}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          </select></div>
        {f.frequency === 'weekly' && <div><label className="label">Day</label>
          <select className="input" value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select></div>}
        {f.frequency === 'monthly' && <div><label className="label">Day of month</label>
          <select className="input" value={f.monthday} onChange={(e) => setF({ ...f, monthday: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select></div>}
        <div><label className="label">Time</label>
          <input type="time" className="input" value={f.time_of_day} onChange={(e) => setF({ ...f, time_of_day: e.target.value })} /></div>
        <div><label className="label">What</label>
          <select className="input" value={f.contents} onChange={(e) => setF({ ...f, contents: e.target.value as PlatformBackupContents })}>
            <option value="config">Configuration</option><option value="config+database">Configuration + database</option>
          </select></div>
        <div><label className="label">Keep</label>
          <input type="number" min={1} max={365} className="input" value={f.keep} onChange={(e) => setF({ ...f, keep: Number(e.target.value) || 1 })} /></div>
      </div>
      <p className="text-xs text-gray-400">The time is in the app’s time zone (Settings → General). Keep is how many scheduled and manual backups stay on this server; each destination keeps its own number.</p>
      <div><label className="label">Send to</label><DestinationPicker all={destinations} chosen={f.destination_ids} onChange={(ids) => setF({ ...f, destination_ids: ids })} /></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
        <div><label className="label">{schedule.has_passphrase ? 'New passphrase (leave empty to keep the saved one)' : `Passphrase (at least ${min} characters)`}</label>
          <PassphraseInput value={pass} onChange={setPass} /></div>
        <div><label className="label">Passphrase again</label><PassphraseInput value={pass2} onChange={setPass2} /></div>
      </div>
      <div className="flex gap-2 p-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <p>Backups are encrypted with this passphrase, and it’s the only way to open them. Keep a copy somewhere other than this server: if it’s lost, so are the backups.</p>
      </div>
      {err && <Note ok={false} text={err} onClose={() => setErr('')} />}
      <button className="btn-primary flex items-center gap-2 text-sm" onClick={() => save.mutate()}
        disabled={save.isPending || passMismatch || (pass !== '' && pass.length < min) || (f.enabled && !schedule.has_passphrase && !pass)}>
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save schedule
      </button>
      {passMismatch && <span className="text-xs text-red-500 ml-2">The passphrases don’t match.</span>}
    </div>
  );
}

// ─── Destinations ───────────────────────────────────────────────────────────

type DestForm = { id?: number; type: 's3' | 'sftp' | 'email'; name: string; enabled: boolean; keep: number; config: Record<string, string | boolean>; secrets: Record<string, string> };

function DestinationModal({ initial, onClose, onSaved }: { initial: DestForm; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<DestForm>(initial);
  const [err, setErr] = useState('');
  const { data: channels = [] } = useQuery({
    queryKey: ['alert-channels'], queryFn: () => alertsApi.getChannels().then((r) => r.data), enabled: f.type === 'email',
  });
  const cfg = (k: string) => String(f.config[k] ?? '');
  const setCfg = (k: string, v: string | boolean) => setF({ ...f, config: { ...f.config, [k]: v } });
  const setSec = (k: string, v: string) => setF({ ...f, secrets: { ...f.secrets, [k]: v } });
  const editing = f.id !== undefined;
  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { ...f.config };
      if (f.type === 'email') config.recipients = cfg('recipients').split(/[,\s]+/).filter(Boolean);
      const body = { type: f.type, name: f.name, enabled: f.enabled, keep: f.keep, config, secrets: f.secrets };
      return editing ? platformBackupApi.updateDestination(f.id!, body) : platformBackupApi.addDestination(body);
    },
    onSuccess: () => onSaved(),
    onError: (e) => setErr(errText(e)),
  });
  const secretHint = editing ? 'Leave empty to keep the saved one' : undefined;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">{editing ? 'Edit destination' : 'Add destination'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          {!editing && (
            <div className="flex gap-2">
              {(['s3', 'sftp', 'email'] as const).map((t) => {
                const Icon = TYPE_ICON[t];
                return (
                  <button key={t} type="button" onClick={() => setF({ ...f, type: t, config: {}, secrets: {} })}
                    className={clsx('flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border text-sm',
                      f.type === t ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300')}>
                    <Icon className="w-4 h-4" /> {TYPE_LABEL[t]}
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Offsite backups" /></div>
            <div><label className="label">Keep</label><input type="number" min={1} max={365} className="input" value={f.keep} onChange={(e) => setF({ ...f, keep: Number(e.target.value) || 1 })} disabled={f.type === 'email'} /></div>
          </div>
          {f.type === 's3' && (<>
            <div><label className="label">Endpoint</label><input className="input font-mono" value={cfg('endpoint')} onChange={(e) => setCfg('endpoint', e.target.value)} placeholder="https://s3.us-east-1.amazonaws.com" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Region</label><input className="input font-mono" value={cfg('region')} onChange={(e) => setCfg('region', e.target.value)} placeholder="us-east-1" /></div>
              <div><label className="label">Bucket</label><input className="input font-mono" value={cfg('bucket')} onChange={(e) => setCfg('bucket', e.target.value)} /></div>
            </div>
            <div><label className="label">Folder in the bucket (optional)</label><input className="input font-mono" value={cfg('prefix')} onChange={(e) => setCfg('prefix', e.target.value)} placeholder="mikrotik-manager" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Access key</label><input className="input font-mono" value={cfg('accessKeyId')} onChange={(e) => setCfg('accessKeyId', e.target.value)} /></div>
              <div><label className="label">Secret key</label><PassphraseInput value={f.secrets.secretAccessKey ?? ''} onChange={(v) => setSec('secretAccessKey', v)} placeholder={secretHint} /></div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
              <input type="checkbox" checked={!!f.config.pathStyle} onChange={(e) => setCfg('pathStyle', e.target.checked)} /> Path-style addressing (MinIO and most self-hosted storage)
            </label>
          </>)}
          {f.type === 'sftp' && (<>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2"><label className="label">Host</label><input className="input font-mono" value={cfg('host')} onChange={(e) => setCfg('host', e.target.value)} /></div>
              <div><label className="label">Port</label><input className="input font-mono" value={cfg('port')} onChange={(e) => setCfg('port', e.target.value)} placeholder="22" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Username</label><input className="input font-mono" value={cfg('username')} onChange={(e) => setCfg('username', e.target.value)} /></div>
              <div><label className="label">Folder</label><input className="input font-mono" value={cfg('directory')} onChange={(e) => setCfg('directory', e.target.value)} placeholder="backups/mtm" /></div>
            </div>
            <div><label className="label">Password</label><PassphraseInput value={f.secrets.password ?? ''} onChange={(v) => setSec('password', v)} placeholder={secretHint ?? 'Or use a private key below'} /></div>
            <div><label className="label">Private key (instead of a password)</label>
              <textarea className="input font-mono text-xs" rows={3} value={f.secrets.privateKey ?? ''} onChange={(e) => setSec('privateKey', e.target.value)} placeholder={secretHint ?? '-----BEGIN OPENSSH PRIVATE KEY-----'} /></div>
            {(f.secrets.privateKey || editing) && (
              <div><label className="label">Private key passphrase (if the key has one)</label>
                <PassphraseInput value={f.secrets.passphrase ?? ''} onChange={(v) => setSec('passphrase', v)} placeholder={secretHint} /></div>
            )}
            {cfg('hostKey') && (
              <p className="text-xs text-gray-400">
                Host key saved: <span className="font-mono break-all">{cfg('hostKey')}</span>. Uploads are refused if the server presents a different one.{' '}
                <button type="button" className="text-blue-500 hover:underline" onClick={() => setCfg('hostKey', '')}>Forget it</button> if the server really changed; the next test saves the new one.
              </p>
            )}
          </>)}
          {f.type === 'email' && (<>
            <div><label className="label">Send with the SMTP settings of</label>
              <select className="input" value={cfg('channelId')} onChange={(e) => setCfg('channelId', e.target.value)}>
                <option value="">Choose an email alert channel…</option>
                {channels.filter((c) => c.type === 'email').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div><label className="label">Send to (leave empty for the channel’s recipients)</label>
              <input className="input" value={Array.isArray(f.config.recipients) ? (f.config.recipients as unknown as string[]).join(', ') : cfg('recipients')} onChange={(e) => setCfg('recipients', e.target.value)} placeholder="backups@example.com" /></div>
            <p className="text-xs text-gray-400">For configuration backups: a full database backup is usually too big for email (over 20 MB is refused).</p>
          </>)}
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled
          </label>
          {err && <Note ok={false} text={err} onClose={() => setErr('')} />}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || !f.name.trim()} className="btn-primary text-sm flex items-center gap-2">
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DestinationsCard({ destinations, onChange }: { destinations: PlatformBackupDestination[]; onChange: () => void }) {
  const [modal, setModal] = useState<DestForm | null>(null);
  const [notes, setNotes] = useState<Record<number, { ok: boolean; text: string }>>({});
  const test = useMutation({
    mutationFn: (id: number) => platformBackupApi.testDestination(id),
    onSuccess: (r, id) => { setNotes((n) => ({ ...n, [id]: { ok: true, text: r.data.message } })); onChange(); },
    onError: (e, id) => setNotes((n) => ({ ...n, [id]: { ok: false, text: errText(e) } })),
  });
  const remove = useMutation({ mutationFn: (id: number) => platformBackupApi.removeDestination(id), onSuccess: onChange });
  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-900 dark:text-white">Destinations</h3>
        <button className="btn-secondary text-sm flex items-center gap-1.5" onClick={() => setModal({ type: 's3', name: '', enabled: true, keep: 14, config: {}, secrets: {} })}>
          <Plus className="w-3.5 h-3.5" /> Add destination
        </button>
      </div>
      <p className="text-xs text-gray-400">Every backup stays on this server. A destination also copies it off the server, so it survives losing the server.</p>
      {destinations.length === 0 && <p className="text-sm text-gray-400">No destinations yet.</p>}
      {destinations.map((d) => {
        const Icon = TYPE_ICON[d.type];
        const where = d.type === 's3' ? `${d.config.bucket ?? ''}${d.config.prefix ? `/${d.config.prefix}` : ''}`
          : d.type === 'sftp' ? `${d.config.username ?? ''}@${d.config.host ?? ''}:${d.config.directory || '~'}`
            : (Array.isArray(d.config.recipients) && d.config.recipients.length ? (d.config.recipients as string[]).join(', ') : 'the channel’s recipients');
        return (
          <div key={d.id} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Icon className="w-4 h-4 text-gray-400" />
              <span className="font-medium text-gray-900 dark:text-white">{d.name}</span>
              <span className="text-xs text-gray-400">{TYPE_LABEL[d.type]} · <span className="font-mono">{where}</span>{d.type !== 'email' ? ` · keeps ${d.keep}` : ''}</span>
              {!d.enabled && <span className="text-xs text-gray-400">(disabled)</span>}
              <div className="ml-auto flex items-center gap-1">
                <button className="btn-secondary text-xs py-1" disabled={test.isPending} onClick={() => test.mutate(d.id)}>
                  {test.isPending && test.variables === d.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Test'}
                </button>
                <button className="p-1.5 text-gray-400 hover:text-blue-500" title="Edit"
                  onClick={() => setModal({ id: d.id, type: d.type, name: d.name, enabled: d.enabled, keep: d.keep, config: d.config as Record<string, string | boolean>, secrets: {} })}>
                  <Pencil className="w-3.5 h-3.5" /></button>
                <button className="p-1.5 text-gray-400 hover:text-red-500" title="Delete"
                  onClick={() => { if (confirm(`Delete destination ${d.name}? Backups already there stay there.`)) remove.mutate(d.id); }}>
                  <Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            {notes[d.id] && <Note ok={notes[d.id].ok} text={notes[d.id].text} onClose={() => setNotes((n) => { const x = { ...n }; delete x[d.id]; return x; })} />}
          </div>
        );
      })}
      {modal && <DestinationModal initial={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); onChange(); }} />}
    </div>
  );
}

// ─── Restore ────────────────────────────────────────────────────────────────

type RestoreSource = { backup_id?: number; upload_id?: string; label: string; header: PlatformBackupHeader };

function RestoreDialog({ source, appVersion, onClose, onStarted }: { source: RestoreSource; appVersion: string; onClose: () => void; onStarted: () => void }) {
  const [pass, setPass] = useState('');
  const [mode, setMode] = useState<'config' | 'full'>(source.header.contents === 'config+database' ? 'full' : 'config');
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const src = { backup_id: source.backup_id, upload_id: source.upload_id };
  const check = useMutation({
    mutationFn: () => platformBackupApi.check(src, pass),
    onSuccess: (r) => { setErr(''); setChecked(true); if (!r.data.restorable) setErr(`This backup is from MikroTik Manager ${r.data.header.app_version}, newer than this one (${appVersion}). Update first.`); },
    onError: (e) => { setChecked(false); setErr(errText(e)); },
  });
  const go = useMutation({ mutationFn: () => platformBackupApi.restore(src, pass, mode), onSuccess: onStarted, onError: (e) => setErr(errText(e)) });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 border-2 border-red-500">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 flex items-center gap-2"><RotateCcw className="w-5 h-5" /> Restore a platform backup</h3>
          <button onClick={onClose} disabled={go.isPending} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4 text-sm">
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
            <dt className="text-gray-500">Backup</dt><dd className="font-mono text-xs break-all">{source.label}</dd>
            <dt className="text-gray-500">Made</dt><dd>{new Date(source.header.created_at).toLocaleString()} by MikroTik Manager {source.header.app_version}</dd>
            <dt className="text-gray-500">Holds</dt><dd>{CONTENTS_LABEL[source.header.contents]}</dd>
          </dl>
          <div><label className="label">Passphrase</label><PassphraseInput value={pass} autoFocus onChange={(v) => { setPass(v); setChecked(false); }} /></div>
          <div className="space-y-2">
            <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={mode === 'config'} onChange={() => setMode('config')} />
              <span><span className="font-medium">Configuration only</span><br /><span className="text-xs text-gray-500">Replaces devices, users, settings and the rest of the setup. History is kept for devices that are in the backup; devices that aren’t are removed with their history.</span></span></label>
            <label className={clsx('flex items-start gap-2', source.header.contents !== 'config+database' && 'opacity-40')}>
              <input type="radio" className="mt-1" disabled={source.header.contents !== 'config+database'} checked={mode === 'full'} onChange={() => setMode('full')} />
              <span><span className="font-medium">Everything</span><br /><span className="text-xs text-gray-500">Replaces the whole database with the backup, history included. Use this to move MikroTik Manager to a new server.</span></span></label>
          </div>
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-xs text-red-700 dark:text-red-300 space-y-1">
            <p>The current state is backed up first (with this passphrase), so you can go back. MikroTik Manager then pauses, restores, and restarts; everyone is signed out.</p>
            <p>This server’s platform backup settings, destinations and backups, device config backup files and metrics are left as they are.</p>
          </div>
          {err && <Note ok={false} text={err} />}
          {!checked ? (
            <button className="btn-secondary text-sm flex items-center gap-2" disabled={check.isPending || !pass} onClick={() => check.mutate()}>
              {check.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Check passphrase
            </button>
          ) : (
            <>
              <label className="block">Type <span className="font-mono font-semibold">RESTORE</span> to confirm
                <input className="input mt-1 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RESTORE" /></label>
              <div className="flex justify-end gap-2">
                <button className="btn-secondary text-sm" onClick={onClose} disabled={go.isPending}>Cancel</button>
                <button className="btn-danger text-sm flex items-center gap-2 disabled:opacity-50" disabled={typed !== 'RESTORE' || go.isPending || !!err} onClick={() => go.mutate()}>
                  {go.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Restore
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Follows a restore through the restart, then signs out. */
function RestoreProgress({ initial }: { initial: PlatformRestoreState }) {
  const [state, setState] = useState<{ phase: string; message: string; error?: string }>(initial);
  const [back, setBack] = useState(false);
  const logout = useAuthStore((s) => s.logout);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await platformBackupApi.restoreProgress();
        // Idle again means it restarted: the state only resets with the
        // process (a failure stops this loop first), even if no poll landed
        // while it was down.
        if (r.data.phase === 'idle') { setBack(true); clearInterval(t); return; }
        setState(r.data);
        if (r.data.phase === 'failed') {
          clearInterval(t);
          // A failed restore doesn't restart, so the session still works: the
          // reason is only in the signed-in overview.
          const o = await platformBackupApi.overview().catch(() => null);
          if (o?.data.restore.error) setState((s) => ({ ...s, error: o.data.restore.error }));
        }
      } catch {
        // The backend is restarting.
        setState((s) => ({ ...s, phase: 'restarting', message: 'MikroTik Manager is restarting…' }));
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 p-6 text-center space-y-4">
        {back ? <CheckCircle2 className="w-10 h-10 mx-auto text-green-500" /> : state.phase === 'failed' ? <XCircle className="w-10 h-10 mx-auto text-red-500" /> : <Loader2 className="w-10 h-10 mx-auto animate-spin text-blue-500" />}
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {back ? 'Restored' : state.phase === 'failed' ? 'The restore failed' : 'Restoring'}
        </h3>
        <p className="text-sm text-gray-600 dark:text-slate-300">
          {back ? 'MikroTik Manager is back with the restored data. Sign in again to continue.' : state.phase === 'failed' ? (state.error ? `Nothing was changed. ${state.error}` : state.message) : state.message || 'Working…'}
        </p>
        {back && <button className="btn-primary" onClick={() => { logout(); window.location.href = '/login'; }}>Sign in</button>}
        {state.phase === 'failed' && <button className="btn-secondary" onClick={async () => { await platformBackupApi.clearRestore().catch(() => {}); window.location.reload(); }}>Close</button>}
      </div>
    </div>
  );
}

// ─── The tab ────────────────────────────────────────────────────────────────

export default function PlatformBackupSettings() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-backup'],
    queryFn: () => platformBackupApi.overview().then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.backups.some((b) => b.status === 'running') ? 3000 : 30_000),
  });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [restoreFrom, setRestoreFrom] = useState<RestoreSource | null>(null);
  const [restoring, setRestoring] = useState<PlatformRestoreState | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-backup'] });

  const remove = useMutation({ mutationFn: (id: number) => platformBackupApi.remove(id), onSuccess: refresh, onError: (e) => setNote({ ok: false, text: errText(e) }) });
  const download = async (b: PlatformBackupRow) => {
    try {
      const r = await platformBackupApi.downloadLink(b.id);
      window.location.href = r.data.url;
    } catch (e) { setNote({ ok: false, text: errText(e) }); }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setUpload(0);
    try {
      const r = await platformBackupApi.upload(f, setUpload);
      setRestoreFrom({ upload_id: r.data.upload_id, label: f.name, header: r.data.header });
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setUpload(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  useEffect(() => {
    if (data?.restore && data.restore.phase !== 'idle' && !restoring) setRestoring(data.restore);
  }, [data?.restore, restoring]);

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;
  if (error || !data) return <div className="card p-5 text-sm text-red-500">{errText(error)}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2"><HardDrive className="w-5 h-5" /> Backup &amp; Restore</h2>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Backups of MikroTik Manager itself, to restore it here or move it to a new server. Device config backups and metrics aren’t included.
        </p>
      </div>
      {note && <Note ok={note.ok} text={note.text} onClose={() => setNote(null)} />}

      <BackupNowCard hasSaved={data.schedule.has_passphrase} min={data.min_passphrase} destinations={data.destinations}
        onDone={(m) => { setNote({ ok: true, text: m }); refresh(); }} />
      <ScheduleCard schedule={data.schedule} min={data.min_passphrase} destinations={data.destinations}
        onSaved={(m) => { setNote({ ok: true, text: m }); refresh(); }} />
      <DestinationsCard destinations={data.destinations} onChange={refresh} />

      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-gray-900 dark:text-white">Backups</h3>
          <div className="flex items-center gap-2">
            <button className="btn-secondary text-sm flex items-center gap-1.5" onClick={refresh}><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
            <button className="btn-secondary text-sm flex items-center gap-1.5" disabled={upload !== null} onClick={() => fileRef.current?.click()}>
              {upload !== null ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading {upload}%</> : <><Upload className="w-3.5 h-3.5" /> Restore from a file…</>}
            </button>
            <input ref={fileRef} type="file" accept=".mtmbackup" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
        </div>
        {data.backups.length === 0 ? <p className="text-sm text-gray-400">No platform backups yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 dark:border-slate-700 text-left">
              {['Made', 'What', 'How', 'Size', 'Result', ''].map((h) => <th key={h} className="table-header px-3 py-2">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2" title={b.file_name}>{new Date(b.created_at).toLocaleString()}<div className="text-xs text-gray-400">{b.app_version}{b.created_by ? ` · ${b.created_by}` : ''}</div></td>
                  <td className="px-3 py-2">{CONTENTS_LABEL[b.contents]}</td>
                  <td className="px-3 py-2 capitalize">{b.trigger.replace('-', ' ')}</td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{mb(b.size_bytes)}</td>
                  <td className="px-3 py-2">
                    {b.status === 'running' && <span className="flex items-center gap-1 text-blue-600"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running</span>}
                    {b.status === 'failed' && <span className="text-red-600" title={b.error ?? ''}>Failed: {b.error}</span>}
                    {b.status === 'success' && (
                      <div className="flex flex-wrap gap-1">
                        <span className="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">this server</span>
                        {b.destinations.map((d) => (
                          <span key={d.id} title={d.error ?? (d.pruned ? `removed ${d.pruned} older` : '')}
                            className={clsx('px-1.5 py-0.5 rounded text-xs', d.ok ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400')}>
                            {d.name}{d.ok ? '' : ': failed'}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {b.status === 'success' && (<>
                      <button className="p-1.5 text-gray-400 hover:text-blue-500" title="Download" onClick={() => void download(b)}><Download className="w-3.5 h-3.5" /></button>
                      <button className="p-1.5 text-gray-400 hover:text-orange-500" title="Restore"
                        onClick={() => setRestoreFrom({ backup_id: b.id, label: b.file_name, header: { format: 1, app_version: b.app_version ?? '', created_at: b.created_at, contents: b.contents } })}>
                        <RotateCcw className="w-3.5 h-3.5" /></button>
                    </>)}
                    {b.status !== 'running' && (
                      <button className="p-1.5 text-gray-400 hover:text-red-500" title="Delete"
                        onClick={() => { if (confirm(`Delete ${b.file_name} from this server? Copies at destinations stay.`)) remove.mutate(b.id); }}>
                        <Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {restoreFrom && <RestoreDialog source={restoreFrom} appVersion={data.app_version} onClose={() => setRestoreFrom(null)}
        onStarted={() => { setRestoreFrom(null); setRestoring({ phase: 'pre-backup', message: 'Backing up the current state first' }); }} />}
      {restoring && <RestoreProgress initial={restoring} />}
    </div>
  );
}
