import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound, Webhook as WebhookIcon, Mail, Plus, Trash2, Copy, Check, Send,
  AlertTriangle, Power, X,
} from 'lucide-react';
import clsx from 'clsx';
import { automationApi } from '../../services/api';
import { formatDistanceToNow } from 'date-fns';

const EVENT_LABEL: Record<string, string> = {
  device_offline: 'Device offline', device_online: 'Device online',
  log_error: 'Log error', log_warning: 'Log warning',
  high_cpu: 'High CPU', high_memory: 'High memory', cert_expiry: 'Cert expiry',
  device_discovered: 'Device discovered', firmware_update_available: 'Firmware update',
  config_drift: 'Config drift', rollout_completed: 'Rollout completed', rollout_failed: 'Rollout failed',
  device_degraded: 'Device degraded', device_health_restored: 'Hardware healthy again',
};

// ─── API tokens ────────────────────────────────────────────────────────────────

function TokensSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [expires, setExpires] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokens = [] } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => automationApi.listTokens().then(r => r.data),
    enabled: isAdmin,
  });
  const create = useMutation({
    mutationFn: () => automationApi.createToken({ name: name.trim(), scope, expires_days: expires ? parseInt(expires, 10) : undefined }),
    onSuccess: (r) => { setNewToken(r.data.token); setName(''); setExpires(''); qc.invalidateQueries({ queryKey: ['api-tokens'] }); },
  });
  const del = useMutation({ mutationFn: (id: number) => automationApi.deleteToken(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }) });

  if (!isAdmin) {
    return <div className="card p-6 text-sm text-gray-400 dark:text-slate-500">API tokens can only be managed by administrators.</div>;
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">API Tokens</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">for scripting &amp; IaC — send as <span className="font-mono">Authorization: Bearer mtm_…</span></span>
      </div>

      <div className="p-5 space-y-4">
        {/* Newly created token (shown once) */}
        {newToken && (
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-3">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-green-700 dark:text-green-400">
              <Check className="w-4 h-4" />Token created — copy it now, it won&apos;t be shown again
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1.5 rounded bg-white dark:bg-slate-800 font-mono text-xs break-all text-gray-800 dark:text-slate-200">{newToken}</code>
              <button className="btn-secondary flex items-center gap-1.5 text-xs" onClick={() => { navigator.clipboard.writeText(newToken); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
              </button>
              <button className="p-1.5 text-gray-400 hover:text-gray-600" onClick={() => setNewToken(null)}><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        {/* Create form */}
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label">Name</label><input className="input w-48" value={name} onChange={e => setName(e.target.value)} placeholder="ci-pipeline" /></div>
          <div><label className="label">Scope</label>
            <select className="input w-32" value={scope} onChange={e => setScope(e.target.value as 'read' | 'write')}>
              <option value="read">Read only</option>
              <option value="write">Read + write</option>
            </select>
          </div>
          <div><label className="label">Expires (days)</label><input type="number" min={1} className="input w-28" value={expires} onChange={e => setExpires(e.target.value)} placeholder="never" /></div>
          <button className="btn-primary flex items-center gap-1.5" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            <Plus className="w-4 h-4" />Create
          </button>
        </div>

        {/* List */}
        {tokens.length > 0 && (
          <div className="divide-y divide-gray-100 dark:divide-slate-700/50 -mx-1">
            {tokens.map(t => (
              <div key={t.id} className="flex items-center gap-3 py-2.5 px-1">
                <code className="font-mono text-xs text-gray-500 dark:text-slate-400">{t.prefix}…</code>
                <span className="text-sm font-medium text-gray-900 dark:text-white">{t.name}</span>
                <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold uppercase', t.scope === 'write' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400')}>{t.scope}</span>
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  {t.last_used_at ? `used ${formatDistanceToNow(new Date(t.last_used_at))} ago` : 'never used'}
                  {t.expires_at ? ` · expires ${formatDistanceToNow(new Date(t.expires_at), { addSuffix: true })}` : ''}
                </span>
                <button className="ml-auto p-1.5 text-gray-400 hover:text-red-600" onClick={() => del.mutate(t.id)} title="Revoke"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 dark:text-slate-500">Write tokens map to Operator privileges; no token can perform admin actions or manage other tokens.</p>
      </div>
    </div>
  );
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────

function WebhooksSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', url: '', secret: '', events: new Set<string>() });
  const [testResult, setTestResult] = useState<Record<number, string>>({});

  const { data } = useQuery({ queryKey: ['webhooks'], queryFn: () => automationApi.listWebhooks().then(r => r.data) });
  const webhooks = data?.webhooks ?? [];
  const events = data?.availableEvents ?? [];

  const create = useMutation({
    mutationFn: () => automationApi.createWebhook({ name: form.name.trim(), url: form.url.trim(), secret: form.secret.trim() || undefined, events: [...form.events] }),
    onSuccess: () => { setForm({ name: '', url: '', secret: '', events: new Set() }); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => automationApi.updateWebhook(id, { enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  const del = useMutation({ mutationFn: (id: number) => automationApi.deleteWebhook(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  const test = useMutation({
    mutationFn: (id: number) => automationApi.testWebhook(id),
    onSuccess: (r, id) => { setTestResult(p => ({ ...p, [id]: r.data.ok ? `OK (${r.data.status})` : `HTTP ${r.data.status}` })); setTimeout(() => setTestResult(p => { const n = { ...p }; delete n[id]; return n; }), 5000); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
    onError: (e: unknown, id) => setTestResult(p => ({ ...p, [id]: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'failed' })),
  });

  const toggleEvent = (e: string) => setForm(f => {
    const s = new Set(f.events);
    if (s.has(e)) s.delete(e); else s.add(e);
    return { ...f, events: s };
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <WebhookIcon className="w-4 h-4 text-violet-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Outbound Webhooks</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">POST JSON on events · HMAC-signed with <span className="font-mono">X-MTM-Signature</span></span>
      </div>

      <div className="p-5 space-y-4">
        {/* existing */}
        {webhooks.map(h => (
          <div key={h.id} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', h.enabled ? 'bg-green-500' : 'bg-gray-400')} />
              <span className="text-sm font-medium text-gray-900 dark:text-white">{h.name}</span>
              {h.has_secret && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">signed</span>}
              {h.last_status != null && <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', h.last_status >= 200 && h.last_status < 300 ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400')}>last: {h.last_status || 'err'}</span>}
              <div className="ml-auto flex items-center gap-1">
                {testResult[h.id] && <span className="text-xs text-gray-500 dark:text-slate-400 mr-1">{testResult[h.id]}</span>}
                <button className="p-1.5 text-gray-400 hover:text-blue-600" title="Send test" onClick={() => test.mutate(h.id)}><Send className="w-3.5 h-3.5" /></button>
                <button className="p-1.5 text-gray-400 hover:text-amber-600" title={h.enabled ? 'Disable' : 'Enable'} onClick={() => toggle.mutate({ id: h.id, enabled: !h.enabled })}><Power className="w-3.5 h-3.5" /></button>
                <button className="p-1.5 text-gray-400 hover:text-red-600" title="Delete" onClick={() => del.mutate(h.id)}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="font-mono text-xs text-gray-500 dark:text-slate-400 truncate">{h.url}</div>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {h.events.map(e => <span key={e} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">{EVENT_LABEL[e] || e}</span>)}
            </div>
          </div>
        ))}

        {/* create */}
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-600 p-3 space-y-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name (e.g. Slack, PagerDuty)" />
            <input className="input sm:col-span-2 font-mono text-sm" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://hooks.example.com/…" />
          </div>
          <input className="input font-mono text-sm" value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} placeholder="Signing secret (optional, recommended)" />
          <div className="flex flex-wrap gap-1.5">
            {events.map(e => (
              <button key={e} onClick={() => toggleEvent(e)}
                className={clsx('text-xs px-2 py-1 rounded-md border transition-colors',
                  form.events.has(e) ? 'bg-violet-100 dark:bg-violet-900/30 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300' : 'border-gray-200 dark:border-slate-600 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700')}>
                {EVENT_LABEL[e] || e}
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <button className="btn-primary flex items-center gap-1.5" disabled={!form.name.trim() || !form.url.trim() || form.events.size === 0 || create.isPending} onClick={() => create.mutate()}>
              <Plus className="w-4 h-4" />Add webhook
            </button>
          </div>
          {create.isError && <p className="text-xs text-red-500 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{(create.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'}</p>}
        </div>
      </div>
    </div>
  );
}

// ─── Scheduled reports ───────────────────────────────────────────────────────────

function ReportsSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', frequency: 'weekly', recipients: '' });
  const [sendMsg, setSendMsg] = useState<Record<number, string>>({});

  const { data: reports = [] } = useQuery({ queryKey: ['report-schedules'], queryFn: () => automationApi.listReports().then(r => r.data) });
  const create = useMutation({
    mutationFn: () => automationApi.createReport(form),
    onSuccess: () => { setForm({ name: '', frequency: 'weekly', recipients: '' }); qc.invalidateQueries({ queryKey: ['report-schedules'] }); },
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => automationApi.updateReport(id, { enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }) });
  const del = useMutation({ mutationFn: (id: number) => automationApi.deleteReport(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }) });
  const sendNow = useMutation({
    mutationFn: (id: number) => automationApi.sendReportNow(id),
    onSuccess: (_r, id) => { setSendMsg(p => ({ ...p, [id]: 'Sent!' })); setTimeout(() => setSendMsg(p => { const n = { ...p }; delete n[id]; return n; }), 4000); qc.invalidateQueries({ queryKey: ['report-schedules'] }); },
    onError: (e: unknown, id) => setSendMsg(p => ({ ...p, [id]: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Send failed' })),
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <Mail className="w-4 h-4 text-emerald-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Scheduled Reports</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">emailed fleet summaries — uses your Alerting SMTP settings</span>
      </div>

      <div className="p-5 space-y-4">
        {reports.map(r => (
          <div key={r.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-slate-700 p-3">
            <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', r.enabled ? 'bg-green-500' : 'bg-gray-400')} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-white">{r.name} <span className="text-xs font-normal text-gray-400 capitalize">· {r.frequency}</span></div>
              <div className="text-xs text-gray-400 dark:text-slate-500 truncate">{r.recipients}</div>
            </div>
            <span className="text-xs text-gray-400 dark:text-slate-500 ml-2">
              {r.last_sent_at ? `last ${formatDistanceToNow(new Date(r.last_sent_at))} ago` : `next ${formatDistanceToNow(new Date(r.next_run_at), { addSuffix: true })}`}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {sendMsg[r.id] && <span className="text-xs text-gray-500 dark:text-slate-400 mr-1">{sendMsg[r.id]}</span>}
              <button className="p-1.5 text-gray-400 hover:text-blue-600" title="Send now" onClick={() => sendNow.mutate(r.id)} disabled={sendNow.isPending}><Send className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 text-gray-400 hover:text-amber-600" title={r.enabled ? 'Disable' : 'Enable'} onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}><Power className="w-3.5 h-3.5" /></button>
              <button className="p-1.5 text-gray-400 hover:text-red-600" title="Delete" onClick={() => del.mutate(r.id)}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}

        <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-600 p-3 flex flex-wrap items-end gap-2">
          <div><label className="label">Name</label><input className="input w-44" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Weekly summary" /></div>
          <div><label className="label">Frequency</label>
            <select className="input w-32" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
          </div>
          <div className="flex-1 min-w-[200px]"><label className="label">Recipients</label><input className="input" value={form.recipients} onChange={e => setForm(f => ({ ...f, recipients: e.target.value }))} placeholder="ops@company.com, noc@company.com" /></div>
          <button className="btn-primary flex items-center gap-1.5" disabled={!form.name.trim() || !form.recipients.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="w-4 h-4" />Add</button>
          {create.isError && <p className="text-xs text-red-500 w-full flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{(create.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed'}</p>}
        </div>
      </div>
    </div>
  );
}

export default function AutomationSettings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="space-y-4">
      <TokensSection isAdmin={isAdmin} />
      <WebhooksSection />
      <ReportsSection />
    </div>
  );
}
