import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, RefreshCw, AlertTriangle } from 'lucide-react';
import { dataCapApi } from '../../services/api';

/**
 * Daily data-cap SMS for carriers that throttle "unlimited" plans.
 *
 * The manual button is the trustworthy half and is therefore always available,
 * independent of the rule being enabled: pressing it does one known thing for a
 * reason the operator already has. The automatic trigger rests on a usage figure
 * we reconstruct from polling, which cannot see traffic during a reboot or
 * before the device was adopted — so it always reads low, and the margin exists
 * to compensate (discussion #85).
 */

const GB = 1024 ** 3;
const fmtGB = (bytes: number) => (bytes / GB).toFixed(2);

export default function DataCapCard({ deviceId, interfaceName }: { deviceId: number; interfaceName: string }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['data-cap', deviceId],
    queryFn: () => dataCapApi.get(deviceId).then(r => r.data),
    refetchInterval: 60_000,
  });

  const rule = data?.rules.find(r => r.interface_name === interfaceName);
  const sends = (data?.sends ?? []).filter(s => s.interface_name === interfaceName);

  const [form, setForm] = useState({
    enabled: false, phone_number: '', thresholdGB: '10', margin_pct: 5,
    reset_hour: 0, reset_minute: 0,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    cooldown_minutes: 60,
  });

  useEffect(() => {
    if (!rule) return;
    setForm({
      enabled: rule.enabled,
      phone_number: rule.phone_number,
      thresholdGB: (Number(rule.threshold_bytes) / GB).toString(),
      margin_pct: rule.margin_pct,
      reset_hour: rule.reset_hour,
      reset_minute: rule.reset_minute,
      timezone: rule.timezone,
      cooldown_minutes: rule.cooldown_minutes,
    });
  }, [rule?.id, rule?.updated_at]);

  const save = useMutation({
    mutationFn: () => dataCapApi.save(deviceId, interfaceName, {
      enabled: form.enabled,
      phone_number: form.phone_number,
      message: '',
      threshold_bytes: Math.round(Number(form.thresholdGB) * GB),
      margin_pct: form.margin_pct,
      reset_hour: form.reset_hour,
      reset_minute: form.reset_minute,
      timezone: form.timezone,
      cooldown_minutes: form.cooldown_minutes,
    }),
    onSuccess: (r) => {
      setResult({ ok: true, text: r.data.message });
      queryClient.invalidateQueries({ queryKey: ['data-cap', deviceId] });
    },
    onError: (e: unknown) => setResult({
      ok: false,
      text: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not save',
    }),
  });

  const sendNow = useMutation({
    mutationFn: () => dataCapApi.sendNow(deviceId, interfaceName),
    onSuccess: (r) => {
      setResult({ ok: true, text: r.data.message });
      queryClient.invalidateQueries({ queryKey: ['data-cap', deviceId] });
    },
    onError: (e: unknown) => setResult({
      ok: false,
      text: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not send',
    }),
  });

  const used = rule ? Number(rule.period_bytes) : 0;
  const cap = Number(form.thresholdGB) * GB || 0;
  const firesAt = cap * (1 - form.margin_pct / 100);
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <MessageSquare className="w-5 h-5 mt-0.5 text-gray-400 dark:text-slate-500" />
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">Data-cap reset SMS</h3>
          <p className="text-sm text-gray-600 dark:text-slate-300 mt-0.5">
            Some carriers throttle an “unlimited” plan past a daily allowance and lift it when you
            text a short code. This tracks usage on <span className="font-mono text-xs">{interfaceName}</span> and
            can send that message for you.
          </p>
        </div>
      </div>

      {/* Usage so far this period */}
      {rule && (
        <div>
          <div className="flex items-baseline justify-between text-xs mb-1">
            <span className="text-gray-500 dark:text-slate-400">
              Counted this period{rule.period_key ? ` (${rule.period_key})` : ''}
            </span>
            <span className="tabular-nums text-gray-900 dark:text-white">
              {fmtGB(used)} / {form.thresholdGB} GB
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
            <div
              className={`h-full rounded-full ${used >= firesAt ? 'bg-amber-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.max(1, pct)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
            Counted from polling, so it reads low — traffic during a reboot or before this device was
            added is invisible to us. Sends at {fmtGB(firesAt)} GB ({form.margin_pct}% early) for that reason,
            and restarts at zero once sent, because that is what the message does to the carrier&rsquo;s counter.
          </p>
        </div>
      )}

      {/* Settings */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Send to</span>
          <input className="input mt-1 w-full text-sm" placeholder="1237"
            value={form.phone_number} onChange={e => setForm({ ...form, phone_number: e.target.value })} />
        </label>
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Allowance (GB)</span>
          <input className="input mt-1 w-full text-sm" type="number" min="0.1" step="0.1"
            value={form.thresholdGB} onChange={e => setForm({ ...form, thresholdGB: e.target.value })} />
        </label>
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Send early by (%)</span>
          <input className="input mt-1 w-full text-sm" type="number" min="0" max="50"
            value={form.margin_pct} onChange={e => setForm({ ...form, margin_pct: Number(e.target.value) })} />
        </label>
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Resets at</span>
          <input className="input mt-1 w-full text-sm" type="time"
            value={`${String(form.reset_hour).padStart(2, '0')}:${String(form.reset_minute).padStart(2, '0')}`}
            onChange={e => {
              const [h, m] = e.target.value.split(':').map(Number);
              setForm({ ...form, reset_hour: h || 0, reset_minute: m || 0 });
            }} />
        </label>
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Timezone</span>
          <input className="input mt-1 w-full text-sm" value={form.timezone}
            onChange={e => setForm({ ...form, timezone: e.target.value })} />
        </label>
        <label className="text-xs">
          <span className="text-gray-500 dark:text-slate-400">Cooldown (min)</span>
          <input className="input mt-1 w-full text-sm" type="number" min="1" max="1440"
            value={form.cooldown_minutes}
            onChange={e => setForm({ ...form, cooldown_minutes: Number(e.target.value) })} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
          <input type="checkbox" checked={form.enabled}
            onChange={e => setForm({ ...form, enabled: e.target.checked })} />
          Send automatically at the threshold
        </label>
        <button className="btn-secondary text-xs" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {/* Always available: this half does not depend on our usage estimate. */}
        <button className="btn-primary text-xs flex items-center gap-1.5 ml-auto"
          onClick={() => sendNow.mutate()} disabled={sendNow.isPending || !form.phone_number}>
          {sendNow.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send now
        </button>
      </div>

      {result && (
        <p className={`text-xs ${result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {result.text}
        </p>
      )}

      {!rule && (
        <div className="flex gap-2 rounded-lg border border-gray-200 p-2 text-[11px] text-gray-500 dark:border-slate-700 dark:text-slate-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            The modem needs SMS enabled — check <span className="font-mono">/tool/sms/print</span> reports
            <span className="font-mono"> receive-enabled: yes</span>. If sent messages are kept on the SIM they
            will eventually fill it, and sending then fails quietly.
          </span>
        </div>
      )}

      {sends.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-900 dark:text-white mb-1">Recent sends</h4>
          <ul className="space-y-1">
            {sends.slice(0, 5).map((s, i) => (
              <li key={i} className="text-[11px] flex flex-wrap gap-x-2">
                <span className="text-gray-500 dark:text-slate-400">
                  {new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-gray-700 dark:text-slate-300">{s.trigger}</span>
                {s.period_bytes != null && (
                  <span className="text-gray-400 dark:text-slate-500">at {fmtGB(Number(s.period_bytes))} GB</span>
                )}
                {s.ok
                  ? <span className="text-green-600 dark:text-green-400">sent</span>
                  : <span className="text-red-600 dark:text-red-400">failed: {s.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
