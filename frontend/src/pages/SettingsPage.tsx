import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings, Users, Key, Plus, Trash2, CheckCircle, AlertCircle, Pencil, X,
  ShieldCheck, ShieldAlert, RefreshCw, Upload, Lock, Bell, Send, KeyRound, ClipboardList, FileText, Zap, LogIn,
  Activity,
} from 'lucide-react';
import { settingsApi, authApi, certApi, alertsApi, auditLogApi, tagsApi, maintenanceApi, configTemplatesApi } from '../services/api';
import type { MaintenanceWindow, ConfigTemplate } from '../services/api';
import type { CertInfo, AlertRule, AlertChannel } from '../services/api';
import PollerHealthCard from '../components/system/PollerHealthCard';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import type { User, UserRole } from '../types';
import {
  parseBackupCron, scheduleToCron, describeBackupSchedule, WEEKDAY_NAMES, ordinal,
  type BackupFrequency,
} from '../utils/backupSchedule';
import clsx from 'clsx';
import CredentialPresetsSettings from '../components/settings/CredentialPresetsSettings';
import AutomationSettings from '../components/settings/AutomationSettings';
import OidcSettings from '../components/settings/OidcSettings';

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
  const [activeTab, setActiveTab] = useState<'general' | 'users' | 'sso' | 'credentials' | 'security' | 'certificate' | 'alerting' | 'audit' | 'tags' | 'maintenance' | 'templates' | 'automation' | 'poller'>('general');
  const [auditSearch, setAuditSearch] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6366f1');
  const [mwForm, setMwForm] = useState({ name: '', start_at: '', end_at: '' });

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

  // ─── TOTP / 2FA ────────────────────────────────────────────────────────────
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [totpConfirmCode, setTotpConfirmCode] = useState('');
  const [totpSetupPassword, setTotpSetupPassword] = useState('');
  const [totpDisablePassword, setTotpDisablePassword] = useState('');
  const [totpMsg, setTotpMsg] = useState('');
  const [totpError, setTotpError] = useState('');

  const { data: totpStatus, refetch: refetchTotpStatus } = useQuery({
    queryKey: ['totp-status'],
    queryFn: () => authApi.totpStatus().then((r) => r.data),
    enabled: activeTab === 'security',
  });

  const startTotpSetupMutation = useMutation({
    mutationFn: () => authApi.totpSetup(totpSetupPassword),
    onSuccess: (res) => { setTotpSetupData(res.data); setTotpConfirmCode(''); setTotpSetupPassword(''); setTotpError(''); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setTotpError(msg || 'Failed to start TOTP setup');
    },
  });

  const confirmTotpMutation = useMutation({
    mutationFn: () => authApi.totpConfirm(totpConfirmCode),
    onSuccess: () => {
      setTotpSetupData(null);
      setTotpConfirmCode('');
      setTotpMsg('Two-factor authentication enabled.');
      setTotpError('');
      refetchTotpStatus();
      setTimeout(() => setTotpMsg(''), 4000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setTotpError(msg || 'Invalid code');
    },
  });

  const disableTotpMutation = useMutation({
    mutationFn: () => authApi.totpDisable(totpDisablePassword),
    onSuccess: () => {
      setTotpDisablePassword('');
      setTotpMsg('Two-factor authentication disabled.');
      setTotpError('');
      refetchTotpStatus();
      setTimeout(() => setTotpMsg(''), 4000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setTotpError(msg || 'Failed to disable TOTP');
    },
  });

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

  // ─── Config Templates ──────────────────────────────────────────────────────
  const [tplFormOpen, setTplFormOpen] = useState(false);
  const [tplForm, setTplForm] = useState<{
    name: string; description: string; applies_to_type: string;
    dns_servers: string; ntp_servers: string; syslog_host: string;
  }>({ name: '', description: '', applies_to_type: '', dns_servers: '', ntp_servers: '', syslog_host: '' });
  const [tplApplyId, setTplApplyId] = useState<number | null>(null);
  const [tplApplyDeviceIds, setTplApplyDeviceIds] = useState<number[]>([]);
  const [tplApplyResults, setTplApplyResults] = useState<{ device_id: number; device_name: string; ok: boolean; error?: string }[] | null>(null);
  const [tplError, setTplError] = useState('');

  const { data: templates = [] } = useQuery({
    queryKey: ['config-templates'],
    queryFn: () => configTemplatesApi.list().then((r) => r.data),
    enabled: activeTab === 'templates',
  });

  const { data: allDevicesList = [] } = useQuery({
    queryKey: ['devices-list-for-templates'],
    queryFn: () => import('../services/api').then(m => m.default.get<{ id: number; name: string }[]>('/devices').then(r => r.data)),
    enabled: tplApplyId != null,
  });

  const createTemplateMutation = useMutation({
    mutationFn: () => {
      const tj: ConfigTemplate['template_json'] = {};
      if (tplForm.dns_servers.trim()) tj.dns_servers = tplForm.dns_servers.split(',').map((s) => s.trim()).filter(Boolean);
      if (tplForm.ntp_servers.trim()) tj.ntp_servers = tplForm.ntp_servers.split(',').map((s) => s.trim()).filter(Boolean);
      if (tplForm.syslog_host.trim()) tj.syslog_host = tplForm.syslog_host.trim();
      return configTemplatesApi.create({
        name: tplForm.name.trim(),
        description: tplForm.description.trim() || null,
        applies_to_type: tplForm.applies_to_type || null,
        template_json: tj,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      setTplFormOpen(false);
      setTplForm({ name: '', description: '', applies_to_type: '', dns_servers: '', ntp_servers: '', syslog_host: '' });
      setTplError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setTplError(msg || 'Failed to create template');
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: number) => configTemplatesApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config-templates'] }),
  });

  const applyTemplateMutation = useMutation({
    mutationFn: () => configTemplatesApi.apply(tplApplyId!, tplApplyDeviceIds),
    onSuccess: (res) => {
      setTplApplyResults(res.data.results);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setTplError(msg || 'Failed to apply template');
    },
  });

  // ─── Tags ─────────────────────────────────────────────────────────────────
  const { data: tags = [] } = useQuery({
    queryKey: ['tags'],
    queryFn: () => tagsApi.list().then((r) => r.data),
    enabled: activeTab === 'tags',
  });

  const createTagMutation = useMutation({
    mutationFn: () => tagsApi.create(newTagName.trim(), newTagColor),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setNewTagName('');
    },
  });

  const deleteTagMutation = useMutation({
    mutationFn: (id: number) => tagsApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tags'] }),
  });

  // ─── Maintenance Windows ───────────────────────────────────────────────────
  const { data: maintenanceWindows = [] } = useQuery({
    queryKey: ['maintenance-windows'],
    queryFn: () => maintenanceApi.list().then((r) => r.data),
    enabled: activeTab === 'maintenance',
  });

  const createMwMutation = useMutation({
    mutationFn: () => maintenanceApi.create({
      name: mwForm.name.trim(),
      device_ids: [],
      start_at: mwForm.start_at,
      end_at: mwForm.end_at,
      recurring_cron: null,
      active: true,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenance-windows'] });
      setMwForm({ name: '', start_at: '', end_at: '' });
    },
  });

  const deleteMwMutation = useMutation({
    mutationFn: (id: number) => maintenanceApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['maintenance-windows'] }),
  });

  const toggleMwMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => maintenanceApi.update(id, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['maintenance-windows'] }),
  });

  // ─── Audit Log ────────────────────────────────────────────────────────────
  const { data: auditData } = useQuery({
    queryKey: ['audit-log', auditPage, auditSearch],
    queryFn: () => auditLogApi.list({ page: auditPage, limit: 50, search: auditSearch || undefined }).then((r) => r.data),
    enabled: activeTab === 'audit',
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

  // Tabs are grouped by audience: platform administration, the signed-in
  // user's own account, and fleet-facing operational configuration.
  const tabGroups = [
    {
      label: 'Platform',
      tabs: [
        { key: 'general' as const, label: 'General', icon: Settings },
        { key: 'users' as const, label: 'Users & Roles', icon: Users },
        ...(isAdmin ? [{ key: 'sso' as const, label: 'SSO / OIDC', icon: LogIn }] : []),
        { key: 'certificate' as const, label: 'Certificate', icon: Lock },
        ...(isAdmin ? [{ key: 'audit' as const, label: 'Audit Log', icon: ClipboardList }] : []),
        ...(isAdmin ? [{ key: 'poller' as const, label: 'Polling', icon: Activity }] : []),
      ],
    },
    {
      label: 'My Account',
      tabs: [
        { key: 'security' as const, label: 'My Password', icon: Key },
      ],
    },
    {
      label: 'Fleet',
      tabs: [
        { key: 'credentials' as const, label: 'Device Credentials', icon: KeyRound },
        { key: 'alerting' as const, label: 'Alerting', icon: Bell },
        { key: 'automation' as const, label: 'Automation', icon: Zap },
        ...(isAdmin ? [
          { key: 'templates' as const, label: 'Config Templates', icon: FileText },
          { key: 'tags' as const, label: 'Tags', icon: ShieldCheck },
          { key: 'maintenance' as const, label: 'Maintenance', icon: ShieldAlert },
        ] : []),
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">Settings</h1>

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-gray-200 dark:border-slate-700">
        {tabGroups.map((group, gi) => (
          <div key={group.label} className={clsx(gi > 0 && 'sm:border-l sm:border-gray-200 sm:dark:border-slate-700 sm:pl-6')}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 select-none pt-1">
              {group.label}
            </div>
            <div className="flex gap-1">
              {group.tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={clsx(
                    'px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px flex items-center gap-2 whitespace-nowrap',
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
          </div>
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

          {/* Login Rate Limit */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Login Rate Limiting</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Limits login attempts per IP address to protect against brute-force attacks.
            </p>
            <div className="space-y-3">
              {[
                { key: 'login_rate_limit_max', label: 'Max attempts', unit: 'attempts' },
                { key: 'login_rate_limit_window_sec', label: 'Time window', unit: 'sec' },
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
                    min="1"
                    step="1"
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

          {/* Configuration Snapshots */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Configuration Snapshots</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Periodically captures each device&apos;s <code className="font-mono">/export</code> for the Config History / drift detection feature.
              This runs <strong>over SSH</strong>, so it only executes on devices that have <strong>SSH credentials configured</strong> — devices without them are skipped (no connection is attempted).
            </p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable config snapshots</div>
                <button
                  onClick={() => isAdmin && updateSettingsMutation.mutate({ config_snapshot_enabled: settings['config_snapshot_enabled'] === false })}
                  disabled={!isAdmin}
                  className={clsx(
                    'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                    isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                    settings['config_snapshot_enabled'] !== false ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                  )}
                >
                  <span className={clsx(
                    'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                    settings['config_snapshot_enabled'] !== false ? 'translate-x-5' : 'translate-x-0'
                  )} />
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Snapshot interval</div>
                  <div className="text-xs text-gray-400">minutes</div>
                </div>
                <input
                  type="number"
                  className="input w-24 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  value={settings['config_snapshot_interval_min'] as number ?? 60}
                  onChange={(e) => updateSettingsMutation.mutate({ config_snapshot_interval_min: parseInt(e.target.value) })}
                  min="15"
                  step="15"
                  disabled={!isAdmin || settings['config_snapshot_enabled'] === false}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Retention</div>
                  <div className="text-xs text-gray-400">snapshots kept per device</div>
                </div>
                <input
                  type="number"
                  className="input w-24 text-center disabled:opacity-50 disabled:cursor-not-allowed"
                  value={settings['config_snapshot_retention'] as number ?? 30}
                  onChange={(e) => updateSettingsMutation.mutate({ config_snapshot_retention: parseInt(e.target.value) })}
                  min="1"
                  step="1"
                  disabled={!isAdmin || settings['config_snapshot_enabled'] === false}
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

          {/* Maps & geocoding (issue #106) */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Maps &amp; Geocoding</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Device location maps use OpenStreetMap for tiles and Nominatim to turn an address
              into coordinates. Both are outbound requests to a third party, and the address you
              enter is sent to them. Turn this off on isolated networks, or wherever device
              locations should not leave your infrastructure — everything else keeps working, and
              addresses are still recorded as text.
            </p>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable maps and address lookup</div>
              <button
                onClick={() => isAdmin && updateSettingsMutation.mutate({ maps_enabled: settings['maps_enabled'] === false })}
                disabled={!isAdmin}
                className={clsx(
                  'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                  isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                  settings['maps_enabled'] !== false ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                )}
              >
                <span className={clsx(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                  settings['maps_enabled'] !== false ? 'translate-x-5' : 'translate-x-0'
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
                { key: 'netflow_retention_days', label: 'Traffic detail retention', desc: 'Auto-delete per-client NetFlow time-series data older than this many days' },
                { key: 'netflow_daily_retention_days', label: 'Traffic daily rollup retention', desc: 'Auto-delete per-client daily traffic totals older than this many days' },
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

          {/* Scheduled Backups */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Scheduled Backups</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
              Automatically backs up all online devices on a schedule via SSH export.
              Backups appear in the Backups section with type <code className="font-mono">scheduled</code>.
            </p>
            {(() => {
              const enabled = !!settings['backup_schedule_enabled'];
              const sched = parseBackupCron(settings['backup_schedule_cron'] as string);
              const controlsDisabled = !isAdmin || !enabled;
              const apply = (next: typeof sched) =>
                updateSettingsMutation.mutate({ backup_schedule_cron: scheduleToCron(next) });
              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable scheduled backups</div>
                    <button
                      onClick={() => isAdmin && updateSettingsMutation.mutate({ backup_schedule_enabled: !enabled })}
                      disabled={!isAdmin}
                      className={clsx(
                        'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                        isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                        enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                      )}
                    >
                      <span className={clsx(
                        'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200',
                        enabled ? 'translate-x-5' : 'translate-x-0'
                      )} />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Frequency */}
                    <div>
                      <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Frequency</label>
                      <select
                        className="input w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        value={sched.frequency}
                        disabled={controlsDisabled}
                        onChange={(e) => apply({ ...sched, frequency: e.target.value as BackupFrequency })}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>

                    {/* Day selector — weekly or monthly */}
                    {sched.frequency === 'weekly' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Day of week</label>
                        <select
                          className="input w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                          value={sched.weekday}
                          disabled={controlsDisabled}
                          onChange={(e) => apply({ ...sched, weekday: parseInt(e.target.value, 10) })}
                        >
                          {WEEKDAY_NAMES.map((name, i) => (
                            <option key={i} value={i}>{name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {sched.frequency === 'monthly' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Day of month</label>
                        <select
                          className="input w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                          value={sched.dayOfMonth}
                          disabled={controlsDisabled}
                          onChange={(e) => apply({ ...sched, dayOfMonth: parseInt(e.target.value, 10) })}
                        >
                          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                            <option key={d} value={d}>{ordinal(d)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Time of day */}
                    <div>
                      <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Time</label>
                      <input
                        type="time"
                        className="input w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        value={`${String(sched.hour).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}`}
                        disabled={controlsDisabled}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(':').map((n) => parseInt(n, 10));
                          if (Number.isNaN(h) || Number.isNaN(m)) return;
                          apply({ ...sched, hour: h, minute: m });
                        }}
                      />
                    </div>
                  </div>

                  <p className={clsx('text-xs', enabled ? 'text-gray-500 dark:text-slate-400' : 'text-gray-400 dark:text-slate-600')}>
                    {enabled
                      ? <>Runs <span className="font-medium text-gray-700 dark:text-slate-300">{describeBackupSchedule(sched).toLowerCase()}</span>, server time.</>
                      : 'Enable to choose a backup schedule.'}
                  </p>
                  {sched.frequency === 'monthly' && (
                    <p className="text-xs text-gray-400 dark:text-slate-500">
                      Days are limited to 1–28 so the backup runs every month, including February.
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Users ── */}
      {activeTab === 'poller' && (
        <div className="card p-5">
          <PollerHealthCard />
        </div>
      )}

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
                      <div className="flex items-center gap-2">
                        {u.username}
                        {u.id === user?.id && (
                          <span className="text-xs text-blue-500">(you)</span>
                        )}
                        {u.auth_provider === 'oidc' && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">SSO</span>
                        )}
                      </div>
                      {u.email && (
                        <div className="text-xs text-gray-400 dark:text-slate-500 font-normal">{u.email}</div>
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
        <div className="max-w-md space-y-4">
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

          {/* ── TOTP / 2FA ── */}
          <div className="card p-5">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-500" />
              Two-Factor Authentication
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Add an extra layer of security with a TOTP authenticator app (Google Authenticator, Authy, etc.)
            </p>

            {totpMsg && (
              <div className="flex items-center gap-2 text-sm text-green-500 mb-3">
                <CheckCircle className="w-4 h-4" /> {totpMsg}
              </div>
            )}
            {totpError && (
              <div className="flex items-center gap-2 text-sm text-red-500 mb-3">
                <AlertCircle className="w-4 h-4" /> {totpError}
              </div>
            )}

            {totpStatus?.totp_enabled ? (
              /* Already enabled — show disable form */
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                  <ShieldCheck className="w-4 h-4" /> 2FA is currently enabled
                </div>
                <div>
                  <label className="label">Enter your password to disable 2FA</label>
                  <input
                    type="password"
                    className="input"
                    value={totpDisablePassword}
                    onChange={(e) => setTotpDisablePassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <button
                  onClick={() => disableTotpMutation.mutate()}
                  disabled={!totpDisablePassword || disableTotpMutation.isPending}
                  className="btn-danger"
                >
                  Disable 2FA
                </button>
              </div>
            ) : totpSetupData ? (
              /* Setup in progress — show QR + confirm step */
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.
                </p>
                <div className="flex justify-center">
                  <img src={totpSetupData.qr} alt="TOTP QR code" className="w-44 h-44 rounded-lg border border-gray-200 dark:border-slate-700" />
                </div>
                <details className="text-xs text-gray-500 dark:text-gray-400">
                  <summary className="cursor-pointer select-none">Can&apos;t scan? Enter secret manually</summary>
                  <code className="mt-1 block font-mono break-all">{totpSetupData.secret}</code>
                </details>
                <div>
                  <label className="label">6-digit verification code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    className="input text-center tracking-widest font-mono text-lg"
                    value={totpConfirmCode}
                    onChange={(e) => setTotpConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    autoComplete="one-time-code"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirmTotpMutation.mutate()}
                    disabled={totpConfirmCode.length !== 6 || confirmTotpMutation.isPending}
                    className="btn-primary"
                  >
                    Enable 2FA
                  </button>
                  <button
                    onClick={() => { setTotpSetupData(null); setTotpConfirmCode(''); setTotpError(''); }}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Not enabled, not in setup */
              <div className="space-y-3">
                <div>
                  <label className="label">Confirm your password to set up 2FA</label>
                  <input
                    type="password"
                    className="input max-w-xs"
                    value={totpSetupPassword}
                    onChange={(e) => setTotpSetupPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              <button
                onClick={() => startTotpSetupMutation.mutate()}
                disabled={!totpSetupPassword || startTotpSetupMutation.isPending}
                className="btn-primary"
              >
                <ShieldCheck className="w-4 h-4" />
                Set up 2FA
              </button>
              </div>
            )}
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
                    {(['slack', 'discord', 'telegram', 'ntfy', 'email'] as const).map((t) => (
                      <option key={t} value={t}>{t === 'ntfy' ? 'ntfy' : t.charAt(0).toUpperCase() + t.slice(1)}</option>
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
              ) : chForm.type === 'ntfy' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Server URL</label>
                    <input className="input w-full font-mono text-xs" value={cfgStr('server_url')} onChange={(e) => setCfg('server_url', e.target.value)} placeholder="https://ntfy.sh" />
                    <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">Leave blank for the public ntfy.sh, or point at your own instance.</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Topic</label>
                    <input className="input w-full font-mono text-xs" value={cfgStr('topic')} onChange={(e) => setCfg('topic', e.target.value)} placeholder="mikrotik-alerts" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Access Token</label>
                    <input type="password" className="input w-full font-mono text-xs" value={cfgStr('token')} onChange={(e) => setCfg('token', e.target.value)} placeholder="tk_..." />
                    <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">
                      Preferred over a username and password. Anyone who can publish to an unprotected topic can spoof your alerts.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Username</label>
                      <input className="input w-full" value={cfgStr('username')} onChange={(e) => setCfg('username', e.target.value)} placeholder="(optional)" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Password</label>
                      <input type="password" className="input w-full" value={cfgStr('password')} onChange={(e) => setCfg('password', e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1">Manager URL (optional)</label>
                    <input className="input w-full font-mono text-xs" value={cfgStr('click_url')} onChange={(e) => setCfg('click_url', e.target.value)} placeholder="https://mikrotik.example.com" />
                    <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">Makes each notification tappable, opening the device it refers to.</p>
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
      {/* ── Automation (API tokens, webhooks, scheduled reports) ── */}
      {activeTab === 'automation' && (
        <AutomationSettings isAdmin={isAdmin} />
      )}
      {activeTab === 'sso' && (
        <OidcSettings isAdmin={isAdmin} />
      )}
      {/* ── Config Templates ── */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">Configuration Templates</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Define reusable config sets (DNS, NTP, Syslog) and push them to multiple devices at once.
                </p>
              </div>
              <button onClick={() => { setTplFormOpen(true); setTplError(''); }} className="btn-primary text-sm">
                <Plus className="w-4 h-4" /> New Template
              </button>
            </div>

            {tplError && (
              <div className="flex items-center gap-2 text-sm text-red-500 mb-3">
                <AlertCircle className="w-4 h-4" /> {tplError}
              </div>
            )}

            {/* Create form */}
            {tplFormOpen && (
              <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4 space-y-3 bg-blue-50/30 dark:bg-blue-900/10">
                <h4 className="text-sm font-semibold text-gray-800 dark:text-white">New Template</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Name</label>
                    <input className="input" value={tplForm.name} onChange={(e) => setTplForm((f) => ({ ...f, name: e.target.value }))} placeholder="Standard Office Config" />
                  </div>
                  <div>
                    <label className="label">Device Type (optional)</label>
                    <select className="input" value={tplForm.applies_to_type} onChange={(e) => setTplForm((f) => ({ ...f, applies_to_type: e.target.value }))}>
                      <option value="">All devices</option>
                      <option value="router">Router</option>
                      <option value="switch">Switch</option>
                      <option value="wireless">Wireless AP</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Description (optional)</label>
                  <input className="input" value={tplForm.description} onChange={(e) => setTplForm((f) => ({ ...f, description: e.target.value }))} placeholder="Standard DNS and NTP for main office" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">DNS Servers (comma-separated)</label>
                    <input className="input" value={tplForm.dns_servers} onChange={(e) => setTplForm((f) => ({ ...f, dns_servers: e.target.value }))} placeholder="8.8.8.8, 1.1.1.1" />
                  </div>
                  <div>
                    <label className="label">NTP Servers (comma-separated)</label>
                    <input className="input" value={tplForm.ntp_servers} onChange={(e) => setTplForm((f) => ({ ...f, ntp_servers: e.target.value }))} placeholder="pool.ntp.org" />
                  </div>
                </div>
                <div>
                  <label className="label">Syslog Host (optional)</label>
                  <input className="input" value={tplForm.syslog_host} onChange={(e) => setTplForm((f) => ({ ...f, syslog_host: e.target.value }))} placeholder="192.168.1.100" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => createTemplateMutation.mutate()} disabled={!tplForm.name.trim() || createTemplateMutation.isPending} className="btn-primary text-sm">
                    Create Template
                  </button>
                  <button onClick={() => { setTplFormOpen(false); setTplError(''); }} className="btn-secondary text-sm">Cancel</button>
                </div>
              </div>
            )}

            {/* Template list */}
            {templates.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-slate-400">No templates yet. Create one to get started.</p>
            ) : (
              <div className="space-y-2">
                {templates.map((tpl) => (
                  <div key={tpl.id} className="border border-gray-200 dark:border-slate-700 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm text-gray-900 dark:text-white">{tpl.name}</span>
                          {tpl.applies_to_type && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                              {tpl.applies_to_type}
                            </span>
                          )}
                        </div>
                        {tpl.description && <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{tpl.description}</p>}
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500 dark:text-slate-400">
                          {tpl.template_json.dns_servers?.length ? <span>DNS: {tpl.template_json.dns_servers.join(', ')}</span> : null}
                          {tpl.template_json.ntp_servers?.length ? <span>NTP: {tpl.template_json.ntp_servers.join(', ')}</span> : null}
                          {tpl.template_json.syslog_host ? <span>Syslog: {tpl.template_json.syslog_host}</span> : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => { setTplApplyId(tpl.id); setTplApplyDeviceIds([]); setTplApplyResults(null); setTplError(''); }}
                          className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors flex items-center gap-1"
                        >
                          <Send className="w-3 h-3" /> Apply
                        </button>
                        <button onClick={() => deleteTemplateMutation.mutate(tpl.id)} className="text-gray-400 hover:text-red-500 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Apply panel */}
                    {tplApplyId === tpl.id && (
                      <div className="mt-3 pt-3 border-t border-gray-200 dark:border-slate-700 space-y-2">
                        <p className="text-xs font-medium text-gray-700 dark:text-slate-300">Select devices to apply this template to:</p>
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {allDevicesList.map((d) => (
                            <label key={d.id} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                checked={tplApplyDeviceIds.includes(d.id)}
                                onChange={(e) => setTplApplyDeviceIds((ids) =>
                                  e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id)
                                )}
                              />
                              <span className="text-gray-800 dark:text-slate-200">{d.name}</span>
                            </label>
                          ))}
                        </div>
                        {tplApplyResults && (
                          <div className="space-y-1 mt-2">
                            {tplApplyResults.map((r) => (
                              <div key={r.device_id} className={`text-xs flex items-center gap-1.5 ${r.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                {r.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                                {r.device_name}: {r.ok ? 'Applied successfully' : r.error}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={() => applyTemplateMutation.mutate()}
                            disabled={tplApplyDeviceIds.length === 0 || applyTemplateMutation.isPending}
                            className="btn-primary text-xs"
                          >
                            {applyTemplateMutation.isPending ? 'Applying...' : `Apply to ${tplApplyDeviceIds.length} device${tplApplyDeviceIds.length !== 1 ? 's' : ''}`}
                          </button>
                          <button onClick={() => { setTplApplyId(null); setTplApplyResults(null); }} className="btn-secondary text-xs">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tags ── */}
      {activeTab === 'tags' && (
        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Device Tags</h3>
            {isAdmin && (
              <div className="flex items-center gap-2 mb-4">
                <input
                  type="color"
                  value={newTagColor}
                  onChange={(e) => setNewTagColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border border-gray-300 dark:border-slate-600 p-0.5"
                />
                <input
                  type="text"
                  placeholder="Tag name…"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && newTagName.trim() && createTagMutation.mutate()}
                  className="input-field flex-1 text-sm"
                />
                <button
                  onClick={() => createTagMutation.mutate()}
                  disabled={!newTagName.trim() || createTagMutation.isPending}
                  className="btn-primary text-sm px-3 py-1.5"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            )}
            <div className="space-y-2">
              {tags.map((tag) => (
                <div key={tag.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded-full" style={{ background: tag.color }} />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{tag.name}</span>
                    <span className="text-xs text-gray-400 dark:text-slate-500">{tag.device_count} device{tag.device_count !== 1 ? 's' : ''}</span>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => deleteTagMutation.mutate(tag.id)}
                      className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              {tags.length === 0 && (
                <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-4">No tags created yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Maintenance Windows ── */}
      {activeTab === 'maintenance' && (
        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Maintenance Windows</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 mb-4">
              Alerts are suppressed for devices during active maintenance windows.
            </p>

            {isAdmin && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
                <input
                  type="text"
                  placeholder="Window name…"
                  value={mwForm.name}
                  onChange={(e) => setMwForm(f => ({ ...f, name: e.target.value }))}
                  className="input-field text-sm"
                />
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 dark:text-slate-400">Start</label>
                  <input
                    type="datetime-local"
                    value={mwForm.start_at}
                    onChange={(e) => setMwForm(f => ({ ...f, start_at: e.target.value }))}
                    className="input-field text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500 dark:text-slate-400">End</label>
                  <input
                    type="datetime-local"
                    value={mwForm.end_at}
                    onChange={(e) => setMwForm(f => ({ ...f, end_at: e.target.value }))}
                    className="input-field text-sm"
                  />
                </div>
                <button
                  onClick={() => createMwMutation.mutate()}
                  disabled={!mwForm.name.trim() || !mwForm.start_at || !mwForm.end_at || createMwMutation.isPending}
                  className="btn-primary text-sm sm:col-span-3 justify-center flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Create Window
                </button>
              </div>
            )}

            <div className="space-y-2">
              {(maintenanceWindows as MaintenanceWindow[]).map((mw) => {
                const now = new Date();
                const start = new Date(mw.start_at);
                const end = new Date(mw.end_at);
                const isActive = mw.active && now >= start && now <= end;
                const isPast = now > end;
                return (
                  <div key={mw.id} className={clsx(
                    'flex items-center justify-between p-3 rounded-lg',
                    isActive ? 'border border-yellow-400 dark:border-yellow-600' : ''
                  )} style={{ background: 'var(--surface-2)' }}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{mw.name}</span>
                        {isActive && <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Active</span>}
                        {isPast && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400">Expired</span>}
                        {!mw.active && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 dark:bg-slate-700 dark:text-slate-500">Disabled</span>}
                      </div>
                      <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                        {new Date(mw.start_at).toLocaleString()} – {new Date(mw.end_at).toLocaleString()}
                        {mw.device_ids.length > 0 && ` · ${mw.device_ids.length} device(s)`}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleMwMutation.mutate({ id: mw.id, active: !mw.active })}
                          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300"
                        >
                          {mw.active ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => deleteMwMutation.mutate(mw.id)}
                          className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {(maintenanceWindows as MaintenanceWindow[]).length === 0 && (
                <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-4">No maintenance windows created</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Audit Log ── */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-blue-500" />
                Audit Log
              </h3>
              <input
                type="text"
                placeholder="Search user, path, IP…"
                value={auditSearch}
                onChange={(e) => { setAuditSearch(e.target.value); setAuditPage(1); }}
                className="input-field w-64 text-sm"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
                    <th className="pb-2 pr-4">Time</th>
                    <th className="pb-2 pr-4">User</th>
                    <th className="pb-2 pr-4">Action</th>
                    <th className="pb-2 pr-4">Entity</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {(auditData?.rows ?? []).map((row) => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-slate-700/50">
                      <td className="py-2 pr-4 font-mono text-xs text-gray-400 whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 font-medium">{row.username ?? '—'}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        <span className={clsx(
                          'px-1.5 py-0.5 rounded text-xs font-semibold mr-2',
                          row.method === 'DELETE' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                          row.method === 'POST' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                          'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        )}>
                          {row.method}
                        </span>
                        <span className="text-gray-500 dark:text-slate-400 truncate max-w-[200px] inline-block align-bottom" title={row.path}>{row.path}</span>
                      </td>
                      <td className="py-2 pr-4 text-gray-500 dark:text-slate-400">
                        {row.entity_type ? (row.entity_id ? `${row.entity_type}#${row.entity_id}` : row.entity_type) : '—'}
                      </td>
                      <td className="py-2 pr-4">
                        <span className={clsx(
                          'px-1.5 py-0.5 rounded text-xs font-semibold',
                          (row.status_code ?? 200) < 300 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                          (row.status_code ?? 200) < 500 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                          'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        )}>
                          {row.status_code ?? '—'}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-xs text-gray-400">{row.ip_address ?? '—'}</td>
                    </tr>
                  ))}
                  {(auditData?.rows ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-gray-400 dark:text-slate-500">
                        No audit log entries yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {(auditData?.total ?? 0) > 50 && (
              <div className="flex items-center justify-between mt-4 text-sm text-gray-500 dark:text-slate-400">
                <span>{auditData?.total} total entries</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                    disabled={auditPage <= 1}
                    className="btn-secondary text-xs px-3 py-1 disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <span className="px-2 py-1">Page {auditPage}</span>
                  <button
                    onClick={() => setAuditPage((p) => p + 1)}
                    disabled={auditPage * 50 >= (auditData?.total ?? 0)}
                    className="btn-secondary text-xs px-3 py-1 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
