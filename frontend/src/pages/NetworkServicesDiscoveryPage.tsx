import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Radio, RefreshCw, CheckCircle, XCircle, AlertCircle, Check,
  HelpCircle, Shield, Eye, EyeOff, Router as RouterIcon, Layers,
} from 'lucide-react';
import { routersApi, switchesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import clsx from 'clsx';

type Scope = 'all' | 'routers' | 'switches';

interface LldpRow {
  id: number; name: string; ip_address: string;
  enabled: boolean | null; protocol: string | null; error?: string;
  kind: 'router' | 'switch';
}

interface SnmpRow {
  id: number; name: string; ip_address: string;
  enabled: boolean | null; community_name?: string; version?: string;
  auth_protocol?: string; priv_protocol?: string;
  contact?: string; location?: string; trap_target?: string;
  error?: string;
  kind: 'router' | 'switch';
}

interface SnmpForm {
  enabled: boolean;
  community_name: string;
  version: 'v1' | 'v2c' | 'v3';
  contact: string;
  location: string;
  trap_target: string;
  auth_protocol: string;
  auth_password: string;
  priv_protocol: string;
  priv_password: string;
}

const DEFAULT_SNMP: SnmpForm = {
  enabled: true,
  community_name: 'public',
  version: 'v2c',
  contact: '',
  location: '',
  trap_target: '',
  auth_protocol: 'MD5',
  auth_password: '',
  priv_protocol: 'none',
  priv_password: '',
};

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'all',      label: 'All Devices' },
  { key: 'routers',  label: 'Routers' },
  { key: 'switches', label: 'Switches' },
];

function scopeNoun(scope: Scope): string {
  return scope === 'routers' ? 'routers' : scope === 'switches' ? 'switches' : 'routers & switches';
}

function KindPill({ kind }: { kind: 'router' | 'switch' }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
      kind === 'router'
        ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
        : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
    )}>
      {kind === 'router' ? <RouterIcon className="w-3 h-3" /> : <Layers className="w-3 h-3" />}
      {kind === 'router' ? 'Router' : 'Switch'}
    </span>
  );
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        className="input pr-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
      />
      <button
        type="button"
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
        onClick={() => setShow(s => !s)}
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function NetworkServicesDiscoveryPage() {
  const canWrite = useCanWrite();
  const [scope, setScope] = useState<Scope>('all');

  const inScope = <T extends { kind: 'router' | 'switch' }>(rows: T[]) =>
    scope === 'all' ? rows : rows.filter(r => (scope === 'routers' ? r.kind === 'router' : r.kind === 'switch'));

  // ── LLDP state ──────────────────────────────────────────────────────────────
  const [lldpApplyResult, setLldpApplyResult] = useState<{ applied: number; total: number } | null>(null);
  const [lldpApplyError, setLldpApplyError]   = useState('');

  const routerLldp = useQuery({
    queryKey: ['routers-lldp'],
    queryFn: () => routersApi.getLldpStatus().then(r => r.data),
  });
  const switchLldp = useQuery({
    queryKey: ['switches-lldp'],
    queryFn: () => switchesApi.getLldpStatus().then(r => r.data),
  });

  const lldpLoading  = routerLldp.isLoading || switchLldp.isLoading;
  const lldpFetching = routerLldp.isFetching || switchLldp.isFetching;
  const refetchLldp  = () => { routerLldp.refetch(); switchLldp.refetch(); };

  const lldpAll: LldpRow[] = [
    ...(routerLldp.data ?? []).map(r => ({ ...r, kind: 'router' as const })),
    ...(switchLldp.data ?? []).map(r => ({ ...r, kind: 'switch' as const })),
  ];
  const lldpStatuses = inScope(lldpAll);

  const setLldpMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const calls = [];
      if (scope !== 'switches') calls.push(routersApi.setLldp(enabled));
      if (scope !== 'routers')  calls.push(switchesApi.setLldp(enabled));
      const results = await Promise.all(calls);
      return results.reduce(
        (acc, r) => ({ applied: acc.applied + r.data.applied, total: acc.total + r.data.total }),
        { applied: 0, total: 0 },
      );
    },
    onSuccess: (res) => { setLldpApplyResult(res); setLldpApplyError(''); refetchLldp(); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setLldpApplyError(msg || 'Failed to apply LLDP settings');
    },
  });

  const allEnabled  = lldpStatuses.length > 0 && lldpStatuses.every(s => s.enabled === true);
  const allDisabled = lldpStatuses.length > 0 && lldpStatuses.every(s => s.enabled === false);

  // ── SNMP state ──────────────────────────────────────────────────────────────
  const [snmpForm, setSnmpForm] = useState<SnmpForm>(DEFAULT_SNMP);
  const [snmpApplyResult, setSnmpApplyResult] = useState<{ applied: number; total: number } | null>(null);
  const [snmpApplyError, setSnmpApplyError]   = useState('');
  const [snmpFormEdited, setSnmpFormEdited]   = useState(false);

  const sf = (patch: Partial<SnmpForm>) => { setSnmpForm(f => ({ ...f, ...patch })); setSnmpFormEdited(true); };

  const routerSnmp = useQuery({
    queryKey: ['routers-snmp'],
    queryFn: () => routersApi.getSnmpStatus().then(r => r.data),
  });
  const switchSnmp = useQuery({
    queryKey: ['switches-snmp'],
    queryFn: () => switchesApi.getSnmpStatus().then(r => r.data),
  });

  const snmpLoading  = routerSnmp.isLoading || switchSnmp.isLoading;
  const snmpFetching = routerSnmp.isFetching || switchSnmp.isFetching;
  const refetchSnmp  = () => { routerSnmp.refetch(); switchSnmp.refetch(); };

  const snmpAll: SnmpRow[] = [
    ...(routerSnmp.data ?? []).map(r => ({ ...r, kind: 'router' as const })),
    ...(switchSnmp.data ?? []).map(r => ({ ...r, kind: 'switch' as const })),
  ];
  const snmpStatuses = inScope(snmpAll);

  // Pre-populate the form from the first successful device result, unless the
  // user has already started editing.
  useEffect(() => {
    if (snmpFormEdited) return;
    const first = snmpAll.find(s => s.enabled != null && !s.error);
    if (first) {
      setSnmpForm({
        enabled:        first.enabled ?? true,
        community_name: first.community_name ?? 'public',
        version:        (first.version as 'v1' | 'v2c' | 'v3') ?? 'v2c',
        contact:        first.contact ?? '',
        location:       first.location ?? '',
        trap_target:    first.trap_target ?? '',
        auth_protocol:  first.auth_protocol ?? 'MD5',
        auth_password:  '',
        priv_protocol:  first.priv_protocol ?? 'none',
        priv_password:  '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerSnmp.data, switchSnmp.data]);

  const setSnmpMutation = useMutation({
    mutationFn: async () => {
      const calls = [];
      if (scope !== 'switches') calls.push(routersApi.setSnmp(snmpForm));
      if (scope !== 'routers')  calls.push(switchesApi.setSnmp(snmpForm));
      const results = await Promise.all(calls);
      return results.reduce(
        (acc, r) => ({ applied: acc.applied + r.data.applied, total: acc.total + r.data.total }),
        { applied: 0, total: 0 },
      );
    },
    onSuccess: (res) => { setSnmpApplyResult(res); setSnmpApplyError(''); refetchSnmp(); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSnmpApplyError(msg || 'Failed to apply SNMP settings');
    },
  });

  const isV3 = snmpForm.version === 'v3';

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Discovery &amp; SNMP</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            Network-wide LLDP discovery and SNMP monitoring configuration
          </p>
        </div>
        {/* Scope selector */}
        <div className="flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
          {SCOPES.map(s => (
            <button
              key={s.key}
              type="button"
              onClick={() => { setScope(s.key); setLldpApplyResult(null); setSnmpApplyResult(null); }}
              className={clsx(
                'px-4 py-1.5 text-sm font-medium transition-colors',
                scope === s.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── LLDP Card ──────────────────────────────────────────────────────────── */}
      <div className="card p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
            <Radio className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Link Layer Discovery Protocol (LLDP)
            </h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
              LLDP lets your devices announce themselves to neighbors and collect
              neighbor information. Enabling LLDP improves the accuracy of the network topology map.
            </p>
          </div>
        </div>

        {!lldpLoading && lldpStatuses.length > 0 && (
          <div className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
            allEnabled  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' :
            allDisabled ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' :
                          'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400'
          )}>
            {allEnabled ? <CheckCircle className="w-4 h-4" /> : allDisabled ? <XCircle className="w-4 h-4" /> : <HelpCircle className="w-4 h-4" />}
            {allEnabled  ? `LLDP is enabled on all online ${scopeNoun(scope)}` :
             allDisabled ? `LLDP is disabled on all online ${scopeNoun(scope)}` :
                           `LLDP state is mixed across ${scopeNoun(scope)}`}
          </div>
        )}

        {lldpLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <RefreshCw className="w-4 h-4 animate-spin" /> Checking LLDP status on all {scopeNoun(scope)}…
          </div>
        ) : lldpStatuses.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            No online {scopeNoun(scope)} found. Devices must be online to check or change LLDP settings.
          </p>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Type</th>
                  <th className="table-header px-4 py-2.5 text-left">IP</th>
                  <th className="table-header px-4 py-2.5 text-left">LLDP</th>
                  <th className="table-header px-4 py-2.5 text-left">Protocols</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {lldpStatuses.map(r => (
                  <tr key={`${r.kind}-${r.id}`} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{r.name}</td>
                    <td className="px-4 py-2.5"><KindPill kind={r.kind} /></td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{r.ip_address}</td>
                    <td className="px-4 py-2.5">
                      {r.error ? (
                        <span className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Error</span>
                      ) : r.enabled === null ? (
                        <span className="text-xs text-gray-400">Unknown</span>
                      ) : r.enabled ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> Enabled</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400"><XCircle className="w-3.5 h-3.5" /> Disabled</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {r.protocol && r.protocol !== 'unknown' ? r.protocol : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lldpApplyResult && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <Check className="w-4 h-4" /> Applied to {lldpApplyResult.applied} of {lldpApplyResult.total} {scopeNoun(scope)}
          </div>
        )}
        {lldpApplyError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-600 dark:text-red-400">{lldpApplyError}</p>
          </div>
        )}

        {canWrite && (
          <div className="flex items-center gap-3 pt-1">
            <button onClick={() => refetchLldp()} disabled={lldpFetching} className="btn-secondary flex items-center gap-1.5 text-sm">
              <RefreshCw className={clsx('w-3.5 h-3.5', lldpFetching && 'animate-spin')} /> Refresh Status
            </button>
            <button
              disabled={setLldpMutation.isPending || lldpLoading || lldpStatuses.length === 0}
              className="btn-primary flex items-center gap-1.5 text-sm"
              onClick={() => { setLldpApplyResult(null); setLldpMutation.mutate(true); }}
            >
              {setLldpMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              Enable LLDP on All
            </button>
            <button
              disabled={setLldpMutation.isPending || lldpLoading || lldpStatuses.length === 0}
              className="btn-secondary flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
              onClick={() => { setLldpApplyResult(null); setLldpMutation.mutate(false); }}
            >
              {setLldpMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
              Disable LLDP on All
            </button>
          </div>
        )}
      </div>

      {/* ── SNMP Card ───────────────────────────────────────────────────────────── */}
      <div className="card p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 bg-purple-50 dark:bg-purple-900/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
            <Shield className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Simple Network Management Protocol (SNMP)
            </h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
              Configure SNMP across your managed {scopeNoun(scope)}. Settings are applied network-wide.
              SNMPv3 provides authentication and optional encryption for secure monitoring.
            </p>
          </div>
        </div>

        <fieldset disabled={!canWrite} className="space-y-4 disabled:opacity-60">
          {/* Enable toggle */}
          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-700/40 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Enable SNMP</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                Allow SNMP polling and trap generation on all {scopeNoun(scope)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => sf({ enabled: !snmpForm.enabled })}
              className={clsx(
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                snmpForm.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
              )}
            >
              <span className={clsx(
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                snmpForm.enabled ? 'translate-x-6' : 'translate-x-1'
              )} />
            </button>
          </div>

          {/* Version */}
          <div>
            <label className="label">SNMP Version</label>
            <div className="flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden w-fit">
              {(['v1', 'v2c', 'v3'] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => sf({ version: v })}
                  className={clsx(
                    'px-5 py-2 text-sm font-medium transition-colors',
                    snmpForm.version === v
                      ? 'bg-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'
                  )}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 dark:text-slate-500 mt-1.5">
              {snmpForm.version === 'v1'  && 'SNMPv1 — community string, no encryption. Legacy use only.'}
              {snmpForm.version === 'v2c' && 'SNMPv2c — community string, supports 64-bit counters. Recommended for read-only monitoring.'}
              {snmpForm.version === 'v3'  && 'SNMPv3 — username-based with authentication and optional encryption. Most secure.'}
            </p>
          </div>

          {/* Community / Username */}
          <div>
            <label className="label">{isV3 ? 'Username' : 'Community Name'}</label>
            <input
              className="input max-w-xs"
              value={snmpForm.community_name}
              onChange={e => sf({ community_name: e.target.value })}
              placeholder={isV3 ? 'snmpv3user' : 'public'}
            />
          </div>

          {/* Global info */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Contact</label>
              <input className="input" value={snmpForm.contact} onChange={e => sf({ contact: e.target.value })} placeholder="{identity}@example.com" />
            </div>
            <div>
              <label className="label">Location</label>
              <input className="input" value={snmpForm.location} onChange={e => sf({ location: e.target.value })} placeholder="{site} / {location}" />
            </div>
          </div>
          {/* Contact and location used to be written verbatim to every device,
              and blank fields erased what each device already had (#164). */}
          <p className="text-[11.5px] text-gray-500 dark:text-slate-400 -mt-1">
            Leave a field blank to keep what each device already has. Variables are filled in per
            device: <span className="mono">{'{identity}'}</span>, <span className="mono">{'{name}'}</span>,{' '}
            <span className="mono">{'{ip}'}</span>, <span className="mono">{'{model}'}</span>,{' '}
            <span className="mono">{'{serial}'}</span>, <span className="mono">{'{site}'}</span>,{' '}
            <span className="mono">{'{location}'}</span>.
          </p>

          <div>
            <label className="label">Trap Destination (optional)</label>
            <input className="input max-w-xs" value={snmpForm.trap_target} onChange={e => sf({ trap_target: e.target.value })} placeholder="192.168.1.100" />
          </div>

          {/* SNMPv3 section */}
          {isV3 && (
            <div className="border border-purple-200 dark:border-purple-800/50 rounded-lg p-4 space-y-4 bg-purple-50/30 dark:bg-purple-900/10">
              <p className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wide">
                SNMPv3 Security
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Authentication Protocol</label>
                  <select className="input" value={snmpForm.auth_protocol} onChange={e => sf({ auth_protocol: e.target.value })}>
                    <option value="MD5">MD5</option>
                    <option value="SHA1">SHA1</option>
                  </select>
                </div>
                <div>
                  <label className="label">Authentication Password</label>
                  <PasswordInput value={snmpForm.auth_password} onChange={v => sf({ auth_password: v })} placeholder="Leave blank to keep current" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Privacy (Encryption) Protocol</label>
                  <select className="input" value={snmpForm.priv_protocol} onChange={e => sf({ priv_protocol: e.target.value })}>
                    <option value="none">None (auth only)</option>
                    <option value="DES">DES</option>
                    <option value="AES">AES</option>
                  </select>
                </div>
                {snmpForm.priv_protocol !== 'none' && (
                  <div>
                    <label className="label">Privacy Password</label>
                    <PasswordInput value={snmpForm.priv_password} onChange={v => sf({ priv_password: v })} placeholder="Leave blank to keep current" />
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Security level:{' '}
                <span className="font-medium text-purple-700 dark:text-purple-300">
                  {snmpForm.priv_protocol !== 'none' ? 'authPriv (auth + encryption)' : 'authNoPriv (auth only)'}
                </span>
              </p>
            </div>
          )}
        </fieldset>

        {/* Per-device SNMP status table */}
        {snmpLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <RefreshCw className="w-4 h-4 animate-spin" /> Checking SNMP status on all {scopeNoun(scope)}…
          </div>
        ) : snmpStatuses.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Type</th>
                  <th className="table-header px-4 py-2.5 text-left">IP</th>
                  <th className="table-header px-4 py-2.5 text-left">SNMP</th>
                  <th className="table-header px-4 py-2.5 text-left">Version</th>
                  <th className="table-header px-4 py-2.5 text-left">Community / User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {snmpStatuses.map(r => (
                  <tr key={`${r.kind}-${r.id}`} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{r.name}</td>
                    <td className="px-4 py-2.5"><KindPill kind={r.kind} /></td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{r.ip_address}</td>
                    <td className="px-4 py-2.5">
                      {r.error ? (
                        <span className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Error</span>
                      ) : r.enabled === null ? (
                        <span className="text-xs text-gray-400">Unknown</span>
                      ) : r.enabled ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> Enabled</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400"><XCircle className="w-3.5 h-3.5" /> Disabled</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.version ? (
                        <span className={clsx(
                          'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                          r.version === 'v3' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                                            : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                        )}>
                          {r.version.toUpperCase()}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {r.community_name ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {snmpApplyResult && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <Check className="w-4 h-4" /> Applied to {snmpApplyResult.applied} of {snmpApplyResult.total} {scopeNoun(scope)}
          </div>
        )}
        {snmpApplyError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-600 dark:text-red-400">{snmpApplyError}</p>
          </div>
        )}

        {canWrite && (
          <div className="flex items-center gap-3 pt-1">
            <button onClick={() => { setSnmpApplyResult(null); refetchSnmp(); }} disabled={snmpFetching} className="btn-secondary flex items-center gap-1.5 text-sm">
              <RefreshCw className={clsx('w-3.5 h-3.5', snmpFetching && 'animate-spin')} /> Refresh Status
            </button>
            <button
              disabled={setSnmpMutation.isPending || snmpStatuses.length === 0}
              className="btn-primary flex items-center gap-1.5 text-sm"
              onClick={() => { setSnmpApplyResult(null); setSnmpApplyError(''); setSnmpMutation.mutate(); }}
            >
              {setSnmpMutation.isPending
                ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Applying…</>
                : <><Check className="w-3.5 h-3.5" /> Apply to {scope === 'all' ? 'All Devices' : scope === 'routers' ? 'All Routers' : 'All Switches'}</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
