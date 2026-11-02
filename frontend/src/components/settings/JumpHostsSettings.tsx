import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, Network, X, AlertCircle, AlertTriangle, CheckCircle, Loader2, PlugZap, ShieldCheck,
} from 'lucide-react';
import {
  jumpHostsApi,
  credentialPresetsApi,
  sitesApi,
  type JumpHost,
  type JumpHostInput,
} from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { parsePort } from '../../utils/parsePort';
import { useSiteView } from '../../hooks/useSiteView';
import { inView, newEntrySite } from '../../utils/siteView';
import { deviceFromJumpHost } from '../../utils/jumpHostDevice';
import { loginNeededAgain, redirectLocked } from '../../utils/jumpHostEdit';
import AddDeviceModal, { type AddDevicePrefill } from '../devices/AddDeviceModal';
import SiteViewNote from './SiteViewNote';

type AuthKind = JumpHost['auth'];

interface FormState {
  name: string;
  /** '' = fleet-wide, else a site id. */
  site_id: string;
  host: string;
  port: string;
  auth: AuthKind;
  username: string;
  password: string;
  private_key: string;
  passphrase: string;
  credential_preset_id: string;
  host_key_fingerprint: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '', site_id: '', host: '', port: '22', auth: 'password', username: '',
  password: '', private_key: '', passphrase: '', credential_preset_id: '', host_key_fingerprint: '', notes: '',
};

const errorText = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (err as Error)?.message ?? fallback;

/** `resendLogin`: a new address needs the login again, so a kept preset is sent too. */
function toInput(f: FormState, editing: JumpHost | null, resendLogin = false): JumpHostInput {
  const input: JumpHostInput = {
    name: f.name.trim() || undefined,
    site_id: f.site_id ? Number(f.site_id) : null,
    host: f.host.trim() || undefined,
    port: f.port ? parsePort(f.port, 22) : null,
    username: f.username.trim() || null,
    notes: f.notes || null,
  };
  if (f.host_key_fingerprint.trim()) input.host_key_fingerprint = f.host_key_fingerprint.trim();
  // A secret is only sent when typed: editing keeps the saved one otherwise.
  if (f.auth === 'preset') {
    if (!editing || resendLogin || editing.auth !== 'preset' || Number(f.credential_preset_id) !== editing.credential_preset_id) {
      input.credential_preset_id = f.credential_preset_id ? Number(f.credential_preset_id) : null;
    }
  } else if (f.auth === 'key' && f.private_key) {
    input.private_key = f.private_key;
    if (f.passphrase) input.passphrase = f.passphrase;
  } else if (f.auth === 'password' && f.password) {
    input.password = f.password;
  }
  return input;
}

/**
 * SSH jump hosts: routers the manager connects through to reach devices it
 * can't reach directly. Managed like credential presets: fleet-wide ones by
 * fleet admins, a site's own by that site's admins.
 */
export default function JumpHostsSettings() {
  const qc = useQueryClient();
  const user = useAuthStore((st) => st.user);
  const siteRoles = (user as { siteRoles?: Record<string, string> } | null)?.siteRoles;
  const fleetAdmin = user?.role === 'admin' && !siteRoles;
  const adminSites = siteRoles ? Object.entries(siteRoles).filter(([, r]) => r === 'admin').map(([id]) => Number(id)) : [];
  const isAdmin = fleetAdmin || adminSites.length > 0;
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data), staleTime: 300_000 });
  const siteChoices = fleetAdmin ? sites : sites.filter((st) => adminSites.includes(st.id));
  const { data: presets = [] } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
    enabled: isAdmin,
  });
  const { data: jumpHosts = [], isLoading } = useQuery({
    queryKey: ['jump-hosts'],
    queryFn: () => jumpHostsApi.list().then((r) => r.data),
    // Its status changes as devices behind it are polled.
    refetchInterval: 30_000,
  });
  // The sites in the site selector, and fleet-wide jump hosts.
  const { view, label } = useSiteView();
  const shown = jumpHosts.filter((j) => inView(j.site_id, view));

  const [editing, setEditing] = useState<null | 'new' | JumpHost>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState('');
  const [rowNote, setRowNote] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  // Add the jump router as a device too, to monitor it.
  const [addAsDevice, setAddAsDevice] = useState(false);
  const [deviceDraft, setDeviceDraft] = useState<{ id: number; prefill: AddDevicePrefill } | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((s) => ({ ...s, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['jump-hosts'] });

  const openAdd = () => {
    setForm({ ...EMPTY_FORM, site_id: newEntrySite(view, siteChoices, fleetAdmin) });
    setAddAsDevice(false);
    setError('');
    setEditing('new');
  };

  const openEdit = (j: JumpHost) => {
    setForm({
      ...EMPTY_FORM,
      name: j.name,
      site_id: j.site_id != null ? String(j.site_id) : '',
      host: j.host,
      port: String(j.port),
      auth: j.auth,
      username: j.username ?? '',
      credential_preset_id: j.credential_preset_id != null ? String(j.credential_preset_id) : '',
      notes: j.notes ?? '',
    });
    setError('');
    setEditing(j);
  };

  const existing = editing && editing !== 'new' ? editing : null;
  // Devices use it: its address, port and host key are a fleet admin's to change.
  const locked = !!existing && redirectLocked(existing, fleetAdmin);
  // A new address or port, from anyone else: the saved login isn't sent there.
  const loginAgain = !!existing && !locked && loginNeededAgain(existing, form, fleetAdmin);
  // A secret of the chosen kind is already saved, so the field may stay blank.
  const secretSaved = !!existing && !loginAgain && existing.auth === form.auth
    && (form.auth === 'password' ? existing.has_password : existing.has_private_key);
  // Presets this jump host may use: fleet-wide ones, or its own site's.
  const presetChoices = presets.filter((p) => p.site_id == null || String(p.site_id) === form.site_id);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form.name.trim() || !form.host.trim()) throw new Error('Name and address are required');
      if (form.auth !== 'preset' && !form.username.trim()) throw new Error('A username is required');
      if (form.auth === 'preset' && !form.credential_preset_id) throw new Error('Choose a credential preset');
      const again = loginAgain ? ' again to change the address or port' : '';
      if (form.auth === 'password' && !form.password && !secretSaved) throw new Error(`Enter the password${again}`);
      if (form.auth === 'key' && !form.private_key && !secretSaved) throw new Error(`Paste the private key${again}`);
      const input = toInput(form, existing, loginAgain);
      if (existing) {
        await jumpHostsApi.update(existing.id, input);
        return null;
      }
      const { data } = await jumpHostsApi.create(input);
      return addAsDevice ? { id: data.id, prefill: deviceFromJumpHost(data, form.password) } : null;
    },
    onSuccess: (draft) => { refresh(); setEditing(null); setDeviceDraft(draft); },
    onError: (err: unknown) => setError(errorText(err, 'Failed to save the jump host')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => jumpHostsApi.delete(id),
    onSuccess: () => refresh(),
    onError: (err: unknown, id) => setRowNote({ id, ok: false, text: errorText(err, 'Failed to delete') }),
  });

  const testMutation = useMutation({
    mutationFn: (id: number) => jumpHostsApi.test(id).then((r) => r.data),
    onMutate: (id) => setRowNote({ id, ok: true, text: 'Connecting…' }),
    onSuccess: (r, id) => {
      setRowNote(r.ok
        ? { id, ok: true, text: `Connected.${r.fingerprint ? ` Host key ${r.fingerprint}` : ''}` }
        : { id, ok: false, text: r.error });
      refresh();
    },
    onError: (err: unknown, id) => setRowNote({ id, ok: false, text: errorText(err, 'The test failed') }),
  });

  const trustMutation = useMutation({
    mutationFn: (id: number) => jumpHostsApi.trustKey(id),
    onSuccess: (_r, id) => { setRowNote({ id, ok: true, text: 'New host key trusted.' }); refresh(); },
    onError: (err: unknown, id) => setRowNote({ id, ok: false, text: errorText(err, 'Failed to trust the key') }),
  });

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Network className="w-4 h-4 text-blue-500" />
              Jump Hosts
            </h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
              Routers the manager connects to over SSH to reach devices it can&apos;t reach directly. Choose one for a
              device in its settings, or as a site&apos;s default for new devices. The API, API-SSL, backups and the
              terminal all go through it; if it is down, its devices show as offline with that reason, never
              connected some other way. The router needs{' '}
              <code className="font-mono text-[11px]">/ip ssh set forwarding-enabled=local</code>.
            </p>
          </div>
          {isAdmin && (
            <button className="btn-primary text-xs flex items-center gap-1 flex-shrink-0" onClick={openAdd}>
              <Plus className="w-3.5 h-3.5" /> Add Jump Host
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="p-6 text-sm text-gray-400 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading jump hosts…
          </div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 dark:text-slate-500 text-center">
            {jumpHosts.length === 0
              ? 'No jump hosts. Every device is connected to directly.'
              : `No jump hosts for ${label ?? 'the sites in view'}.`}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <th className="table-header px-4 py-2.5 text-left">Name</th>
                <th className="table-header px-4 py-2.5 text-left">Site</th>
                <th className="table-header px-4 py-2.5 text-left">Address</th>
                <th className="table-header px-4 py-2.5 text-left">Login</th>
                <th className="table-header px-4 py-2.5 text-left">Host key</th>
                <th className="table-header px-4 py-2.5 text-left">Status</th>
                <th className="table-header px-4 py-2.5 text-right">Devices</th>
                <th className="table-header px-4 py-2.5 w-28" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {shown.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30 align-top">
                  <td className="px-4 py-2.5 cell-primary">
                    {j.name}
                    {rowNote?.id === j.id && (
                      <div className={`mt-1 text-xs font-normal ${rowNote.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {rowNote.text}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
                    {j.site_id != null ? (j.site_name ?? `Site ${j.site_id}`) : 'All sites'}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                    {j.host}:{j.port}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                    {j.auth === 'preset'
                      ? <>Preset <span className="font-medium">{j.credential_preset_name ?? `#${j.credential_preset_id}`}</span></>
                      : <><span className="font-mono">{j.username}</span> · {j.auth === 'key' ? 'key' : 'password'}</>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                    {j.seen_host_key_fingerprint ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" /> Key changed
                        </div>
                        <div className="font-mono break-all" title="The key it presented">{j.seen_host_key_fingerprint}</div>
                        {j.can_manage && (redirectLocked(j, fleetAdmin) ? (
                          <div className="text-[11px] text-gray-400 dark:text-slate-500">
                            Devices use it, so only a fleet admin can trust the new key.
                          </div>
                        ) : (
                          <button
                            className="btn-secondary text-[11px] px-2 py-0.5 flex items-center gap-1"
                            onClick={() => {
                              if (confirm(`Trust the new host key of "${j.name}"?\n\n${j.seen_host_key_fingerprint}\n\nOnly do this after checking it on the router.`)) {
                                trustMutation.mutate(j.id);
                              }
                            }}
                          >
                            <ShieldCheck className="w-3 h-3" /> Trust new key
                          </button>
                        ))}
                      </div>
                    ) : j.host_key_fingerprint ? (
                      <span className="font-mono break-all" title="Pinned host key">{j.host_key_fingerprint}</span>
                    ) : (
                      <span className="text-gray-400 dark:text-slate-500">Pinned on first connect</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                    {j.status === 'connected' && <span className="text-green-600 dark:text-green-400">Connected</span>}
                    {j.status === 'idle' && <span className="text-gray-400 dark:text-slate-500">Not in use</span>}
                    {j.status === 'failing' && (
                      <span className="text-red-600 dark:text-red-400 flex items-center gap-1" title={j.status_error ?? undefined}>
                        <AlertCircle className="w-3.5 h-3.5" /> Unreachable
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-right text-gray-500 dark:text-slate-400">{j.device_count}</td>
                  <td className="px-4 py-2.5">
                    {j.can_manage && (
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => testMutation.mutate(j.id)}
                          disabled={testMutation.isPending && testMutation.variables === j.id}
                          className="p-1.5 rounded text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                          title="Test the connection"
                        >
                          {testMutation.isPending && testMutation.variables === j.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <PlugZap className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => openEdit(j)}
                          className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          title="Edit jump host"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete jump host "${j.name}"?`)) deleteMutation.mutate(j.id);
                          }}
                          disabled={j.device_count > 0}
                          className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                          title={j.device_count > 0 ? 'Devices are reached through it: move them first' : 'Delete jump host'}
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
        {!isLoading && <SiteViewNote label={label} hidden={jumpHosts.length - shown.length} noun="jump hosts" />}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {existing ? 'Edit Jump Host' : 'Add Jump Host'}
              </h2>
              <button
                onClick={() => setEditing(null)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="label">Site</label>
                <select className="input" value={form.site_id} onChange={(e) => set('site_id', e.target.value)}>
                  {fleetAdmin && <option value="">All sites (fleet-wide)</option>}
                  {siteChoices.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
                <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                  A site&apos;s jump host is only offered for devices in that site.
                </p>
              </div>
              <div>
                <label className="label">Name *</label>
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Branch 3 edge router" />
              </div>
              <div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="label">Address *</label>
                    <input className="input font-mono" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="203.0.113.10 or router.example.com" disabled={locked} />
                  </div>
                  <div>
                    <label className="label">SSH Port</label>
                    <input className="input" type="number" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="22" disabled={locked} />
                  </div>
                </div>
                {locked && (
                  <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                    Devices are reached through this jump host, so only a fleet admin can change its address, port or
                    host key: their saved passwords would go to whatever answers there.
                  </p>
                )}
                {loginAgain && form.auth !== 'preset' && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                    Enter the login again to change the address or port. The saved one is only sent to the address it
                    was saved for.
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Login</h3>
                <div className="flex gap-4 mb-3 text-sm text-gray-600 dark:text-slate-300">
                  {(['password', 'key', 'preset'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5 select-none">
                      <input type="radio" name="jump-auth" checked={form.auth === k} onChange={() => set('auth', k)} />
                      {k === 'password' ? 'Password' : k === 'key' ? 'Private key' : 'Credential preset'}
                    </label>
                  ))}
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="label">Username{form.auth !== 'preset' && ' *'}</label>
                    <input
                      className="input"
                      value={form.username}
                      onChange={(e) => set('username', e.target.value)}
                      autoComplete="off"
                      placeholder={form.auth === 'preset' ? "The preset's SSH (else API) username" : ''}
                    />
                  </div>
                  {form.auth === 'password' && (
                    <div>
                      <label className="label">Password {secretSaved ? '(leave blank to keep current)' : '*'}</label>
                      <input
                        className="input"
                        type="password"
                        value={form.password}
                        onChange={(e) => set('password', e.target.value)}
                        autoComplete="new-password"
                        placeholder={secretSaved ? '••••••••' : ''}
                      />
                    </div>
                  )}
                  {form.auth === 'key' && (
                    <>
                      <div>
                        <label className="label">Private key {secretSaved ? '(leave blank to keep current)' : '*'}</label>
                        <textarea
                          className="input font-mono text-xs"
                          rows={4}
                          value={form.private_key}
                          onChange={(e) => set('private_key', e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          spellCheck={false}
                        />
                      </div>
                      <div>
                        <label className="label">Key passphrase</label>
                        <input className="input" type="password" value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)} autoComplete="new-password" />
                      </div>
                    </>
                  )}
                  {form.auth === 'preset' && (
                    <div>
                      <label className="label">Credential preset *</label>
                      <select className="input" value={form.credential_preset_id} onChange={(e) => set('credential_preset_id', e.target.value)}>
                        <option value="">Choose…</option>
                        {presetChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                        Its SSH login is used, or its API login when it has none.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="label">Host key fingerprint</label>
                <input
                  className="input font-mono text-xs"
                  value={form.host_key_fingerprint}
                  onChange={(e) => set('host_key_fingerprint', e.target.value)}
                  placeholder={existing?.host_key_fingerprint ?? 'SHA256:…'}
                  spellCheck={false}
                  // Pinning a first key is open to its admins; replacing one is trusting a new key.
                  disabled={locked && !!existing?.host_key_fingerprint}
                />
                <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                  Optional. Left blank, the key the router presents the first time is pinned, and a different one later
                  stops the connection until you trust it. Changing the address pins the key afresh.
                </p>
              </div>

              <div>
                <label className="label">Notes</label>
                <textarea className="input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              </div>

              {!existing && (
                <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-slate-400 select-none">
                  <input type="checkbox" className="rounded mt-0.5" checked={addAsDevice} onChange={(e) => setAddAsDevice(e.target.checked)} />
                  <span>
                    Also add it as a device, to monitor it
                    <span className="block text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                      Add Device opens next with its name, address, site and login filled in, connected to directly.
                      {form.auth === 'key' && ' Devices log in with a password, so enter its password there.'}
                    </span>
                  </span>
                </label>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={() => setEditing(null)} className="btn-secondary">Cancel</button>
                <button
                  type="button"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="btn-primary flex items-center gap-2"
                >
                  {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  {existing ? 'Save Changes' : 'Create Jump Host'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deviceDraft && (
        <AddDeviceModal
          prefill={deviceDraft.prefill}
          onClose={() => setDeviceDraft(null)}
          onSuccess={() => {
            setRowNote({ id: deviceDraft.id, ok: true, text: 'Added as a device too.' });
            setDeviceDraft(null);
            qc.invalidateQueries({ queryKey: ['devices'] });
          }}
        />
      )}
    </div>
  );
}
