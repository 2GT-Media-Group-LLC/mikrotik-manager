import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, Download, Trash2, Plus, Upload, Loader2, Check, X, RefreshCw, AlertTriangle, CheckCircle2, Pencil, KeyRound,
} from 'lucide-react';
import clsx from 'clsx';
import { format, formatDistanceToNow } from 'date-fns';
import { deviceCertsApi, type DeviceCertRow, type DeviceCertStatus, type DeviceCertsOverview, type DeviceCertResult } from '../services/api';
import { useIsFleetAdmin } from '../hooks/useCanWrite';
import { docsUrl } from '../version';

const errText = (e: unknown) => (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.error
  || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || (e as Error)?.message || 'That didn’t work';
const day = (s: string | null) => (s ? format(new Date(s), 'MMM d, yyyy') : '—');

const LIFETIMES = [30, 90, 180, 365, 730, 1095, 1825];
const lifetimeLabel = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

const STATUS: Record<DeviceCertStatus, { label: string; cls: string }> = {
  not_issued: { label: 'Not issued', cls: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300' },
  valid: { label: 'Valid', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  renewal_due: { label: 'Renewal due', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  renewal_failed: { label: 'Renewal failed', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  expired: { label: 'Expired', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
};

function Note({ ok, text, steps, onClose }: { ok: boolean; text: string; steps?: string[]; onClose?: () => void }) {
  return (
    <div className={clsx('flex items-start gap-2 p-3 rounded-lg border text-sm',
      ok ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
        : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
      {ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
      <div className="flex-1 space-y-1">
        <p>{text}</p>
        {!!steps?.length && <ul className="text-xs opacity-80 list-disc ml-4">{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      </div>
      {onClose && <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>}
    </div>
  );
}

/** Lifetime picker: the usual choices, or a number of days. */
function LifetimePicker({ value, onChange, max }: { value: number; onChange: (d: number) => void; max: number }) {
  const custom = !LIFETIMES.includes(value);
  return (
    <div className="flex gap-2">
      <select className="input" value={custom ? 'custom' : value} onChange={(e) => onChange(e.target.value === 'custom' ? (custom ? value : 45) : Number(e.target.value))}>
        {LIFETIMES.map((d) => <option key={d} value={d}>{lifetimeLabel(d)}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <div className="flex items-center gap-1">
          <input type="number" min={1} max={max} className="input w-24" value={value} onChange={(e) => onChange(Number(e.target.value) || 1)} />
          <span className="text-sm text-gray-500">days</span>
        </div>
      )}
    </div>
  );
}

// ─── The CA ────────────────────────────────────────────────────────────────

function SetUpCa({ choices, onDone }: { choices: number[]; onDone: () => void }) {
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [cn, setCn] = useState('MikroTik Manager CA');
  const [org, setOrg] = useState('');
  const [years, setYears] = useState(choices.includes(3650) ? 3650 : choices[0]);
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => deviceCertsApi.createCa({ common_name: cn, organization: org || undefined, days: years }),
    onSuccess: onDone, onError: (e) => setErr(errText(e)),
  });
  const doImport = useMutation({
    mutationFn: () => deviceCertsApi.importCa({ cert_pem: certPem, key_pem: keyPem, passphrase: pass || undefined }),
    onSuccess: (r) => { setWarnings(r.data.warnings); if (!r.data.warnings.length) onDone(); },
    onError: (e) => setErr(errText(e)),
  });
  const readFile = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then(set);
  };
  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900 dark:text-white">Set up a certificate authority</h2>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          The manager signs a certificate for each device you choose with it. Nothing changes on any device until you issue one.
        </p>
      </div>
      <div className="flex gap-2">
        {(['create', 'import'] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setErr(''); }}
            className={clsx('px-3 py-1.5 rounded-lg border text-sm', mode === m ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300')}>
            {m === 'create' ? 'Create a new CA' : 'Import an existing CA'}
          </button>
        ))}
      </div>
      {mode === 'create' ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
          <div><label className="label">Name</label><input className="input" value={cn} onChange={(e) => setCn(e.target.value)} /></div>
          <div><label className="label">Organisation (optional)</label><input className="input" value={org} onChange={(e) => setOrg(e.target.value)} /></div>
          <div><label className="label">Lifetime</label>
            <select className="input" value={years} onChange={(e) => setYears(Number(e.target.value))}>
              {choices.map((d) => <option key={d} value={d}>{d / 365} years</option>)}
            </select></div>
        </div>
      ) : (
        <div className="space-y-3 max-w-3xl">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            For example an intermediate CA from your organisation’s PKI. Paste the PEM text or choose the files. The key is stored encrypted, like device passwords.
          </p>
          <div><label className="label flex items-center justify-between">CA certificate (PEM)
            <input type="file" accept=".crt,.pem,.cer" className="text-xs" onChange={readFile(setCertPem)} /></label>
            <textarea className="input font-mono text-xs" rows={4} value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></div>
          <div><label className="label flex items-center justify-between">CA private key (PEM)
            <input type="file" accept=".key,.pem" className="text-xs" onChange={readFile(setKeyPem)} /></label>
            <textarea className="input font-mono text-xs" rows={4} value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" /></div>
          <div className="max-w-sm"><label className="label">Key passphrase (if it has one)</label>
            <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
        </div>
      )}
      {err && <Note ok={false} text={err} onClose={() => setErr('')} />}
      {warnings.length > 0 && (
        <div className="space-y-2">
          <Note ok={false} text={`Imported, with ${warnings.length === 1 ? 'a warning' : 'warnings'}: ${warnings.join(' ')}`} />
          <button className="btn-secondary text-sm" onClick={onDone}>Continue</button>
        </div>
      )}
      {!warnings.length && (
        <button className="btn-primary text-sm flex items-center gap-2"
          disabled={mode === 'create' ? create.isPending || !cn.trim() : doImport.isPending || !certPem.trim() || !keyPem.trim()}
          onClick={() => { setErr(''); if (mode === 'create') create.mutate(); else doImport.mutate(); }}>
          {(create.isPending || doImport.isPending) ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'create' ? <Plus className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
          {mode === 'create' ? 'Create CA' : 'Import CA'}
        </button>
      )}
    </div>
  );
}

function CaCard({ data, enrolled, onChange }: { data: DeviceCertsOverview; enrolled: number; onChange: () => void }) {
  const ca = data.ca!;
  const [err, setErr] = useState('');
  const del = useMutation({ mutationFn: () => deviceCertsApi.deleteCa(), onSuccess: onChange, onError: (e) => setErr(errText(e)) });
  const download = async () => {
    try {
      const r = await deviceCertsApi.caCertificate();
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/x-pem-file' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'mikrotik-manager-ca.crt'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-lg bg-green-50 dark:bg-green-900/20 flex items-center justify-center"><ShieldCheck className="w-5 h-5 text-green-600" /></div>
        <div className="flex-1 min-w-[240px]">
          <h2 className="font-semibold text-gray-900 dark:text-white">{ca.commonName}</h2>
          <p className="text-xs text-gray-500 dark:text-slate-400">{ca.subject} · {ca.keyType} · {ca.imported ? 'imported' : 'created here'}{ca.created_by ? ` by ${ca.created_by}` : ''}</p>
        </div>
        <button className="btn-secondary text-sm flex items-center gap-1.5" onClick={() => void download()}><Download className="w-3.5 h-3.5" /> Download CA certificate</button>
        <button className="btn-secondary text-sm flex items-center gap-1.5 text-red-600 disabled:opacity-40" disabled={enrolled > 0 || del.isPending}
          title={enrolled > 0 ? 'Remove the device certificates first' : 'Delete the CA'}
          onClick={() => { if (confirm(`Delete ${ca.commonName}? Its key is destroyed; certificates it signed elsewhere stay trusted wherever the CA is installed.`)) del.mutate(); }}>
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">Valid</dt><dd>{day(ca.notBefore)} to {day(ca.notAfter)}</dd>
        <dt className="text-gray-500">SHA-256</dt><dd className="font-mono text-xs break-all">{ca.fingerprint.match(/.{2}/g)?.join(':')}</dd>
      </dl>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        Install the CA certificate as trusted in browsers, scripts or tools, and they can check every device certificate it signs.
        Only trust it where you’d trust the manager: whoever holds the CA’s key can sign a certificate for any name.
      </p>
      {err && <Note ok={false} text={err} onClose={() => setErr('')} />}
    </div>
  );
}

function SettingsCard({ data, onSaved }: { data: DeviceCertsOverview; onSaved: () => void }) {
  const s = data.settings!;
  const [f, setF] = useState(s);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(s);
  const save = useMutation({
    mutationFn: () => deviceCertsApi.saveSettings(f),
    onSuccess: () => { setMsg({ ok: true, text: 'Saved.' }); onSaved(); },
    onError: (e) => setMsg({ ok: false, text: errText(e) }),
  });
  return (
    <div className="card p-5 space-y-3">
      <h3 className="font-semibold text-gray-900 dark:text-white">Device certificate defaults</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <div><label className="label">Lifetime</label><LifetimePicker value={f.default_days} max={data.limits.max_days} onChange={(d) => setF({ ...f, default_days: d })} /></div>
        <div><label className="label">Renew this many days before expiry</label>
          <input type="number" min={1} className="input w-28" value={f.renew_before_days} onChange={(e) => setF({ ...f, renew_before_days: Number(e.target.value) || 1 })} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
        <input type="checkbox" checked={f.auto_renew} onChange={(e) => setF({ ...f, auto_renew: e.target.checked })} /> Renew automatically
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
        <input type="checkbox" checked={f.default_www} onChange={(e) => setF({ ...f, default_www: e.target.checked })} /> Use the certificate for WebFig (www-ssl) too, unless chosen otherwise when issuing
      </label>
      <p className="text-xs text-gray-400">A lifetime applies when a certificate is issued or renewed. Renewal makes a new key each time. A certificate never outlives the CA.</p>
      {msg && <Note ok={msg.ok} text={msg.text} onClose={() => setMsg(null)} />}
      <button className="btn-primary text-sm flex items-center gap-2" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
      </button>
    </div>
  );
}

// ─── Devices ───────────────────────────────────────────────────────────────

type IssueTarget = { rows: DeviceCertRow[]; reissue: boolean };

function IssueDialog({ target, data, onClose, onDone }: {
  target: IssueTarget; data: DeviceCertsOverview; onClose: () => void; onDone: (results: Record<number, { ok: boolean; text: string; steps?: string[] }>) => void;
}) {
  const single = target.rows.length === 1 ? target.rows[0] : null;
  const [days, setDays] = useState(single?.days ?? data.settings!.default_days);
  const [www, setWww] = useState(single?.apply_www ?? data.settings!.default_www);
  const [names, setNames] = useState((single?.extra_names ?? []).join(', '));
  const [progress, setProgress] = useState<{ done: number; current: string } | null>(null);
  const plain = target.rows.filter((r) => !r.api_ssl);
  const run = async () => {
    const results: Record<number, { ok: boolean; text: string; steps?: string[] }> = {};
    const extra = names.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean);
    for (let i = 0; i < target.rows.length; i++) {
      const r = target.rows[i];
      setProgress({ done: i, current: r.name.trim() });
      try {
        const res = await deviceCertsApi.issue(r.id, { days, apply_www: www, ...(single ? { extra_names: extra } : {}) });
        results[r.id] = { ok: true, text: res.data.message, steps: res.data.steps };
      } catch (e) {
        const d = (e as { response?: { data?: DeviceCertResult } }).response?.data;
        results[r.id] = { ok: false, text: d?.message ?? errText(e), steps: d?.steps };
      }
    }
    onDone(results);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            {target.reissue ? 'Reissue certificate' : 'Issue certificate'}{single ? ` · ${single.name.trim()}` : ` to ${target.rows.length} devices`}
          </h3>
          <button onClick={onClose} disabled={!!progress} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4 text-sm">
          <div><label className="label">Lifetime</label><LifetimePicker value={days} max={data.limits.max_days} onChange={setDays} /></div>
          {single && (
            <div><label className="label">Extra names (optional)</label>
              <input className="input font-mono" value={names} onChange={(e) => setNames(e.target.value)} placeholder="sw1.example.net, 10.0.0.2" />
              <p className="text-xs text-gray-400 mt-1">The certificate always covers <span className="font-mono">{single.ip_address}</span>. Add DNS names or other addresses people use to reach the device.</p>
            </div>
          )}
          <label className="flex items-center gap-2"><input type="checkbox" checked={www} onChange={(e) => setWww(e.target.checked)} /> Use it for WebFig (www-ssl) too</label>
          {plain.length > 0 && (
            <div className="flex gap-2 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-800 dark:text-blue-300">
              <KeyRound className="w-4 h-4 shrink-0" />
              <p>{plain.length === 1 && single ? 'This device is' : `${plain.length} of these devices are`} managed over the plain API. Issuing also moves {plain.length === 1 ? 'it' : 'them'} to API-SSL, but only once a login over API-SSL works; otherwise nothing changes.</p>
            </div>
          )}
          <p className="text-xs text-gray-400">
            The manager makes the key, uploads it encrypted, switches api-ssl to the new certificate and logs in afresh to prove it. If that login fails, the device goes back to the certificate it had.
          </p>
          {progress && (
            <div className="flex items-center gap-2 text-blue-600"><Loader2 className="w-4 h-4 animate-spin" /> {progress.current} ({progress.done + 1} of {target.rows.length})</div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary text-sm" onClick={onClose} disabled={!!progress}>Cancel</button>
            <button className="btn-primary text-sm flex items-center gap-2" disabled={!!progress || days < 1} onClick={() => void run()}>
              <ShieldCheck className="w-4 h-4" /> {target.reissue ? 'Reissue' : 'Issue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type Filter = 'all' | 'not_issued' | 'issued' | 'attention';

function DevicesCard({ data, onChange }: { data: DeviceCertsOverview; onChange: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [issue, setIssue] = useState<IssueTarget | null>(null);
  const [results, setResults] = useState<Record<number, { ok: boolean; text: string; steps?: string[] }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useMemo(() => data.devices.filter((r) => filter === 'all'
    || (filter === 'not_issued' && r.cert_status === 'not_issued')
    || (filter === 'issued' && r.cert_status !== 'not_issued')
    || (filter === 'attention' && ['renewal_due', 'renewal_failed', 'expired'].includes(r.cert_status))), [data.devices, filter]);
  const act = async (r: DeviceCertRow, kind: 'renew' | 'remove' | 'forget') => {
    if (kind === 'remove' && !confirm(`Remove the manager's certificate from ${r.name.trim()}? api-ssl${r.apply_www ? ' and WebFig' : ''} go back to the certificate they had before.`)) return;
    if (kind === 'forget' && !confirm(`Forget ${r.name.trim()}'s certificate without touching the device? Use this if the device was reset or replaced.`)) return;
    setBusy(r.id);
    try {
      const res = kind === 'renew' ? await deviceCertsApi.renew(r.id) : await deviceCertsApi.remove(r.id, kind === 'forget');
      setResults((x) => ({ ...x, [r.id]: { ok: true, text: res.data.message, steps: res.data.steps } }));
    } catch (e) {
      const d = (e as { response?: { data?: DeviceCertResult } }).response?.data;
      setResults((x) => ({ ...x, [r.id]: { ok: false, text: d?.message ?? errText(e), steps: d?.steps } }));
    } finally {
      setBusy(null);
      onChange();
    }
  };
  const selRows = data.devices.filter((r) => selected.has(r.id) && r.cert_status === 'not_issued');
  const counts = {
    issued: data.devices.filter((r) => r.cert_status !== 'not_issued').length,
    attention: data.devices.filter((r) => ['renewal_due', 'renewal_failed', 'expired'].includes(r.cert_status)).length,
  };
  return (
    <div className="card overflow-hidden">
      <div className="p-4 flex items-center gap-3 flex-wrap border-b border-gray-200 dark:border-slate-700">
        <h3 className="font-semibold text-gray-900 dark:text-white">Devices</h3>
        <span className="text-xs text-gray-400">{counts.issued} of {data.devices.length} have a certificate{counts.attention ? ` · ${counts.attention} need attention` : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          <select className="input py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">All devices</option><option value="not_issued">Not issued</option>
            <option value="issued">With a certificate</option><option value="attention">Needs attention</option>
          </select>
          <button className="btn-primary text-sm flex items-center gap-1.5" disabled={selRows.length === 0} onClick={() => setIssue({ rows: selRows, reissue: false })}>
            <ShieldCheck className="w-3.5 h-3.5" /> Issue to selected{selRows.length ? ` (${selRows.length})` : ''}
          </button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-gray-200 dark:border-slate-700 text-left">
          <th className="px-3 py-2 w-8" />
          {['Device', 'Connection', 'Certificate', 'Names', ''].map((h) => <th key={h} className="table-header px-3 py-2">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
          {rows.map((r) => {
            const st = STATUS[r.cert_status];
            const res = results[r.id];
            return (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2.5">
                  {r.cert_status === 'not_issued' && (
                    <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900 dark:text-white">{r.name.trim()}</div>
                  <div className="text-xs text-gray-400 font-mono">{r.ip_address}{r.site_name ? <span className="font-sans"> · {r.site_name}</span> : null}</div>
                  {res && <div className="mt-2"><Note ok={res.ok} text={res.text} steps={res.steps} onClose={() => setResults((x) => { const n = { ...x }; delete n[r.id]; return n; })} /></div>}
                </td>
                <td className="px-3 py-2.5 text-xs">{r.api_ssl ? <span className="text-green-600">API-SSL</span> : <span className="text-amber-600">Plain API</span>}<div className="text-gray-400">RouterOS {r.ros_version ?? '?'}</div></td>
                <td className="px-3 py-2.5">
                  <span className={clsx('px-1.5 py-0.5 rounded text-xs', st.cls)}>{st.label}</span>
                  {r.not_after && <div className="text-xs text-gray-500 mt-1" title={day(r.not_after)}>until {day(r.not_after)} ({formatDistanceToNow(new Date(r.not_after), { addSuffix: true })})</div>}
                  {r.apply_www && <div className="text-xs text-gray-400">api-ssl + WebFig</div>}
                  {r.last_error && <div className="text-xs text-red-600 mt-1 max-w-xs" title={r.last_error}>{r.last_error}</div>}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{(r.sans ?? []).join(', ') || '—'}</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-right">
                  {busy === r.id ? <Loader2 className="w-4 h-4 animate-spin inline text-blue-500" /> : r.cert_status === 'not_issued' ? (
                    <button className="btn-secondary text-xs py-1" onClick={() => setIssue({ rows: [r], reissue: false })}>Issue</button>
                  ) : (
                    <div className="flex items-center justify-end gap-1">
                      <button className="p-1.5 text-gray-400 hover:text-blue-500" title="Renew now" onClick={() => void act(r, 'renew')}><RefreshCw className="w-3.5 h-3.5" /></button>
                      <button className="p-1.5 text-gray-400 hover:text-blue-500" title="Change names, lifetime or WebFig, and reissue" onClick={() => setIssue({ rows: [r], reissue: true })}><Pencil className="w-3.5 h-3.5" /></button>
                      <button className="p-1.5 text-gray-400 hover:text-red-500" title="Remove from the device" onClick={() => void act(r, 'remove')}><Trash2 className="w-3.5 h-3.5" /></button>
                      {res && !res.ok && <button className="text-xs text-gray-500 hover:underline" onClick={() => void act(r, 'forget')}>Forget</button>}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No devices match.</td></tr>}
        </tbody>
      </table>
      {issue && <IssueDialog target={issue} data={data} onClose={() => setIssue(null)}
        onDone={(r) => { setResults((x) => ({ ...x, ...r })); setIssue(null); setSelected(new Set()); onChange(); }} />}
    </div>
  );
}

// ─── The page ──────────────────────────────────────────────────────────────

export default function CertificatesPage() {
  const isFleetAdmin = useIsFleetAdmin();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['device-certs'], queryFn: () => deviceCertsApi.overview().then((r) => r.data), enabled: isFleetAdmin,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['device-certs'] });
  const enrolled = data?.devices.filter((d) => d.cert_status !== 'not_issued').length ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> Certificates</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Give devices certificates from your own CA, so the manager, browsers and tools can check them properly instead of trusting
          a self-signed certificate. Optional, device by device. <a className="text-blue-500 hover:underline" href={docsUrl('certificates/')} target="_blank" rel="noreferrer">How it works</a>
        </p>
      </div>
      {!isFleetAdmin ? (
        <div className="card p-5 text-sm text-gray-500">Certificates are managed by fleet admins.</div>
      ) : isLoading ? (
        <div className="text-center py-8 text-gray-400">Loading…</div>
      ) : error || !data ? (
        <div className="card p-5 text-sm text-red-500">{errText(error)}</div>
      ) : !data.ca ? (
        <SetUpCa choices={data.limits.ca_day_choices} onDone={refresh} />
      ) : (
        <>
          <CaCard data={data} enrolled={enrolled} onChange={refresh} />
          <SettingsCard data={data} onSaved={refresh} />
          <DevicesCard data={data} onChange={refresh} />
        </>
      )}
    </div>
  );
}
