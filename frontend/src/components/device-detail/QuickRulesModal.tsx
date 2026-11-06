import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Zap, Check, RefreshCw, ArrowUpToLine, ArrowDownToLine, CircleSlash } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type QuickPreset, type QuickFirewallStep } from '../../services/api';
import type { FirewallFamily } from '../../services/api';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import { apiErrorMessage } from '../../utils/apiError';

/**
 * Quick rules (#330): presets for the firewall rules nearly every router
 * needs, close to MikroTik's defconf. The plan comes from the device itself:
 * what's added, where, and what's skipped because it's already there.
 */
const PRESETS: { id: QuickPreset; title: string; text: string; v6: boolean }[] = [
  { id: 'input-basics', title: 'Input basics', v6: true,
    text: 'Protect the router itself: accept established and related, drop invalid, accept ping, drop everything else not from the LAN.' },
  { id: 'management-access', title: 'Management access', v6: false,
    text: 'Allow WinBox, SSH, the API and WebFig only from addresses you choose (the manager\'s own is added for you).' },
  { id: 'forward-basics', title: 'Forward basics', v6: true,
    text: 'Protect what\'s behind the router: accept established and related, drop invalid, drop new connections from the WAN that aren\'t port forwards. FastTrack optional.' },
  { id: 'masquerade', title: 'Masquerade', v6: false,
    text: 'NAT the LAN out of the WAN interface, for a WAN address that changes.' },
  { id: 'brute-force', title: 'Brute-force protection', v6: false,
    text: 'Ban an address that keeps opening new connections to SSH, WinBox, FTP, Telnet or a VPN server. The manager is never banned.' },
];

/** What brute-force protection can cover: services by their port, VPN servers by theirs. */
const BF: { id: string; label: string; vpn?: 'l2tp' | 'pptp' | 'ovpn' | 'sstp'; ports?: string }[] = [
  { id: 'ssh', label: 'SSH' }, { id: 'winbox', label: 'WinBox' }, { id: 'ftp', label: 'FTP' }, { id: 'telnet', label: 'Telnet' },
  { id: 'l2tp', label: 'L2TP/IPsec', vpn: 'l2tp', ports: 'UDP 500, 4500, 1701' },
  { id: 'pptp', label: 'PPTP', vpn: 'pptp', ports: 'TCP 1723' },
  { id: 'ovpn', label: 'OpenVPN', vpn: 'ovpn' },
  { id: 'sstp', label: 'SSTP', vpn: 'sstp', ports: 'TCP 443, shared with WebFig HTTPS' },
];
const BAN_TIMES = [{ v: '1h', label: '1 hour' }, { v: '1d', label: '1 day' }, { v: '1w', label: '1 week' }];

const MGMT = ['winbox', 'ssh', 'api', 'api-ssl', 'www', 'www-ssl', 'telnet', 'ftp'];
const MGMT_DEFAULT = ['winbox', 'ssh', 'api', 'api-ssl', 'www', 'www-ssl'];

const needs = (p: QuickPreset, v6: boolean) => ({
  wan: (p === 'forward-basics' && !v6) || p === 'masquerade',
  lan: p === 'input-basics' || (p === 'forward-basics' && v6),
});

/** "list:LAN" / "interface:ether2" ↔ the query fields. */
const refParams = (key: 'wan' | 'lan', v: string): Record<string, string> => {
  if (!v) return {};
  const [kind, ...rest] = v.split(':');
  return { [key]: rest.join(':'), [`${key}_kind`]: kind };
};

function StepRow({ s }: { s: QuickFirewallStep }) {
  const where = s.table === 'address-list' ? 'address list' : s.table === 'nat' ? 'NAT, at the end' : s.placement === 'top' ? 'at the top' : 'at the end';
  const cli = Object.entries(s.params).filter(([k]) => k !== 'comment').map(([k, v]) => `${k}=${v}`).join(' ');
  return (
    <li className={clsx('flex items-start gap-2 py-1.5', s.skip && 'opacity-60')}>
      {s.skip ? <CircleSlash className="w-3.5 h-3.5 mt-0.5 text-gray-400 flex-shrink-0" />
        : s.placement === 'top' ? <ArrowUpToLine className="w-3.5 h-3.5 mt-0.5 text-blue-500 flex-shrink-0" />
          : <ArrowDownToLine className="w-3.5 h-3.5 mt-0.5 text-blue-500 flex-shrink-0" />}
      <div className="min-w-0">
        <div className="text-sm text-gray-800 dark:text-slate-200">
          {s.description} <span className="text-xs text-gray-400">· {s.skip ? s.skip : `added ${where}`}</span>
        </div>
        <div className="font-mono text-[11px] text-gray-500 dark:text-slate-400 break-all">{cli}</div>
      </div>
    </li>
  );
}

export default function QuickRulesModal({ deviceId, deviceName, family, initial, onClose }: {
  deviceId: number; deviceName?: string; family: FirewallFamily; initial?: QuickPreset; onClose: () => void;
}) {
  const qc = useQueryClient();
  const v6 = family === 'ipv6';
  const guard = useGuardedWrite();
  const offered = PRESETS.filter((p) => !v6 || p.v6);
  const [preset, setPreset] = useState<QuickPreset>(initial && offered.some((p) => p.id === initial) ? initial : 'input-basics');
  const [wanChoice, setWan] = useState('');
  const [lanChoice, setLan] = useState('');
  // The WAN and LAN interface lists defconf makes, until something else is chosen.
  const [lists, setLists] = useState<string[]>([]);
  const wan = wanChoice || (lists.includes('WAN') ? 'list:WAN' : '');
  const lan = lanChoice || (lists.includes('LAN') ? 'list:LAN' : '');
  const [fasttrack, setFasttrack] = useState(false);
  const [list, setList] = useState('mtm-management');
  const [addresses, setAddresses] = useState('');
  const [services, setServices] = useState<string[]>(MGMT_DEFAULT);
  // Brute-force protection: null until something is ticked, so the device's own defaults apply.
  const [bfChoice, setBfChoice] = useState<string[] | null>(null);
  const [bfDefaults, setBfDefaults] = useState<string[]>([]);
  const bfServices = bfChoice ?? bfDefaults;
  const [banTime, setBanTime] = useState('1d');
  const [neverBan, setNeverBan] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const need = needs(preset, v6);

  const params = useMemo(() => ({
    preset,
    ...(need.wan ? refParams('wan', wan) : {}),
    ...(need.lan ? refParams('lan', lan) : {}),
    ...(preset === 'forward-basics' && fasttrack ? { fasttrack: '1' } : {}),
    ...(preset === 'management-access' ? { list, addresses: addresses.split(/[\s,;]+/).filter(Boolean).join(','), services: services.join(',') } : {}),
    ...(preset === 'brute-force' ? {
      addresses: neverBan.split(/[\s,;]+/).filter(Boolean).join(','), services: (bfChoice ?? []).join(','), ban_time: banTime,
    } : {}),
  }), [preset, need.wan, need.lan, wan, lan, fasttrack, list, addresses, services, neverBan, bfChoice, banTime]);

  const { data: plan, isFetching, error } = useQuery({
    queryKey: ['quick-firewall', deviceId, family, params],
    queryFn: async () => {
      const data = (await devicesApi.quickFirewallPlan(deviceId, params, family)).data;
      setLists(data.interface_lists);
      if (data.bf_defaults) setBfDefaults(data.bf_defaults);
      return data;
    },
    placeholderData: (prev) => prev,
  });

  const todo = plan ? plan.steps.filter((s) => !s.skip) : [];
  const errors = plan?.errors ?? {};
  const ready = !!plan && !isFetching && Object.keys(errors).length === 0 && todo.length > 0;
  const body = () => ({ ...params, ...(preset === 'management-access' || preset === 'brute-force' ? { addresses: params.addresses?.split(',').filter(Boolean) ?? [] } : {}) });
  const request = () => devicesApi.quickFirewallApply(deviceId, body(), family);
  const apply = useMutation({
    mutationFn: (confirm: boolean) => devicesApi.quickFirewallApply(deviceId, { ...body(), ...(confirm ? { confirm_lockout: true } : {}) }, family),
    onSuccess: (res) => {
      guard.onSuccess(res);
      setDone(res.data.message);
      for (const k of ['firewall', 'nat', 'address-lists', 'quick-firewall']) {
        qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === k && q.queryKey[1] === deviceId });
      }
    },
  });
  const run = () => apply.mutate(false, { onError: guard.onError(() => apply.mutate(true), () => {}) });

  const ifaceSelect = (value: string, set: (v: string) => void, label: string, err?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">{label}</label>
      <select className="input w-full" value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose…</option>
        {plan && plan.interface_lists.length > 0 && (
          <optgroup label="Interface lists">{plan.interface_lists.map((n) => <option key={n} value={`list:${n}`}>{n}</option>)}</optgroup>
        )}
        {plan && <optgroup label="Interfaces">{plan.interfaces.map((n) => <option key={n} value={`interface:${n}`}>{n}</option>)}</optgroup>}
      </select>
      {err && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500" /> Quick rules{v6 ? ' (IPv6)' : ''}{deviceName ? ` · ${deviceName}` : ''}
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {offered.map((p) => (
              <button key={p.id} type="button" onClick={() => { setPreset(p.id); setDone(null); apply.reset(); }}
                className={clsx('text-left rounded-lg border p-3 transition-colors', preset === p.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-slate-700 hover:border-blue-300')}>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{p.title}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{p.text}</div>
              </button>
            ))}
          </div>

          {(need.wan || need.lan) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {need.lan && ifaceSelect(lan, setLan, 'LAN (where trusted traffic comes from)', errors.lan)}
              {need.wan && ifaceSelect(wan, setWan, 'WAN (the internet side)', errors.wan)}
            </div>
          )}
          {preset === 'forward-basics' && !v6 && (
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-200">
              <input type="checkbox" className="mt-0.5" checked={fasttrack} onChange={(e) => setFasttrack(e.target.checked)} />
              <span>FastTrack established connections (faster routing; IPsec traffic is accepted first so it isn&apos;t FastTracked)</span>
            </label>
          )}
          {preset === 'management-access' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Address list</label>
                  <input className="input w-full font-mono" value={list} onChange={(e) => setList(e.target.value)} />
                  {errors.list && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.list}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Also allow (addresses or prefixes)</label>
                  <input className="input w-full font-mono" value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder="192.168.88.0/24, 10.0.0.5" />
                  {errors.addresses && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.addresses}</p>}
                  {plan?.manager_ip && <p className="mt-0.5 text-xs text-gray-500">MikroTik Manager ({plan.manager_ip}) is added for you.</p>}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Services to restrict</div>
                <div className="flex flex-wrap gap-3">
                  {MGMT.map((name) => {
                    const svc = plan?.services.find((s) => s.name === name);
                    return (
                      <label key={name} className={clsx('flex items-center gap-1.5 text-sm', (!svc || svc.disabled) && 'opacity-50')}
                        title={!svc ? 'Not on this device' : svc.disabled ? 'Turned off on this device, so not restricted' : `Port ${svc.port}`}>
                        <input type="checkbox" checked={services.includes(name)}
                          onChange={(e) => setServices(e.target.checked ? [...services, name] : services.filter((x) => x !== name))} />
                        {name}{svc && !svc.disabled ? <span className="text-xs text-gray-400">:{svc.port}</span> : ''}
                      </label>
                    );
                  })}
                </div>
                {errors.services && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.services}</p>}
              </div>
            </div>
          )}
          {preset === 'brute-force' && (
            <div className="space-y-3">
              <div>
                <div className="text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Protect</div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {BF.map((t) => {
                    const svc = !t.vpn ? plan?.services.find((s) => s.name === t.id) : undefined;
                    const on = t.vpn ? !!plan?.vpn?.[t.vpn] : !!svc && !svc.disabled;
                    const ports = t.vpn === 'ovpn' ? `TCP and UDP ${plan?.vpn?.ovpnPort || '1194'}` : t.ports ?? (svc && !svc.disabled ? `port ${svc.port}` : '');
                    return (
                      <label key={t.id} className={clsx('flex items-center gap-1.5 text-sm', !on && 'opacity-50')}
                        title={!on ? (t.vpn ? 'This VPN server is off on this device' : 'Turned off on this device') : ports}>
                        <input type="checkbox" checked={bfServices.includes(t.id)}
                          onChange={(e) => setBfChoice(e.target.checked ? [...bfServices, t.id] : bfServices.filter((x) => x !== t.id))} />
                        {t.label}{on && ports && t.id !== 'sstp' ? <span className="text-xs text-gray-400">{ports.startsWith('port') ? `:${svc?.port}` : ` (${ports})`}</span> : ''}
                      </label>
                    );
                  })}
                </div>
                {errors.services && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.services}</p>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Ban for</label>
                  <select className="input w-full" value={banTime} onChange={(e) => setBanTime(e.target.value)}>
                    {BAN_TIMES.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
                  </select>
                  {errors.banTime && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.banTime}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Never ban (addresses or prefixes)</label>
                  <input className="input w-full font-mono" value={neverBan} onChange={(e) => setNeverBan(e.target.value)} placeholder="192.168.88.0/24, 10.0.0.5" />
                  {errors.addresses && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors.addresses}</p>}
                  {plan?.manager_ip && <p className="mt-0.5 text-xs text-gray-500">MikroTik Manager ({plan.manager_ip}) is never banned.</p>}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-200 dark:border-slate-700">
            <div className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-2">
              What this adds {isFetching && <RefreshCw className="w-3 h-3 animate-spin" />}
            </div>
            <div className="px-3 py-1">
              {error ? <p className="py-2 text-sm text-red-600">{apiErrorMessage(error)}</p>
                : errors.preset ? <p className="py-2 text-sm text-red-600">{errors.preset}</p>
                  : !plan || Object.keys(errors).length ? <p className="py-2 text-sm text-gray-400">Choose the options above to see the rules.</p>
                    : <ul className="divide-y divide-gray-100 dark:divide-slate-700">{plan.steps.map((s, i) => <StepRow key={i} s={s} />)}</ul>}
            </div>
            {plan && plan.notes.length > 0 && Object.keys(errors).length === 0 && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-700 text-xs text-gray-500 dark:text-slate-400 space-y-0.5">
                {plan.notes.map((n, i) => <p key={i}>{n}</p>)}
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Accepts and the invalid drop go to the top so they work whatever else is there; the catch-all drops go to the end so your
            existing accepts keep working. Change Guard checks the whole preset against the manager&apos;s own connection first.
          </p>
          <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={apply.isPending} />
          {done && <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-1.5"><Check className="w-4 h-4" />{done}</p>}
          {apply.isError && !guard.lockout && <p className="text-sm text-red-600 dark:text-red-400">{apiErrorMessage(apply.error)}</p>}
        </div>
        <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
          <button onClick={run} disabled={!ready || apply.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
            <Check className="w-3.5 h-3.5" />{apply.isPending ? 'Adding…' : todo.length ? `Add ${todo.length} ${todo.length === 1 ? 'item' : 'items'}` : 'Nothing to add'}
          </button>
          <ReviewChangesButton request={request} onApply={run} applyLabel="Add" deviceName={deviceName} disabled={!ready || apply.isPending} />
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">{done ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}
