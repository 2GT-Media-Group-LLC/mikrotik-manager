import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { Bot, Check, Copy, Plus, RefreshCw, Trash2, X, AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { aiConnectionsApi, sitesApi, type AiSettingsView, type McpAuth } from '../../services/api';
import { aiSettingsProblem, endpointBase, usesTokens } from '../../utils/aiConnections';
import { docsUrl } from '../../version';

type ApiError = { response?: { data?: { error?: string } } };
const errorText = (e: unknown, fallback: string) => (e as ApiError)?.response?.data?.error || fallback;

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600')}>
      <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn-secondary flex items-center gap-1.5 text-xs flex-shrink-0"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Endpoint({ label, url }: { label: string; url: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-slate-400 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 px-2 py-1.5 rounded bg-gray-50 dark:bg-slate-800 font-mono text-xs break-all text-gray-700 dark:text-slate-300">{url}</code>
        <CopyButton text={url} />
      </div>
    </div>
  );
}

function Service({ title, blurb, on, onChange, children }: {
  title: string; blurb: string; on: boolean; onChange: (v: boolean) => void; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="pt-0.5"><Toggle checked={on} onChange={onChange} label={title} /></div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">{title}</div>
          <p className="text-xs text-gray-500 dark:text-slate-400">{blurb}</p>
        </div>
      </div>
      {on && <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-100 dark:border-slate-700/60">{children}</div>}
    </div>
  );
}

/**
 * Settings → AI Connections: lets AI tools read the fleet's stored review data
 * over MCP and/or OpenAPI. Read-only; admins with fleet-wide access only.
 */
export default function AiConnectionsSettings({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useQuery({
    queryKey: ['ai-connections'],
    queryFn: () => aiConnectionsApi.getConfig().then((r) => r.data),
    enabled: isAdmin,
  });
  if (!isAdmin) return <div className="card p-6 text-sm text-gray-400 dark:text-slate-500">AI connections can only be set up by administrators.</div>;
  if (!data) return <div className="card p-6 text-sm text-gray-400 dark:text-slate-500">Loading…</div>;
  return <AiForm initial={data} />;
}

const FIELDS = ['enabled', 'mcp_enabled', 'mcp_auth', 'openapi_enabled', 'public_url', 'oauth_issuer', 'oauth_client_id'] as const;

function AiForm({ initial }: { initial: AiSettingsView }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AiSettingsView>(initial);
  const [saved, setSaved] = useState<AiSettingsView>(initial);
  const [secret, setSecret] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const set = <K extends keyof AiSettingsView>(k: K, v: AiSettingsView[K]) => { setForm((f) => ({ ...f, [k]: v })); setJustSaved(false); };

  const dirty = !!secret || FIELDS.some((k) => form[k] !== saved[k]);
  const problem = aiSettingsProblem(form, secret);
  const base = endpointBase(form.public_url, window.location.origin);
  const oauth = form.mcp_auth === 'oauth';

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => aiConnectionsApi.updateConfig({
      ...Object.fromEntries(FIELDS.map((k) => [k, typeof form[k] === 'string' ? (form[k] as string).trim() : form[k]])),
      ...(secret ? { oauth_client_secret: secret } : {}),
    }),
    onSuccess: (r) => {
      setSecret(''); setForm(r.data); setSaved(r.data); setJustSaved(true);
      qc.setQueryData(['ai-connections'], r.data);
    },
  });
  const test = useMutation({
    mutationFn: () => aiConnectionsApi.test({ issuer: form.oauth_issuer.trim(), client_id: form.oauth_client_id.trim(), ...(secret ? { client_secret: secret } : {}) }),
    onSuccess: (r) => setTestResult({ ok: r.data.ok, msg: r.data.ok ? 'Found the provider and its introspection endpoint.' : (r.data.error || 'Failed') }),
    onError: (e) => setTestResult({ ok: false, msg: errorText(e, 'The test failed.') }),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <Bot className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI Connections</h3>
          <span className="text-xs text-gray-400 dark:text-slate-500 hidden sm:inline">let AI tools review the fleet, read-only</span>
          <div className="ml-auto flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
            {form.enabled ? 'On' : 'Off'}
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="AI connections" />
          </div>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-slate-300">
            AI tools can read what MikroTik Manager has already stored: sites, devices, security findings, config health,
            CVE matches, interfaces and event metadata. They can&apos;t change anything, run commands or connect to devices,
            and passwords, keys and raw configuration are never included. Each call is recorded in the audit log.{' '}
            <a className="text-blue-600 dark:text-blue-400 hover:underline" href={docsUrl('ai-connections/')} target="_blank" rel="noreferrer">How to connect a tool</a>
          </p>

          {form.enabled && (
            <>
              <div>
                <label className="label">Public address</label>
                <input className="input w-full" value={form.public_url} placeholder={window.location.origin}
                  onChange={(e) => set('public_url', e.target.value)} />
                <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                  The address AI tools reach MikroTik Manager at. Blank uses this browser&apos;s address. OAuth needs it set.
                </p>
              </div>

              <Service title="MCP" on={form.mcp_enabled} onChange={(v) => set('mcp_enabled', v)}
                blurb="Model Context Protocol, for Claude, ChatGPT, LM Studio and Open WebUI's MCP connections.">
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-gray-700 dark:text-slate-200">Sign-in</div>
                  <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden" role="radiogroup" aria-label="MCP sign-in">
                    {([['token', 'AI connection token'], ['oauth', 'OAuth']] as [McpAuth, string][]).map(([value, label]) => (
                      <button key={value} type="button" role="radio" aria-checked={form.mcp_auth === value} onClick={() => set('mcp_auth', value)}
                        className={clsx('px-3 py-1 text-sm transition-colors', form.mcp_auth === value
                          ? 'bg-sky-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60')}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-slate-400 leading-snug">
                    {oauth
                      ? 'People sign in through your identity provider and see only their own sites. Needed for ChatGPT and other hosted services.'
                      : 'The tool sends a token made below as "Authorization: Bearer mtm_…". Simplest for tools on your own network.'}
                  </p>
                </div>

                {oauth && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="label">Issuer URL</label>
                      <input className="input w-full" value={form.oauth_issuer} placeholder="https://login.example.com/realms/main"
                        onChange={(e) => set('oauth_issuer', e.target.value)} />
                    </div>
                    <div>
                      <label className="label">Client ID</label>
                      <input className="input w-full" value={form.oauth_client_id} onChange={(e) => set('oauth_client_id', e.target.value)} />
                    </div>
                    <div>
                      <label className="label">Client secret {form.has_oauth_secret && <span className="text-green-600 dark:text-green-400">(saved)</span>}</label>
                      <input className="input w-full" type="password" autoComplete="new-password" value={secret}
                        placeholder={form.has_oauth_secret ? '•••••••• (blank keeps it)' : ''} onChange={(e) => { setSecret(e.target.value); setJustSaved(false); }} />
                    </div>
                    <p className="sm:col-span-2 text-xs text-gray-500 dark:text-slate-400 leading-snug">
                      A confidential client MikroTik Manager uses to check each token (token introspection). Tokens need the
                      scope <span className="font-mono">mcp:read</span> and the MCP server URL below as their audience. People
                      must already have a MikroTik Manager account they&apos;ve signed in to with SSO.
                    </p>
                    <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                      <button type="button" className="btn-secondary flex items-center gap-1.5"
                        disabled={!form.oauth_issuer.trim() || !form.oauth_client_id.trim() || (!secret && !form.has_oauth_secret) || test.isPending}
                        onClick={() => test.mutate()}>
                        <RefreshCw className={test.isPending ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />Test provider
                      </button>
                      {testResult && (
                        <span className={clsx('flex items-center gap-1.5 text-xs', testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                          {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{testResult.msg}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <Endpoint label="MCP server URL" url={`${base}/api/mcp`} />
                {oauth && <Endpoint label="OAuth protected-resource metadata" url={`${base}/.well-known/oauth-protected-resource/api/mcp`} />}
              </Service>

              <Service title="OpenAPI" on={form.openapi_enabled} onChange={(v) => set('openapi_enabled', v)}
                blurb="An OpenAPI tool server, for Open WebUI's tool servers and other tools that read an OpenAPI spec.">
                <p className="text-xs text-gray-500 dark:text-slate-400 leading-snug">
                  Signs in with an AI connection token. In Open WebUI, add the server URL as an OpenAPI tool server, keep
                  the spec path <span className="font-mono">openapi.json</span>, and put the token in as a Bearer key.
                </p>
                <Endpoint label="Server URL" url={`${base}/api/review`} />
                <Endpoint label="OpenAPI spec" url={`${base}/api/review/openapi.json`} />
              </Service>
            </>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-gray-100 dark:border-slate-700/50">
            <button type="button" className="btn-primary flex items-center gap-1.5" disabled={!dirty || !!problem || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}Save
            </button>
            {problem && <span className="text-xs text-red-600 dark:text-red-400">{problem}</span>}
            {!problem && dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Not saved yet. Nothing changes until you save.</span>}
            {!dirty && justSaved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            {save.isError && <span className="text-xs text-red-600 dark:text-red-400">{errorText(save.error, 'Save failed')}</span>}
          </div>
        </div>
      </div>

      {usesTokens(form) && <TokensCard />}
    </div>
  );
}

function TokensCard() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [allSites, setAllSites] = useState(true);
  const [chosen, setChosen] = useState<number[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);

  const { data: tokens = [] } = useQuery({ queryKey: ['ai-tokens'], queryFn: () => aiConnectionsApi.listTokens().then((r) => r.data) });
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data) });
  const create = useMutation({
    meta: { inlineError: true },
    mutationFn: () => aiConnectionsApi.createToken({ name: name.trim(), expires_days: expires ? parseInt(expires, 10) : undefined, site_ids: allSites ? null : chosen }),
    onSuccess: (r) => { setNewToken(r.data.token); setName(''); setExpires(''); qc.invalidateQueries({ queryKey: ['ai-tokens'] }); },
  });
  const del = useMutation({ mutationFn: (id: number) => aiConnectionsApi.deleteToken(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-tokens'] }) });

  const days = expires ? Number(expires) : null;
  const createProblem = !name.trim() ? null
    : days !== null && (!Number.isInteger(days) || days < 1 || days > 3650) ? 'Expiry must be 1 to 3650 days, or blank for never.'
    : !allSites && chosen.length === 0 ? 'Choose at least one site.' : null;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI connection tokens</h3>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          One per tool, so each can be revoked on its own. These reach only the AI connection endpoints; the rest of the
          API refuses them, and API tokens from Automation don&apos;t work here.
        </p>
        {newToken && (
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-3">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-green-700 dark:text-green-400">
              <Check className="w-4 h-4" />Token made. Copy it now: it won&apos;t be shown again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 px-2 py-1.5 rounded bg-white dark:bg-slate-800 font-mono text-xs break-all text-gray-800 dark:text-slate-200">{newToken}</code>
              <CopyButton text={newToken} />
              <button type="button" className="p-1.5 text-gray-400 hover:text-gray-600" onClick={() => setNewToken(null)} title="Hide"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div><label className="label">Name</label><input className="input w-48" value={name} onChange={(e) => setName(e.target.value)} placeholder="open-webui" maxLength={100} /></div>
            <div><label className="label">Expires (days)</label><input type="number" min={1} max={3650} className="input w-28" value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="never" /></div>
            <button type="button" className="btn-primary flex items-center gap-1.5" disabled={!name.trim() || !!createProblem || create.isPending} onClick={() => create.mutate()}>
              <Plus className="w-4 h-4" />Create
            </button>
          </div>
          <div>
            <div className="label">Sites it can see</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-slate-300">
              <label className="flex items-center gap-1.5"><input type="radio" checked={allSites} onChange={() => setAllSites(true)} />All sites</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={!allSites} onChange={() => setAllSites(false)} />Only these:</label>
            </div>
            {!allSites && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-slate-300">
                {sites.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={chosen.includes(s.id)}
                      onChange={(e) => setChosen((c) => e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id))} />{s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          {createProblem && <p className="text-xs text-red-600 dark:text-red-400">{createProblem}</p>}
          {create.isError && <p className="text-xs text-red-600 dark:text-red-400">{errorText(create.error, 'Could not create the token.')}</p>}
        </div>

        {tokens.length > 0 && (
          <div className="divide-y divide-gray-100 dark:divide-slate-700/50 -mx-1">
            {tokens.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 px-1">
                <code className="font-mono text-xs text-gray-500 dark:text-slate-400">{t.prefix}…</code>
                <span className="text-sm font-medium text-gray-900 dark:text-white">{t.name}</span>
                <span className="text-xs text-gray-500 dark:text-slate-400">{t.site_ids ? (t.site_names.length ? t.site_names.join(', ') : 'no sites left') : 'all sites'}</span>
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  {t.last_used_at ? `used ${formatDistanceToNow(new Date(t.last_used_at))} ago` : 'never used'}
                  {t.expires_at ? ` · expires ${formatDistanceToNow(new Date(t.expires_at), { addSuffix: true })}` : ''}
                </span>
                <button type="button" className="ml-auto p-1.5 text-gray-400 hover:text-red-600" title="Revoke"
                  onClick={() => { if (confirm(`Revoke the AI connection token "${t.name}"? The tool using it stops working at once.`)) del.mutate(t.id); }}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
