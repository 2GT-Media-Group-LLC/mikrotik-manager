import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings, Users, Key, Plus, Trash2, CheckCircle, AlertCircle, Pencil, X,
  ShieldCheck, ShieldAlert, RefreshCw, Upload, Lock, Bell, Send, KeyRound,
} from 'lucide-react';
import { settingsApi, authApi, certApi, alertsApi } from '../services/api';
import type { CertInfo, AlertRule, AlertChannel } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import type { User, UserRole } from '../types';
import clsx from 'clsx';
import CredentialPresetsSettings from '../components/settings/CredentialPresetsSettings';

const ROLE_META: Record<UserRole, { label: string; color: string; desc: string }> = {
  admin:    { label: 'Admin',    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',    desc: 'Full access including user management' },
  operator: { label: 'Operator', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400', desc: 'Manage devices and configs, no user admin' },
  viewer:   { label: 'Viewer',   color: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',   desc: 'Read-only access' },
};

function RoleBadge({ role }: { role: string }) {
  const meta = ROLE_META[role as UserRole] ?? ROLE_META.viewer;
  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', meta.color)}>
      {meta.label}
    </span>
  );
}

interface EditUserState {
  id: number;
  username: string;
  currentRole: UserRole;
  role: UserRole;
  password: string;
  confirmPassword: string;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const isAdmin = user?.role === 'admin';
  const canWrite = user?.role !== 'viewer';
  const [activeTab, setActiveTab] = useState<'general' | 'users' | 'credentials' | 'security' | 'certificate' | 'alerting'>('general');

  // ─── App settings ─────────────────────────────────────────────────────────
  const { data: settings = {} } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => settingsApi.update(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  // ─── Users ────────────────────────────────────────────────────────────────
  const { data: users = [] } = useQuery({
    queryKey: ['settings-users'],
    queryFn: () => settingsApi.getUsers().then((r) => r.data as User[]),
  });

  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' as UserRole });
  const [userError, setUserError] = useState('');
  const [userSuccess, setUserSuccess] = useState('');
  const [editUser, setEditUser] = useState<EditUserState | null>(null);
  const [editError, setEditError] = useState('');

  const createUserMutation = useMutation({
    mutationFn: () => settingsApi.createUser(newUser),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-users'] });
      setNewUser({ username: '', password: '', role: 'viewer' });
      setUserSuccess('User created successfully');
      setUserError('');
      setTimeout(() => setUserSuccess(''), 3000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUserError(msg || 'Failed to create user');
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { role?: string; password?: string } }) =>
      settingsApi.updateUser(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-users'] });
      setEditUser(null);
      setEditError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setEditError(msg || 'Failed to update user');
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: number) => settingsApi.deleteUser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings-users'] }),
  });

  const handleUpdateUser = () => {
    if (!editUser) return;
    if (editUser.password && editUser.password !== editUser.confirmPassword) {
      setEditError('Passwords do not match');
      return;
    }
    const data: { role?: string; password?: string } = {};
    if (editUser.role !== editUser.currentRole) data.role = editUser.role;
    if (editUser.password) data.password = editUser.password;
    if (!data.role && !data.password) {
      setEditUser(null);
      return;
    }
    updateUserMutation.mutate({ id: editUser.id, data });
  };

  // ─── Password change ───────────────────────────────────────────────────────
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  const changePasswordMutation = useMutation({
    mutationFn: () => authApi.changePassword(pwForm.current, pwForm.next),
    onSuccess: () => {
      setPwForm({ current: '', next: '', confirm: '' });
      setPwSuccess('Password changed successfully');
      setPwError('');
      setTimeout(() => setPwSuccess(''), 3000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setPwError(msg || 'Failed to change password');
    },
  });

  // ─── Certificate ──────────────────────────────────────────────────────────
  const { data: certInfo, isLoading: certLoading } = useQuery({
    queryKey: ['cert'],
    queryFn: () => certApi.get().then((r) => r.data as CertInfo),
    enabled: activeTab === 'certificate',
  });

  const [certUpload, setCertUpload] = useState({ certificate: '', private_key: '' });
  const [certError, setCertError] = useState('');
  const [certSuccess, setCertSuccess] = useState('');
  const certFileRef = useRef<HTMLInputElement>(null);
  const keyFileRef = useRef<HTMLInputElement>(null);

  const regenerateMutation = useMutation({
    mutationFn: () => certApi.regenerate(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cert'] });
      setCertSuccess('Self-signed certificate regenerated. Nginx will reload in a few seconds.');
      setCertError('');
      setTimeout(() => setCertSuccess(''), 6000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setCertError(msg || 'Failed to regenerate certificate');
    },
  });

  const uploadMutation = useMutation({
    mutationFn: () => certApi.upload(certUpload.certificate, certUpload.private_key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cert'] });
      setCertUpload({ certificate: '', private_key: '' });
      setCertSuccess('Certificate installed. Nginx will reload in a few seconds.');
      setCertError('');
      setTimeout(() => setCertSuccess(''), 6000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setCertError(msg || 'Failed to install certificate');
    },
  });

  const readFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });

  // ─── Alerting ──────────────────────────────────────────────────────────────
  const { data: alertRules = [] } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => alertsApi.getRules().then((r) => r.data),
    enabled: activeTab === 'alerting',
  });

  const { data: alertChannels = [] } = useQuery({
    queryKey: ['alert-channels'],
    queryFn: () => alertsApi.getChannels().then((r) => r.data),
    enabled: activeTab === 'alerting',
  });

  const { data: alertHistory = [] } = useQuery({
    queryKey: ['alert-history'],
    queryFn: () => alertsApi.getHistory(20).then((r) => r.data),
    enabled: activeTab === 'alerting',
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ type, data }: { type: string; data: Partial<AlertRule> }) =>
      alertsApi.updateRule(type, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alert-rules'] }),
  });

  type ChannelFormState = {
    name: string;
    type: AlertChannel['type'];
    enabled: boolean;
    config: Record<string, unknown>;
  };

  const EMPTY_FORM: ChannelFormState = { name: '', type: 'slack', enabled: true, config: {} };
  const [chModal, setChModal] = useState<{ mode: 'add' | 'edit'; id?: number } | null>(null);
  const [chForm, setChForm] = useState<ChannelFormState>(EMPTY_FORM);
  const [chError, setChError] = useState('');
  const [chTestStatus, setChTestStatus] = useState<Record<number, 'idle' | 'testing' | 'ok' | 'err'>>({});
  const [chTestMsg, setChTestMsg] = useState<Record<number, string>>({});

  const saveChannelMutation = useMutation({
    mutationFn: () =>
      chModal?.mode === 'edit' && chModal.id != null
        ? alertsApi.updateChannel(chModal.id, chForm)
        : alertsApi.createChannel(chForm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-channels'] });
      setChModal(null);
      setChForm(EMPTY_FORM);
      setChError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setChError(msg || 'Failed to save channel');
    },
  });

  const deleteChannelMutation = useMutation({
    mutationFn: (id: number) => alertsApi.deleteChannel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alert-channels'] }),
  });

  const testChannel = async (id: number) => {
    setChTestStatus((s) => ({ ...s, [id]: 'testing' }));
    setChTestMsg((s) => ({ ...s, [id]: '' }));
    try {
      await alertsApi.testChannel(id);
      setChTestStatus((s) => ({ ...s, [id]: 'ok' }));
      setChTestMsg((s) => ({ ...s, [id]: 'Test message sent!' }));
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Test failed';
      setChTestStatus((s) => ({ ...s, [id]: 'err' }));
      setChTestMsg((s) => ({ ...s, [id]: msg }));
    }
    setTimeout(() => setChTestStatus((s) => ({ ...s, [id]: 'idle' })), 6000);
  };

  const RULE_LABELS: Record<string, string> = {
    device_offline: 'Device goes offline',
    device_online: 'Device comes back online',
    log_error: 'Log error detected',
    log_warning: 'Log warning detected',
    high_cpu: 'High CPU usage',
    high_memory: 'High memory usage',
    cert_expiry: 'Certificate expiring soon',
    device_discovered: 'New device discovered',
  };

  const cfgStr = (key: string) => (chForm.config[key] as string) ?? '';
  const setCfg = (key: string, val: unknown) =>
    setChForm((f) => ({ ...f, config: { ...f.config, [key]: val } }));

  const tabs = [
    { key: 'general' as const, label: 'General', icon: Settings },
    { key: 'users' as const, label: 'Users & Roles', icon: Users },
    { key: 'credentials' as const, label: 'Device Credentials', icon: KeyRound },
    { key: 'security' as const, label: 'My Password', icon: Key },
    { key: 'certificate' as const, label: 'Certificate', icon: Lock },
    { key: 'alerting' as const, label: 'Alerting', icon: Bell },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">Settings</h1>

      <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px flex items-center gap-2',
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── General ── */}
      {activeTab === 'general' && (
        <div className="space-y-4 max-w-lg">
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Appearance</h3>
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Theme</label>
                <p className="text-xs text-gray-400 dark:text-slate-500">Choose your preferred color scheme</p>
              </div>
              <div className="flex gap-2">
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors capitalize',
                      theme === t
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-400'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Polling Intervals</h3>
            <div className="space-y-3">
              {[
                { key: 'polling_fast_interval', label: 'Fast poll (interface stats, clients)', unit: 'sec' },
                { key: 'polling_slow_interval', label: 'Slow poll (config, VLANs)', unit: 'sec' },
                { key: 'polling_logs_interval', label: 'Log poll (events)', unit: 'sec' },
              ].map(({ key, label, unit }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-700 dark:text-slate-300">{label}</div>
                    <div className="text-xs text-gray-400">{unit}</div>
                  </div>
                  <input
                    type="number"
                    className="input w-24 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                    value={settings[key] as number ?? ''}
                    onChange={(e) =>
                      updateSettingsMutation.mutate({ [key]: parseInt(e.target.value) })
                    }
                    min="10"
                    step="10"
                    disabled={!isAdmin}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* MAC Scan */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">MAC Scan</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Runs <code className="font-mono">/tool/mac-scan</code> on each switch to map MAC addresses to IP addresses, enriching the Clients section.
            </p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable MAC scan</div>
                </div>
                <button
                  onClick={() => isAdmin && updateSettingsMutation.mutate({ mac_scan_enabled: !settings['mac_scan_enabled'] })}
                  disabled={!isAdmin}
                  className={clsx(
                    'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                    isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                    settings['mac_scan_enabled'] ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                  )}
                >
                  <span className={clsx(
                    'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                    settings['mac_scan_enabled'] ? 'translate-x-5' : 'translate-x-0'
                  )} />
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Scan interval</div>
                  <div className="text-xs text-gray-400">seconds</div>
                </div>
                <input
                  type="number"
                  className="input w-24 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  value={settings['mac_scan_interval'] as number ?? 300}
                  onChange={(e) =>
                    updateSettingsMutation.mutate({ mac_scan_interval: parseInt(e.target.value) })
                  }
                  min="60"
                  step="30"
                  disabled={!isAdmin || !settings['mac_scan_enabled']}
                />
              </div>
            </div>
          </div>

          {/* Reverse DNS */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Reverse DNS Lookup</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Performs PTR record lookups on client IP addresses to resolve hostnames. Runs every 5 minutes, filling in clients that have an IP but no hostname.
            </p>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable reverse DNS</div>
              <button
                onClick={() => isAdmin && updateSettingsMutation.mutate({ reverse_dns_enabled: !settings['reverse_dns_enabled'] })}
                disabled={!isAdmin}
                className={clsx(
                  'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                  isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                  settings['reverse_dns_enabled'] ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                )}
              >
                <span className={clsx(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                  settings['reverse_dns_enabled'] ? 'translate-x-5' : 'translate-x-0'
                )} />
              </button>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Data Retention</h3>
            <div className="space-y-3">
              {[
                { key: 'retention_events_days', label: 'Events retention', desc: 'Auto-delete event log entries older than this many days' },
                { key: 'retention_clients_days', label: 'Client retention', desc: 'Auto-delete inactive client records not seen within this many days' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-700 dark:text-slate-300">{label}</div>
                    <div className="text-xs text-gray-400">{desc}</div>
                  </div>
                  <input
                    type="number"
                    className="input w-24 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                    value={settings[key] as number ?? ''}
                    onChange={(e) =>
                      updateSettingsMutation.mutate({ [key]: parseInt(e.target.value) })
                    }
                    min="1"
                    max="365"
                    disabled={!isAdmin}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Users ── */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          {/* Role legend */}
          <div className="card p-4">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              Role Permissions
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {(Object.entries(ROLE_META) as [UserRole, typeof ROLE_META[UserRole]][]).map(([role, meta]) => (
                <div key={role} className="flex items-start gap-2">
                  <RoleBadge role={role} />
                  <span className="text-xs text-gray-500 dark:text-slate-400">{meta.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Users table */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                System Users ({(users as User[]).length})
              </h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Username</th>
                  <th className="table-header px-4 py-2.5 text-left">Role</th>
                  <th className="table-header px-4 py-2.5 text-left">Created</th>
                  <th className="table-header px-4 py-2.5 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {(users as User[]).map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                      {u.username}
                      {u.id === user?.id && (
                        <span className="ml-2 text-xs text-blue-500">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {isAdmin && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setEditError('');
                              setEditUser({
                                id: u.id,
                                username: u.username,
                                currentRole: u.role,
                                role: u.role,
                                password: '',
                                confirmPassword: '',
                              });
                            }}
                            className="p-1 rounded text-gray-400 hover:text-blue-500 transition-colors"
                            title="Edit user"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {u.id !== user?.id && (
                            <button
                              onClick={() => {
                                if (confirm(`Delete user "${u.username}"?`)) {
                                  deleteUserMutation.mutate(u.id);
                                }
                              }}
                              className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                              title="Delete user"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add user form */}
          {isAdmin && <div className="card p-5 max-w-lg">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Add User</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Username</label>
                  <input
                    className="input"
                    value={newUser.username}
                    onChange={(e) => setNewUser((f) => ({ ...f, username: e.target.value }))}
                    placeholder="username"
                  />
                </div>
                <div>
                  <label className="label">Role</label>
                  <select
                    className="input"
                    value={newUser.role}
                    onChange={(e) => setNewUser((f) => ({ ...f, role: e.target.value as UserRole }))}
                  >
                    <option value="viewer">Viewer (read-only)</option>
                    <option value="operator">Operator</option>
                    <option value="admin">Admin (full access)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Password</label>
                <input
                  type="password"
                  className="input"
                  value={newUser.password}
                  onChange={(e) => setNewUser((f) => ({ ...f, password: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>

              {userError && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {userError}
                </div>
              )}
              {userSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-500">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" /> {userSuccess}
                </div>
              )}

              <button
                onClick={() => createUserMutation.mutate()}
                disabled={!newUser.username || !newUser.password || createUserMutation.isPending}
                className="btn-primary flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add User
              </button>
            </div>
          </div>}
        </div>
      )}

      {/* ── Device Credential Presets ── */}
      {activeTab === 'credentials' && (
        <CredentialPresetsSettings isAdmin={isAdmin} />
      )}

      {/* ── My Password ── */}
      {activeTab === 'security' && (
        <div className="max-w-md">
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Change My Password</h3>
            <div className="space-y-3">
              <div>
                <label className="label">Current Password</label>
                <input
                  type="password"
                  className="input"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="label">New Password</label>
                <input
                  type="password"
                  className="input"
                  value={pwForm.next}
                  onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="label">Confirm New Password</label>
                <input
                  type="password"
                  className="input"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>

              {pwError && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="w-4 h-4" /> {pwError}
                </div>
              )}
              {pwSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-500">
                  <CheckCircle className="w-4 h-4" /> {pwSuccess}
                </div>
              )}

              <button
                onClick={() => {
                  if (pwForm.next !== pwForm.confirm) {
                    setPwError('Passwords do not match');
                    return;
                  }
                  changePasswordMutation.mutate();
                }}
                disabled={
                  !pwForm.current || !pwForm.next || !pwForm.confirm || changePasswordMutation.isPending
                }
                className="btn-primary"
              >
                Change Password
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Certificate ── */}
      {activeTab === 'certificate' && (
        <div className="space-y-4 max-w-2xl">
          {/* Current cert info */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-500" />
              Current Certificate
            </h3>
            {certLoading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : !certInfo?.exists ? (
              <p className="text-sm text-amber-500">No certificate found.</p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="text-gray-500 dark:text-slate-400">Subject</div>
                  <div className="font-medium text-gray-900 dark:text-white">{certInfo.subject}</div>

                  <div className="text-gray-500 dark:text-slate-400">Issuer</div>
                  <div className="text-gray-700 dark:text-slate-300 flex items-center gap-2">
                    {certInfo.issuer}
                    {certInfo.is_self_signed && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        Self-Signed
                      </span>
                    )}
                    {!certInfo.is_self_signed && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        Trusted CA
                      </span>
                    )}
                  </div>

                  <div className="text-gray-500 dark:text-slate-400">Valid From</div>
                  <div className="text-gray-700 dark:text-slate-300">
                    {certInfo.valid_from ? new Date(certInfo.valid_from).toLocaleDateString() : '—'}
                  </div>

                  <div className="text-gray-500 dark:text-slate-400">Expires</div>
                  <div className={clsx(
                    'font-medium',
                    (certInfo.days_remaining ?? 0) < 30 ? 'text-red-500' :
                    (certInfo.days_remaining ?? 0) < 90 ? 'text-amber-500' : 'text-green-600 dark:text-green-400'
                  )}>
                    {certInfo.valid_to ? new Date(certInfo.valid_to).toLocaleDateString() : '—'}
                    {certInfo.days_remaining !== undefined && (
                      <span className="ml-1 font-normal text-xs">
                        ({certInfo.days_remaining > 0 ? `${certInfo.days_remaining} days remaining` : 'EXPIRED'})
                      </span>
                    )}
                  </div>

                  {certInfo.san && (
                    <>
                      <div className="text-gray-500 dark:text-slate-400">SANs</div>
                      <div className="text-xs font-mono text-gray-600 dark:text-slate-400">{certInfo.san}</div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Regenerate self-signed */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-gray-500" />
              Regenerate Self-Signed Certificate
            </h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Generates a new 10-year self-signed certificate. Use this to replace an expired self-signed cert
              or to reset back to defaults. Nginx reloads automatically within a few seconds.
            </p>
            <button
              onClick={() => {
                if (confirm('Regenerate the self-signed certificate? The current certificate will be replaced and nginx will reload.')) {
                  regenerateMutation.mutate();
                }
              }}
              disabled={regenerateMutation.isPending || !isAdmin}
              className="btn-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={clsx('w-4 h-4', regenerateMutation.isPending && 'animate-spin')} />
              {regenerateMutation.isPending ? 'Generating...' : 'Regenerate Self-Signed'}
            </button>
          </div>

          {/* Upload custom cert */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
              <Upload className="w-4 h-4 text-gray-500" />
              Install Custom Certificate
            </h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Paste PEM-encoded certificate and private key, or use the file pickers to load from disk.
              The certificate and key must match. Nginx reloads automatically within a few seconds.
            </p>
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label mb-0">Certificate (PEM)</label>
                  <button
                    type="button"
                    className="text-xs text-blue-500 hover:text-blue-600"
                    onClick={() => certFileRef.current?.click()}
                  >
                    Load from file...
                  </button>
                  <input
                    ref={certFileRef}
                    type="file"
                    accept=".pem,.crt,.cer"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setCertUpload((s) => ({ ...s, certificate: '' }));
                      if (f) {
                        const text = await readFile(f);
                        setCertUpload((s) => ({ ...s, certificate: text }));
                      }
                      e.target.value = '';
                    }}
                  />
                </div>
                <textarea
                  className="input font-mono text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  rows={6}
                  value={certUpload.certificate}
                  onChange={(e) => setCertUpload((s) => ({ ...s, certificate: e.target.value }))}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  spellCheck={false}
                  readOnly={!isAdmin}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label mb-0">Private Key (PEM)</label>
                  <button
                    type="button"
                    className="text-xs text-blue-500 hover:text-blue-600"
                    onClick={() => keyFileRef.current?.click()}
                  >
                    Load from file...
                  </button>
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".pem,.key"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        const text = await readFile(f);
                        setCertUpload((s) => ({ ...s, private_key: text }));
                      }
                      e.target.value = '';
                    }}
                  />
                </div>
                <textarea
                  className="input font-mono text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  rows={6}
                  value={certUpload.private_key}
                  onChange={(e) => setCertUpload((s) => ({ ...s, private_key: e.target.value }))}
                  placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                  spellCheck={false}
                  readOnly={!isAdmin}
                />
              </div>

              {certError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400">{certError}</p>
                </div>
              )}
              {certSuccess && (
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <p className="text-sm text-green-600 dark:text-green-400">{certSuccess}</p>
                </div>
              )}

              <button
                onClick={() => {
                  setCertError('');
                  uploadMutation.mutate();
                }}
                disabled={!certUpload.certificate || !certUpload.private_key || uploadMutation.isPending || !isAdmin}
                className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-4 h-4" />
                {uploadMutation.isPending ? 'Installing...' : 'Install Certificate'}
              </button>
            </div>
          </div>

          <div className="card p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <p className="text-xs text-blue-700 dark:text-blue-300">
              <strong>Note:</strong> HTTP (port 80) automatically redirects to HTTPS (port 443).
              Browser warnings for self-signed certificates are normal and can be bypassed by accepting
              the security exception. Use a CA-signed certificate to eliminate browser warnings.
            </p>
          </div>
        </div>
      )}

      {/* ── Edit user modal ── */}
      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="card w-full max-w-sm mx-4 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Edit User: {editUser.username}
              </h3>
              <button onClick={() => setEditUser(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="label">Role</label>
                <select
                  className="input"
                  value={editUser.role}
                  onChange={(e) => setEditUser((s) => s && ({ ...s, role: e.target.value as UserRole }))}
                  disabled={editUser.id === user?.id}
                >
                  <option value="viewer">Viewer (read-only)</option>
                  <option value="operator">Operator</option>
                  <option value="admin">Admin (full access)</option>
                </select>
                {editUser.id === user?.id && (
                  <p className="text-xs text-gray-400 mt-1">Cannot change your own role</p>
                )}
              </div>

              <div>
                <label className="label">New Password (leave blank to keep current)</label>
                <input
                  type="password"
                  className="input"
                  value={editUser.password}
                  onChange={(e) => setEditUser((s) => s && ({ ...s, password: e.target.value }))}
                  autoComplete="new-password"
                  placeholder="Leave blank to keep unchanged"
                />
              </div>
              {editUser.password && (
                <div>
                  <label className="label">Confirm New Password</label>
                  <input
                    type="password"
                    className="input"
                    value={editUser.confirmPassword}
                    onChange={(e) =>
                      setEditUser((s) => s && ({ ...s, confirmPassword: e.target.value }))
                    }
                    autoComplete="new-password"
                  />
                </div>
              )}

              {editError && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="w-4 h-4" /> {editError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button onClick={() => setEditUser(null)} className="btn-secondary">Cancel</button>
                <button
                  onClick={handleUpdateUser}
                  disabled={updateUserMutation.isPending}
                  className="btn-primary"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Alerting ── */}
      {activeTab === 'alerting' && (
        <div className="space-y-4">

          {/* Alert Rules */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Alert Rules</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Enable or disable each alert event. Threshold and cooldown apply where relevant.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-slate-400 border-b border-gray-100 dark:border-slate-700">
                    <th className="pb-2 pr-4 font-medium">Event</th>
                    <th className="pb-2 pr-4 font-medium text-center">Enabled</th>
                    <th className="pb-2 pr-4 font-medium text-center">Threshold</th>
                    <th className="pb-2 font-medium text-center">Cooldown (min)</th>
                  </tr>
                </thead>
                <tbody className="table-zebra">
                  {alertRules.map((rule) => (
                    <tr key={rule.event_type} className="border-b border-gray-50 dark:border-slate-800">
                      <td className="py-2.5 pr-4 text-gray-700 dark:text-slate-300">
                        {RULE_LABELS[rule.event_type] ?? rule.event_type}
                      </td>
                      <td className="py-2.5 pr-4 text-center">
                        <button
                          onClick={() => canWrite && updateRuleMutation.mutate({ type: rule.event_type, data: { enabled: !rule.enabled, threshold: rule.threshold, cooldown_min: rule.cooldown_min } })}
                          disabled={!canWrite}
                          className={clsx(
                            'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors',
                            canWrite ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                            rule.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                          )}
                        >
                          <span className={clsx('inline-block h-4 w-4 transform rounded-full bg-white shadow transition', rule.enabled ? 'translate-x-4' : 'translate-x-0')} />
                        </button>
                      </td>
                      <td className="py-2.5 pr-4 text-center">
                        {['high_cpu', 'high_memory', 'cert_expiry'].includes(rule.event_type) ? (
                          <input
                            type="number"
                            className="input w-20 text-center py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                            value={rule.threshold ?? ''}
                            onChange={(e) => updateRuleMutation.mutate({ type: rule.event_type, data: { enabled: rule.enabled, threshold: parseInt(e.target.value) || null, cooldown_min: rule.cooldown_min } })}
                            min="1"
                            disabled={!canWrite}
                          />
                        ) : (
                          <span className="text-gray-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-center">
                        <input
                          type="number"
                          className="input w-20 text-center py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                          value={rule.cooldown_min}
                          onChange={(e) => updateRuleMutation.mutate({ type: rule.event_type, data: { enabled: rule.enabled, threshold: rule.threshold, cooldown_min: parseInt(e.target.value) || 15 } })}
                          min="1"
                          disabled={!canWrite}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Alert Channels */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">Alert Channels</h3>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Where to send alerts — email, Slack, Discord, or Telegram.</p>
              </div>
              {canWrite && (
                <button
                  className="btn-primary text-xs flex items-center gap-1"
                  onClick={() => { setChForm(EMPTY_FORM); setChError(''); setChModal({ mode: 'add' }); }}
                >
                  <Plus className="w-3.5 h-3.5" /> Add Channel
                </button>
              )}
            </div>

            {alertChannels.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">No channels configured yet.</p>
            ) : (
              <div className="space-y-2">
                {alertChannels.map((ch) => (
                  <div key={ch.id} className="p-3 rounded-lg border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 space-y-2">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-800 dark:text-white">{ch.name}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-400 uppercase">{ch.type}</span>
                          {!ch.enabled && <span className="text-xs text-amber-500">disabled</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          className={clsx(
                            'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                            chTestStatus[ch.id] === 'ok'
                              ? 'border-green-400 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
                              : chTestStatus[ch.id] === 'err'
                              ? 'border-red-400 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'
                              : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400'
                          )}
                          onClick={() => testChannel(ch.id)}
                          disabled={chTestStatus[ch.id] === 'testing'}
                        >
                          {chTestStatus[ch.id] === 'testing' ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : chTestStatus[ch.id] === 'ok' ? (
                            <CheckCircle className="w-3 h-3" />
                          ) : chTestStatus[ch.id] === 'err' ? (
                            <AlertCircle className="w-3 h-3" />
                          ) : (
                            <Send className="w-3 h-3" />
                          )}
                          {chTestStatus[ch.id] === 'testing' ? 'Testing…' : chTestStatus[ch.id] === 'ok' ? 'Sent!' : chTestStatus[ch.id] === 'err' ? 'Failed' : 'Test'}
                        </button>
                        {canWrite && (
                          <button
                            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-400 hover:text-blue-500 transition-colors"
                            title="Edit channel"
                            onClick={() => {
                              setChForm({ name: ch.name, type: ch.type, enabled: ch.enabled, config: ch.config });
                              setChError('');
                              setChModal({ mode: 'edit', id: ch.id });
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {canWrite && (
                          <button
                            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-400 hover:text-red-500 transition-colors"
                            title="Delete channel"
                            onClick={() => { if (confirm(`Delete channel "${ch.name}"?`)) deleteChannelMutation.mutate(ch.id); }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {chTestMsg[ch.id] && (
                      <p className={clsx('text-xs pl-0.5', chTestStatus[ch.id] === 'err' ? 'text-red-500' : 'text-green-600 dark:text-green-400')}>
                        {chTestMsg[ch.id]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Alert History */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Recent Alert History</h3>
            {alertHistory.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">No alerts sent yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-100 dark:border-slate-700">
                      <th className="pb-2 pr-3 font-medium">Time</th>
                      <th className="pb-2 pr-3 font-medium">Event</th>
                      <th className="pb-2 pr-3 font-medium">Device</th>
                      <th className="pb-2 pr-3 font-medium">Message</th>
                      <th className="pb-2 font-medium">Channels</th>
                    </tr>
                  </thead>
                  <tbody className="table-zebra">
                    {alertHistory.map((h) => (
                      <tr key={h.id} className="border-b border-gray-50 dark:border-slate-800">
                        <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                          {new Date(h.sent_at).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 font-mono text-gray-600 dark:text-slate-300 whitespace-nowrap">
                          {h.event_type}
                        </td>
                        <td className="py-2 pr-3 text-gray-500 dark:text-slate-400">{h.device_name ?? '—'}</td>
                        <td className="py-2 pr-3 text-gray-700 dark:text-slate-300 max-w-xs truncate">{h.message}</td>
                        <td className="py-2 text-gray-500 dark:text-slate-400">
                          {(h.channels_notified ?? []).join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Channel Modal ── */}
      {chModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-lg overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-slate-700">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                {chModal.mode === 'add' ? 'Add Alert Channel' : 'Edit Alert Channel'}
              </h3>
              <button onClick={() => setChModal(null)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Name</label>
                <input className="input w-full" value={chForm.name} onChange={(e) => setChForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. My Slack" />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Type</label>
                  <select className="input w-full" value={chForm.type} onChange={(e) => setChForm((f) => ({ ...f, type: e.target.value as AlertChannel['type'], config: {} }))} disabled={chModal.mode === 'edit'}>
                    {(['slack', 'discord', 'telegram', 'email'] as const).map((t) => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end pb-0.5 gap-2">
                  <label className="text-xs font-medium text-gray-600 dark:text-slate-400">Enabled</label>
                  <button
                    type="button"
                    onClick={() => setChForm((f) => ({ ...f, enabled: !f.enabled }))}
                    className={clsx('relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors', chForm.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600')}
                  >
                    <span className={clsx('inline-block h-4 w-4 transform rounded-full bg-white shadow transition', chForm.enabled ? 'translate-x-4' : 'translate-x-0')} />
                  </button>
                </div>
              </div>

              {/* Type-specific config fields */}
              {chForm.type === 'slack' || chForm.type === 'discord' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Webhook URL</label>
                  <input className="input w-full font-mono text-xs" value={cfgStr('webhook_url')} onChange={(e) => setCfg('webhook_url', e.target.value)} placeholder="https://hooks.slack.com/..." />
                </div>
              ) : chForm.type === 'telegram' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Bot Token</label>
                    <input className="input w-full font-mono text-xs" value={cfgStr('bot_token')} onChange={(e) => setCfg('bot_token', e.target.value)} placeholder="123456:ABC-DEF..." />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Chat ID</label>
                    <input className="input w-full" value={cfgStr('chat_id')} onChange={(e) => setCfg('chat_id', e.target.value)} placeholder="-100123456789" />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">SMTP Host</label>
                      <input className="input w-full" value={cfgStr('smtp_host')} onChange={(e) => setCfg('smtp_host', e.target.value)} placeholder="smtp.example.com" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Port</label>
                      <input type="number" className="input w-full" value={(chForm.config['smtp_port'] as number) ?? 587} onChange={(e) => setCfg('smtp_port', parseInt(e.target.value))} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">SMTP User</label>
                      <input className="input w-full" value={cfgStr('smtp_user')} onChange={(e) => setCfg('smtp_user', e.target.value)} placeholder="user@example.com" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">SMTP Password</label>
                      <input type="password" className="input w-full" value={cfgStr('smtp_pass')} onChange={(e) => setCfg('smtp_pass', e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">From Address</label>
                    <input className="input w-full" value={cfgStr('from_address')} onChange={(e) => setCfg('from_address', e.target.value)} placeholder="alerts@example.com" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Recipients (comma-separated)</label>
                    <input
                      className="input w-full"
                      value={(chForm.config['recipients'] as string[] | undefined)?.join(', ') ?? ''}
                      onChange={(e) => setCfg('recipients', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                      placeholder="admin@example.com, noc@example.com"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="smtp_secure" checked={!!(chForm.config['smtp_secure'])} onChange={(e) => setCfg('smtp_secure', e.target.checked)} className="rounded" />
                    <label htmlFor="smtp_secure" className="text-xs text-gray-600 dark:text-slate-400">Use TLS/SSL (port 465)</label>
                  </div>
                </>
              )}

              {chError && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {chError}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2">
                  {chModal?.mode === 'edit' && chModal.id != null && (
                    <>
                      <button
                        type="button"
                        onClick={() => testChannel(chModal.id!)}
                        disabled={chTestStatus[chModal.id!] === 'testing'}
                        className={clsx(
                          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                          chTestStatus[chModal.id!] === 'ok'
                            ? 'border-green-400 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
                            : chTestStatus[chModal.id!] === 'err'
                            ? 'border-red-400 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'
                            : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600'
                        )}
                      >
                        {chTestStatus[chModal.id!] === 'testing' ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : chTestStatus[chModal.id!] === 'ok' ? (
                          <CheckCircle className="w-3.5 h-3.5" />
                        ) : chTestStatus[chModal.id!] === 'err' ? (
                          <AlertCircle className="w-3.5 h-3.5" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        {chTestStatus[chModal.id!] === 'testing' ? 'Testing…' : chTestStatus[chModal.id!] === 'ok' ? 'Sent!' : chTestStatus[chModal.id!] === 'err' ? 'Failed' : 'Send Test'}
                      </button>
                      {chTestMsg[chModal.id!] && (
                        <span className={clsx('text-xs', chTestStatus[chModal.id!] === 'err' ? 'text-red-500' : 'text-green-600 dark:text-green-400')}>
                          {chTestMsg[chModal.id!]}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setChModal(null)} className="btn-secondary">Cancel</button>
                  <button
                    onClick={() => saveChannelMutation.mutate()}
                    disabled={!chForm.name || saveChannelMutation.isPending}
                    className="btn-primary"
                  >
                    {saveChannelMutation.isPending ? 'Saving...' : 'Save Channel'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
