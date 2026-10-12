import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, KeyRound, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { devicesApi, credentialPresetsApi } from '../../services/api';
import { presetsForSite } from '../../hooks/useSitePresets';
import type { Device } from '../../types';

/**
 * Change the login the manager uses for the selected devices (#259): a saved
 * preset, or a username and password. Only the manager's records change; each
 * device is logged in to with the new login first and left alone if that fails.
 */
export default function BulkCredentialsModal({ devices, onClose }: { devices: Device[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [presetId, setPresetId] = useState<number | null>(null);
  const [form, setForm] = useState({ api_username: '', api_password: '', ssh_username: '', ssh_password: '' });
  const [replaceSsh, setReplaceSsh] = useState(false);
  const [error, setError] = useState('');

  const { data: allPresets = [] } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });
  // Only presets every selected device's site can use.
  const sites = useMemo(() => [...new Set(devices.map((d) => d.site_id ?? null))], [devices]);
  const presets = useMemo(
    () => allPresets.filter((p) => sites.every((s) => presetsForSite([p], s).length > 0)),
    [allPresets, sites]);

  const run = useMutation({
    mutationFn: () => devicesApi.bulkCredentials({
      device_ids: devices.map((d) => d.id),
      ...(presetId != null ? { credential_preset_id: presetId } : {
        api_username: form.api_username.trim(),
        api_password: form.api_password,
        ...(replaceSsh ? { ssh_username: form.ssh_username.trim() || null, ssh_password: form.ssh_password || null } : {}),
      }),
    }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
      setError('');
    },
    onError: (err: unknown) => {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not change the login.');
    },
  });

  const canRun = presetId != null || (form.api_username.trim() !== '' && form.api_password !== '');
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const out = run.data;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> Change login for {devices.length} device{devices.length === 1 ? '' : 's'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            The login the manager uses to reach these devices. Nothing changes on the devices themselves.
            Each one is logged in to with the new login first, and keeps its current login if that fails.
          </p>

          {!out && (
            <>
              {presets.length > 0 && (
                <div>
                  <label className="label">Use a saved preset</label>
                  <select className="input" value={presetId ?? ''} onChange={(e) => setPresetId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">— Type a login below —</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.api_username}{p.ssh_username ? ` · SSH ${p.ssh_username}` : ''})</option>
                    ))}
                  </select>
                </div>
              )}
              {presetId == null && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Username *</label>
                    <input className="input" value={form.api_username} onChange={(e) => set('api_username', e.target.value)} autoComplete="off" />
                  </div>
                  <div>
                    <label className="label">Password *</label>
                    <input className="input" type="password" value={form.api_password} onChange={(e) => set('api_password', e.target.value)} autoComplete="new-password" />
                  </div>
                  <label className="col-span-2 flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={replaceSsh} onChange={(e) => setReplaceSsh(e.target.checked)} />
                    Also replace the SSH login (blank uses the login above)
                  </label>
                  {replaceSsh && (
                    <>
                      <div>
                        <label className="label">SSH username</label>
                        <input className="input" value={form.ssh_username} onChange={(e) => set('ssh_username', e.target.value)} autoComplete="off" />
                      </div>
                      <div>
                        <label className="label">SSH password</label>
                        <input className="input" type="password" value={form.ssh_password} onChange={(e) => set('ssh_password', e.target.value)} autoComplete="new-password" />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {out && (
            <div className="space-y-2">
              <p className="text-sm text-gray-700 dark:text-slate-200">
                Changed on {out.updated} of {out.results.length}.{out.failed ? ` ${out.failed} kept their current login.` : ''}
              </p>
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700 border border-gray-200 dark:border-slate-700 rounded-lg">
                {out.results.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                    {r.ok ? <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />}
                    <div>
                      <div className="text-gray-900 dark:text-white">{r.name}</div>
                      {r.error && <div className="text-xs text-red-600 dark:text-red-400">{r.error}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-secondary">{out ? 'Close' : 'Cancel'}</button>
            {!out && (
              <button className="btn-primary flex items-center gap-2" disabled={!canRun || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                {run.isPending ? 'Testing and saving…' : 'Test and save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
