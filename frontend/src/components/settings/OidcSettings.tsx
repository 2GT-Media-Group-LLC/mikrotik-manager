import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2, Copy, Check, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { oidcApi, type OidcConfigView } from '../../services/api';
import type { UserRole } from '../../types';

const ROLES: UserRole[] = ['viewer', 'operator', 'admin'];
type GroupRow = { group: string; role: UserRole };

export default function OidcSettings({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useQuery({
    queryKey: ['oidc-config'],
    queryFn: () => oidcApi.getConfig().then((r) => r.data),
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return <div className="card p-6 text-sm text-gray-400 dark:text-slate-500">Single sign-on can only be configured by administrators.</div>;
  }
  if (!data) return <div className="card p-6 text-sm text-gray-400 dark:text-slate-500">Loading…</div>;

  // Remount when the loaded config identity changes so form state re-initializes.
  return <OidcForm key={data.redirect_uri} initial={data} />;
}

function OidcForm({ initial }: { initial: OidcConfigView }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<OidcConfigView>(initial);
  const [secret, setSecret] = useState('');
  const [groupRows, setGroupRows] = useState<GroupRow[]>(
    Object.entries(initial.group_role_map || {}).map(([group, role]) => ({ group, role }))
  );
  const [domains, setDomains] = useState((initial.allowed_email_domains || []).join(', '));
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => {
      const group_role_map: Record<string, UserRole> = {};
      for (const r of groupRows) if (r.group.trim()) group_role_map[r.group.trim()] = r.role;
      const allowed_email_domains = domains.split(',').map((d) => d.trim()).filter(Boolean);
      const payload: Partial<OidcConfigView> & { client_secret?: string } = {
        ...form!,
        group_role_map,
        allowed_email_domains,
      };
      delete (payload as Record<string, unknown>).redirect_uri;
      delete (payload as Record<string, unknown>).has_secret;
      if (secret) payload.client_secret = secret;
      return oidcApi.updateConfig(payload);
    },
    onSuccess: (r) => {
      setSecret('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      qc.setQueryData(['oidc-config'], r.data);
    },
  });

  const test = useMutation({
    mutationFn: () => oidcApi.test(form.issuer_url),
    onSuccess: (r) => setTestResult({ ok: r.data.ok, msg: r.data.ok ? `Discovered ${r.data.issuer}` : (r.data.error || 'Failed') }),
    onError: (e: unknown) => setTestResult({ ok: false, msg: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Discovery failed' }),
  });

  const set = <K extends keyof OidcConfigView>(k: K, v: OidcConfigView[K]) => setForm({ ...form, [k]: v });

  const copyRedirect = () => {
    navigator.clipboard.writeText(form.redirect_uri).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Single Sign-On (OIDC)</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">authenticate against your identity provider</span>
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enabled
        </label>
      </div>

      <div className="p-5 space-y-5">
        {/* Redirect URI to register with the IdP */}
        <div>
          <label className="label">Redirect URI (register this with your provider)</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1.5 rounded bg-gray-50 dark:bg-slate-800 font-mono text-xs break-all text-gray-700 dark:text-slate-300">{form.redirect_uri}</code>
            <button className="btn-secondary flex items-center gap-1.5" onClick={copyRedirect}>
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Provider connection */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Issuer URL</label>
            <input className="input w-full" value={form.issuer_url} placeholder="https://login.example.com/realms/main" onChange={(e) => set('issuer_url', e.target.value)} />
          </div>
          <div>
            <label className="label">Client ID</label>
            <input className="input w-full" value={form.client_id} onChange={(e) => set('client_id', e.target.value)} />
          </div>
          <div>
            <label className="label">Client Secret {form.has_secret && <span className="text-green-600 dark:text-green-400">(configured)</span>}</label>
            <input className="input w-full" type="password" value={secret} placeholder={form.has_secret ? '•••••••• (leave blank to keep)' : 'none — public client'} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <div>
            <label className="label">Scopes</label>
            <input className="input w-full" value={form.scopes} onChange={(e) => set('scopes', e.target.value)} />
          </div>
          <div>
            <label className="label">Button label</label>
            <input className="input w-full" value={form.button_label} onChange={(e) => set('button_label', e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn-secondary flex items-center gap-1.5" disabled={!form.issuer_url || test.isPending} onClick={() => test.mutate()}>
            <RefreshCw className={test.isPending ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />Test discovery
          </button>
          {testResult && (
            <span className={`flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{testResult.msg}
            </span>
          )}
        </div>

        {/* Claim mapping */}
        <div className="grid gap-3 sm:grid-cols-3 pt-2 border-t border-gray-100 dark:border-slate-700/50">
          <div>
            <label className="label">Username claim</label>
            <input className="input w-full" value={form.username_claim} onChange={(e) => set('username_claim', e.target.value)} />
          </div>
          <div>
            <label className="label">Email claim</label>
            <input className="input w-full" value={form.email_claim} onChange={(e) => set('email_claim', e.target.value)} />
          </div>
          <div>
            <label className="label">Groups claim</label>
            <input className="input w-full" value={form.groups_claim} onChange={(e) => set('groups_claim', e.target.value)} />
          </div>
        </div>

        {/* Group → role mapping */}
        <div>
          <label className="label">Group → role mapping</label>
          <div className="space-y-2">
            {groupRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="input flex-1" placeholder="IdP group name" value={row.group} onChange={(e) => setGroupRows(groupRows.map((r, j) => j === i ? { ...r, group: e.target.value } : r))} />
                <span className="text-gray-400">→</span>
                <select className="input w-36" value={row.role} onChange={(e) => setGroupRows(groupRows.map((r, j) => j === i ? { ...r, role: e.target.value as UserRole } : r))}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button className="p-1.5 text-gray-400 hover:text-red-600" onClick={() => setGroupRows(groupRows.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <button className="btn-secondary flex items-center gap-1.5" onClick={() => setGroupRows([...groupRows, { group: '', role: 'viewer' }])}>
              <Plus className="w-4 h-4" />Add mapping
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label className="label mb-0">Default role (no group match)</label>
            <select className="input w-36" value={form.default_role} onChange={(e) => set('default_role', e.target.value as UserRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        {/* Provisioning */}
        <div className="grid gap-2 pt-2 border-t border-gray-100 dark:border-slate-700/50">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
            <input type="checkbox" checked={form.auto_provision} onChange={(e) => set('auto_provision', e.target.checked)} />
            Auto-provision new users on first sign-in
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
            <input type="checkbox" checked={form.link_by_verified_email} onChange={(e) => set('link_by_verified_email', e.target.checked)} />
            Link to existing accounts by verified email
          </label>
          <div>
            <label className="label">Allowed email domains (comma-separated, blank = any)</label>
            <input className="input w-full" value={domains} placeholder="example.com, corp.example.com" onChange={(e) => setDomains(e.target.value)} />
          </div>
          <div>
            <label className="label">Public base URL (optional — overrides the redirect URI host)</label>
            <input className="input w-full" value={form.public_base_url} placeholder="https://manager.example.com" onChange={(e) => set('public_base_url', e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-gray-100 dark:border-slate-700/50">
          <button className="btn-primary flex items-center gap-1.5" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}Save
          </button>
          {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
          {save.isError && <span className="text-xs text-red-600 dark:text-red-400">{(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Save failed'}</span>}
        </div>
      </div>
    </div>
  );
}
