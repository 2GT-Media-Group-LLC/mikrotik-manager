import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Loader2, RefreshCw, CheckCircle2, AlertTriangle, Search } from 'lucide-react';
import { dnsSourcesApi, sitesApi, type DnsSource, type DnsSourceInput } from '../../services/api';
import { apiErrorMessage } from '../../utils/apiError';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';

/**
 * Settings → DNS query log (#366 step 3): AdGuard Home and Pi-hole servers
 * whose query logs show what clients look up and what was blocked; AdGuard
 * Home also gives destinations the domain the client asked for. Any number
 * per site, for resolvers that share the load. Fleet admins only.
 */

type Kind = 'adguard' | 'pihole';
const PRODUCT: Record<Kind, string> = { adguard: 'AdGuard Home', pihole: 'Pi-hole' };

type Form = { id: number | null; kind: Kind; name: string; site_id: string; url: string; username: string; password: string; tls_verify: boolean; enabled: boolean };

function urlProblem(url: string): string | null {
  if (!url.trim()) return 'Enter the server’s web address';
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Start with http:// or https://';
    if (u.username || u.password) return 'Put the login in its own fields';
    if (u.search || u.hash) return 'Leave out anything after ? or #';
  } catch { return 'Not a valid address'; }
  return null;
}

function SourceForm({ initial, saved, onDone }: { initial: Form; saved?: DnsSource; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(initial);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data) });
  const set = (patch: Partial<Form>) => { setF({ ...f, ...patch }); setTestResult(null); };

  // The saved password goes with the source only to the address it was saved for (as the server checks).
  const moved = !!saved && (f.url.trim().replace(/\/+$/, '') !== saved.url || (saved.tls_verify && !f.tls_verify));
  const needsPassword = !!saved?.has_password && moved && !f.password;
  const errors = {
    name: !f.name.trim() ? 'Give it a name' : null,
    site_id: !f.site_id ? 'Choose a site' : null,
    url: urlProblem(f.url),
    password: needsPassword ? 'The address changed, so enter the password again' : f.password.startsWith('enc:') ? 'Enter the password itself' : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const body = (): DnsSourceInput => ({
    name: f.name.trim(), kind: f.kind, site_id: Number(f.site_id), url: f.url.trim(), username: f.kind === 'pihole' ? '' : f.username,
    ...(f.password ? { password: f.password } : {}), tls_verify: f.tls_verify, enabled: f.enabled,
  });
  const save = useMutation({
    mutationFn: () => (f.id ? dnsSourcesApi.update(f.id, body()) : dnsSourcesApi.create(body())),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dns-sources'] }); onDone(); },
  });
  const test = useMutation({
    mutationFn: () => dnsSourcesApi.test({ ...body(), ...(f.id ? { id: f.id } : {}) }).then((r) => r.data),
    onSuccess: (r) => setTestResult({ ok: true, text: `Connected. The query log answered with ${r.entries} recent entr${r.entries === 1 ? 'y' : 'ies'}.` }),
    onError: (e) => setTestResult({ ok: false, text: apiErrorMessage(e) }),
  });

  const field = (label: string, err: string | null, input: React.ReactNode, help?: string) => (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">{label}</span>
      {input}
      {err ? <span className="block text-[11.5px] text-red-600 dark:text-red-400 mt-0.5">{err}</span>
        : help && <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{help}</span>}
    </label>
  );

  return (
    <div className="border border-gray-200 dark:border-slate-700 rounded-lg p-4 space-y-3">
      <div className="flex gap-4 text-sm text-gray-700 dark:text-slate-300" role="radiogroup" aria-label="Server type">
        {(['adguard', 'pihole'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="radio" name={`kind-${f.id ?? 'new'}`} checked={f.kind === k} onChange={() => set({ kind: k })} />{PRODUCT[k]}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field('Name', errors.name, <input className="input w-full" value={f.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder={f.kind === 'pihole' ? 'Pi-hole 1' : 'Office AdGuard'} />)}
        {field('Site', errors.site_id,
          <select className="input w-full" value={f.site_id} onChange={(e) => set({ site_id: e.target.value })}>
            <option value="">Choose…</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>, 'Its clients are matched to this site’s clients by address')}
      </div>
      {field('Address', errors.url, <input className="input w-full font-mono text-sm" value={f.url} onChange={(e) => set({ url: e.target.value })}
        placeholder={f.kind === 'pihole' ? 'http://192.168.88.3' : 'http://192.168.88.2:3000'} />,
        `The ${PRODUCT[f.kind]} web interface address, as MikroTik Manager’s server reaches it`)}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {f.kind === 'adguard' && field('Username', null, <input className="input w-full" value={f.username} maxLength={200} autoComplete="off" onChange={(e) => set({ username: e.target.value })} />)}
        {field(f.kind === 'pihole' ? 'Password or app password' : 'Password', errors.password,
          <input className="input w-full" type="password" value={f.password} autoComplete="new-password" onChange={(e) => set({ password: e.target.value })}
            placeholder={saved?.has_password ? 'Unchanged' : ''} />,
          saved?.has_password ? 'Leave empty to keep the saved one'
            : f.kind === 'pihole' ? 'Stored encrypted. With two-factor login on, use an app password from Pi-hole’s settings' : 'Stored encrypted')}
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-gray-700 dark:text-slate-300">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.tls_verify} onChange={(e) => set({ tls_verify: e.target.checked })} />Check the server&apos;s certificate (https)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Read its log every minute</label>
      </div>
      {testResult && (
        <p className={testResult.ok ? 'text-sm text-green-600 dark:text-green-400' : 'text-sm text-red-600 dark:text-red-400'}>{testResult.text}</p>
      )}
      {save.isError && <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(save.error)}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary flex items-center gap-1.5" disabled={invalid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}Save
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1.5" disabled={!!errors.url || needsPassword || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}Test
        </button>
        <button type="button" className="text-sm text-gray-500 hover:underline" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

export default function DnsSourcesCard() {
  const qc = useQueryClient();
  const { formatDateTime } = useDateTimeFormat();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['dns-sources'],
    queryFn: () => dnsSourcesApi.list().then((r) => r.data),
    refetchInterval: 30_000,
  });
  const remove = useMutation({
    mutationFn: (id: number) => dnsSourcesApi.remove(id),
    onSuccess: () => { setConfirmDelete(null); qc.invalidateQueries({ queryKey: ['dns-sources'] }); },
  });
  const poll = useMutation({
    mutationFn: (id: number) => dnsSourcesApi.poll(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['dns-sources'] }),
  });
  const blank: Form = { id: null, kind: 'adguard', name: '', site_id: '', url: '', username: '', password: '', tls_verify: true, enabled: true };

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white">DNS Servers</h3>
        <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
          NetFlow shows where traffic goes, but not the names behind it. Add the AdGuard Home or Pi-hole servers that
          answer a site&apos;s DNS (all of them, when several share the load) and MikroTik Manager reads their query logs
          every minute: Traffic shows the names each client looked up and which were blocked. AdGuard Home also logs
          the addresses each name answered with, so destinations get the domain the client asked for; Pi-hole
          doesn&apos;t, so for Pi-hole sites names come from the routers&apos; DNS caches instead (Settings → Polling).
          Lookups are counted per hour and kept for the days set under General → Data Retention; the logs themselves
          stay on the servers.
        </p>
      </div>
      {isLoading ? <p className="text-sm text-gray-400">Loading…</p> : (
        <div className="space-y-3">
          {sources.map((s) => editing === s.id ? (
            <SourceForm key={s.id} saved={s} onDone={() => setEditing(null)}
              initial={{ id: s.id, kind: s.kind, name: s.name, site_id: String(s.site_id), url: s.url, username: s.username, password: '', tls_verify: s.tls_verify, enabled: s.enabled }} />
          ) : (
            <div key={s.id} className="flex flex-wrap items-start gap-3 border border-gray-200 dark:border-slate-700 rounded-lg px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {s.last_error ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <CheckCircle2 className={s.enabled ? 'w-4 h-4 text-green-500' : 'w-4 h-4 text-gray-300'} />}
                  <span className="font-medium text-gray-900 dark:text-white">{s.name}</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400">{PRODUCT[s.kind]}</span>
                  <span className="text-xs text-gray-400">{s.site_name}</span>
                  {!s.enabled && <span className="text-xs text-gray-400">paused</span>}
                </div>
                <div className="font-mono text-xs text-gray-500 dark:text-slate-400 truncate">{s.url}</div>
                <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                  {Number(s.queries_counted).toLocaleString()} lookups counted
                  {s.last_polled_at && ` · last read ${formatDateTime(s.last_polled_at)}`}
                </div>
                {s.last_error && <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{s.last_error}</div>}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="btn-secondary px-2" title="Read now" disabled={poll.isPending} onClick={() => poll.mutate(s.id)}>
                  <RefreshCw className={poll.isPending && poll.variables === s.id ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
                </button>
                <button type="button" className="btn-secondary px-2" title="Edit" onClick={() => setEditing(s.id)}><Pencil className="w-4 h-4" /></button>
                {confirmDelete === s.id ? (
                  <>
                    <button type="button" className="btn-danger text-xs px-2 py-1" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>Remove</button>
                    <button type="button" className="text-xs text-gray-500 px-1" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="btn-secondary px-2 text-red-600" title="Remove" onClick={() => setConfirmDelete(s.id)}><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            </div>
          ))}
          {editing === 'new'
            ? <SourceForm initial={blank} onDone={() => setEditing(null)} />
            : (
              <button type="button" className="btn-secondary flex items-center gap-1.5" onClick={() => setEditing('new')}>
                <Plus className="w-4 h-4" />Add a DNS server
              </button>
            )}
          {poll.isError && <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(poll.error)}</p>}
        </div>
      )}
    </div>
  );
}
