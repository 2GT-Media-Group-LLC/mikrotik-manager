import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Check, X, RefreshCw, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type PollSettings } from '../../services/api';
import { POLL_ROWS, useCanEditPollSettings } from '../common/PollOverridesCard';

type Draft = Record<string, { own: boolean; value: number | boolean }>;

/**
 * The device's polling and backup settings on its Overview (#261): every
 * value in force and where it comes from (this device, its site, or global),
 * always shown. **Edit** works like Physical Details: change what you need,
 * then Save or Cancel at the bottom. A setting this device doesn't override
 * follows its site or the global one.
 */
export default function PollingNote({ deviceId, siteId }: { deviceId: number; siteId: number | null }) {
  const qc = useQueryClient();
  const canEdit = useCanEditPollSettings(siteId);
  const key = ['poll-settings', 'device', deviceId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => devicesApi.getPollSettings(deviceId).then((r) => r.data),
    staleTime: 60_000,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, number | boolean | null>) => devicesApi.setPollSettings(deviceId, body).then((r) => r.data),
    onSuccess: (d: PollSettings) => {
      qc.setQueryData(key, d);
      void qc.invalidateQueries({ queryKey: ['poll-settings'] });
      setDraft(null);
      setError('');
    },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Couldn’t save'),
  });

  if (!data) return null;

  const fromWhere = (src: string) => (src === 'device' ? 'this device' : src === 'site' ? `site ${data.site?.name ?? ''}`.trim() : 'global');
  const show = (v: number | boolean, unit?: string) => (typeof v === 'boolean' ? (v ? 'On' : 'Off') : `${v}${unit ? ` ${unit}` : ''}`);

  const openEdit = () => {
    const d: Draft = {};
    for (const r of POLL_ROWS) {
      const eff = data.effective[r.key];
      if (eff) d[r.key] = { own: r.key in data.overrides, value: eff.value };
    }
    setDraft(d);
    setError('');
  };

  // Only what changed: a new or changed override, or null to inherit again.
  const changes = (): Record<string, number | boolean | null> => {
    const body: Record<string, number | boolean | null> = {};
    if (!draft) return body;
    for (const r of POLL_ROWS) {
      const d = draft[r.key];
      if (!d) continue;
      const had = r.key in data.overrides;
      if (!d.own && had) body[r.key] = null;
      else if (d.own && (!had || data.overrides[r.key] !== d.value)) body[r.key] = d.value;
    }
    return body;
  };
  const pending = draft ? Object.keys(changes()).length : 0;
  const set = (k: string, patch: Partial<Draft[string]>) => setDraft((d) => (d ? { ...d, [k]: { ...d[k], ...patch } } : d));

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Polling and backups</h3>
        {canEdit && !draft && (
          <button onClick={openEdit} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        )}
      </div>

      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
          {POLL_ROWS.map((r) => {
            const eff = data.effective[r.key];
            if (!eff) return null;
            const d = draft?.[r.key];
            const dependsOff = r.dependsOn && (draft?.[r.dependsOn]?.value ?? data.effective[r.dependsOn]?.value) === false;
            return (
              <tr key={r.key} className={clsx(dependsOff && 'opacity-50')}>
                <td className="py-2 pr-3 text-gray-600 dark:text-slate-300">{r.label}</td>
                {!d ? (
                  <>
                    <td className="py-2 pr-3 font-mono text-gray-900 dark:text-white whitespace-nowrap">{show(eff.value, r.unit)}</td>
                    <td className={clsx('py-2 text-xs whitespace-nowrap text-right', eff.source === 'device' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-400')}>
                      {fromWhere(eff.source)}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-1.5 pr-3">
                      {d.own ? (
                        r.bool ? (
                          <select className="input py-1 text-sm w-24" value={d.value ? 'on' : 'off'} aria-label={r.label}
                            onChange={(e) => set(r.key, { value: e.target.value === 'on' })}>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <input type="number" className="input py-1 w-28 text-center" value={String(d.value)} min={r.min} max={r.max} aria-label={r.label}
                              onChange={(e) => set(r.key, { value: e.target.value === '' ? '' as unknown as number : Number(e.target.value) })} />
                            <span className="text-xs text-gray-400">{r.unit}</span>
                          </span>
                        )
                      ) : (
                        <span className="font-mono text-gray-500 dark:text-slate-400">
                          {show((data.inherited?.[r.key] ?? eff).value, r.unit)}
                          <span className="font-sans text-xs text-gray-400"> · {fromWhere((data.inherited?.[r.key] ?? eff).source)}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={d.own}
                          onChange={(e) => set(r.key, { own: e.target.checked, ...(e.target.checked ? {} : { value: (data.inherited?.[r.key] ?? eff).value }) })} />
                        set for this device
                      </label>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {draft && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-gray-400 dark:text-slate-500">
            Unticked settings follow {data.site?.name ? `site ${data.site.name}` : 'the site'} or the global setting.
          </p>
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button onClick={() => save.mutate(changes())} disabled={save.isPending || pending === 0} className="btn-primary flex items-center gap-2 text-sm">
              {save.isPending ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Saving…</> : <><Check className="w-3.5 h-3.5" />Save</>}
            </button>
            <button onClick={() => { setDraft(null); setError(''); }} disabled={save.isPending} className="btn-secondary text-sm">
              <X className="w-3.5 h-3.5 inline mr-1" />Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
