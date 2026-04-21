import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, KeyRound, X, AlertCircle, CheckCircle, Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  credentialPresetsApi,
  type CredentialPreset,
  type CredentialPresetInput,
} from '../../services/api';

interface FormState {
  name: string;
  api_username: string;
  api_password: string;
  api_port: string;
  ssh_username: string;
  ssh_password: string;
  ssh_port: string;
  notes: string;
  clear_ssh_password: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  api_username: 'admin',
  api_password: '',
  api_port: '8728',
  ssh_username: '',
  ssh_password: '',
  ssh_port: '22',
  notes: '',
  clear_ssh_password: false,
};

function toInput(f: FormState, isEdit: boolean): CredentialPresetInput {
  const input: CredentialPresetInput = {
    name: f.name || undefined,
    api_username: f.api_username || undefined,
    api_port: f.api_port ? parseInt(f.api_port, 10) : null,
    ssh_username: f.ssh_username || null,
    ssh_port: f.ssh_port ? parseInt(f.ssh_port, 10) : null,
    notes: f.notes || null,
  };
  if (f.api_password) input.api_password = f.api_password;
  if (f.ssh_password) input.ssh_password = f.ssh_password;
  else if (isEdit && f.clear_ssh_password) input.clear_ssh_password = true;
  return input;
}

export default function CredentialPresetsSettings({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: presets = [], isLoading } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
  });

  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; id: number }>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState('');

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setError('');
    setModal({ mode: 'add' });
  };

  const openEdit = (p: CredentialPreset) => {
    setForm({
      name: p.name,
      api_username: p.api_username,
      api_password: '',
      api_port: p.api_port != null ? String(p.api_port) : '',
      ssh_username: p.ssh_username ?? '',
      ssh_password: '',
      ssh_port: p.ssh_port != null ? String(p.ssh_port) : '',
      notes: p.notes ?? '',
      clear_ssh_password: false,
    });
    setError('');
    setModal({ mode: 'edit', id: p.id });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!modal) return;
      if (modal.mode === 'add') {
        if (!form.name || !form.api_username || !form.api_password) {
          throw new Error('Name, API username and password are required');
        }
        await credentialPresetsApi.create(toInput(form, false));
      } else {
        await credentialPresetsApi.update(modal.id, toInput(form, true));
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-presets'] });
      setModal(null);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err as Error)?.message ?? 'Failed to save preset';
      setError(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => credentialPresetsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credential-presets'] }),
  });

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-blue-500" />
              Device Credential Presets
            </h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
              Reusable RouterOS API &amp; SSH credential sets. When adding a
              discovered device you can pick a preset instead of retyping the
              same username and password. Passwords are encrypted at rest and
              never returned to the browser.
            </p>
          </div>
          {isAdmin && (
            <button
              className="btn-primary text-xs flex items-center gap-1 flex-shrink-0"
              onClick={openAdd}
            >
              <Plus className="w-3.5 h-3.5" /> Add Preset
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-sm text-gray-400 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading presets…
          </div>
        ) : presets.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 dark:text-slate-500 text-center">
            No credential presets yet.
            {isAdmin && ' Click "Add Preset" to create your first one.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">API</th>
                <th className="table-header px-4 py-2.5 text-left">SSH</th>
                <th className="table-header px-4 py-2.5 text-left">Notes</th>
                <th className="table-header px-4 py-2.5 w-24" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {presets.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                    {p.name}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                    <div className="font-mono">{p.api_username}</div>
                    <div className="text-gray-400 dark:text-slate-500">
                      port {p.api_port ?? 8728}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                    {p.ssh_username ? (
                      <>
                        <div className="font-mono">{p.ssh_username}</div>
                        <div className="text-gray-400 dark:text-slate-500">
                          port {p.ssh_port ?? 22}
                          {p.has_ssh_password ? '' : ' · no password'}
                        </div>
                      </>
                    ) : (
                      <span className="text-gray-300 dark:text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 max-w-xs truncate">
                    {p.notes || <span className="text-gray-300 dark:text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {isAdmin && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(p)}
                          className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          title="Edit preset"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete credential preset "${p.name}"? Devices already using these credentials keep working — presets are not linked after use.`)) {
                              deleteMutation.mutate(p.id);
                            }
                          }}
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          title="Delete preset"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {modal.mode === 'add' ? 'Add Credential Preset' : 'Edit Credential Preset'}
              </h2>
              <button
                onClick={() => setModal(null)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="label">Preset Name *</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Default MikroTik (admin)"
                />
              </div>

              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  RouterOS API
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Username *</label>
                    <input
                      className="input"
                      value={form.api_username}
                      onChange={(e) => set('api_username', e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="label">API Port</label>
                    <input
                      className="input"
                      type="number"
                      value={form.api_port}
                      onChange={(e) => set('api_port', e.target.value)}
                      placeholder="8728"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="label">
                      Password {modal.mode === 'edit' && '(leave blank to keep current)'}
                      {modal.mode === 'add' && ' *'}
                    </label>
                    <input
                      className="input"
                      type="password"
                      value={form.api_password}
                      onChange={(e) => set('api_password', e.target.value)}
                      autoComplete="new-password"
                      placeholder={modal.mode === 'edit' ? '••••••••' : ''}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  SSH (optional, for backups)
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Username</label>
                    <input
                      className="input"
                      value={form.ssh_username}
                      onChange={(e) => set('ssh_username', e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="label">SSH Port</label>
                    <input
                      className="input"
                      type="number"
                      value={form.ssh_port}
                      onChange={(e) => set('ssh_port', e.target.value)}
                      placeholder="22"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="label">
                      Password {modal.mode === 'edit' && '(leave blank to keep current)'}
                    </label>
                    <input
                      className="input"
                      type="password"
                      value={form.ssh_password}
                      onChange={(e) => set('ssh_password', e.target.value)}
                      autoComplete="new-password"
                    />
                    {modal.mode === 'edit' && (
                      <label className="flex items-center gap-1.5 mt-2 text-xs text-gray-500 dark:text-slate-400 select-none">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={form.clear_ssh_password}
                          disabled={!!form.ssh_password}
                          onChange={(e) => set('clear_ssh_password', e.target.checked)}
                        />
                        Remove saved SSH password
                      </label>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="label">Notes</label>
                <textarea
                  className="input"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  placeholder="Optional — e.g. which sites these credentials apply to"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={() => setModal(null)} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className={clsx('btn-primary flex items-center gap-2')}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4" />
                  )}
                  {modal.mode === 'add' ? 'Create Preset' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
