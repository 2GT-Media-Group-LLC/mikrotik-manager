import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Ticket, Wifi, Users, Globe, Power, Trash2, RefreshCw, Plus, Printer,
  CheckCircle, AlertTriangle, X, Clock, Database,
} from 'lucide-react';
import clsx from 'clsx';
import { guestWifiApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import type { Device } from '../types';

type HS = Record<string, string>;

function formatBytes(raw: string | number | undefined): string {
  const b = Number(raw ?? 0);
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// ─── Voucher print sheet ─────────────────────────────────────────────────────

/** HTML-escape a value for the print sheet. */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The network name and codes come from the router, so every value is escaped
 * and the sheet can't reach back into the manager (outside review U4). Before,
 * a hotspot or voucher named with markup could redirect the manager's tab, or
 * without the CSP run script in it.
 */
function printVouchers(codes: string[], opts: { network: string; durationHours?: number; dataCapMB?: number }) {
  const cards = codes.map(code => `
    <div class="card">
      <div class="net">📶 ${esc(opts.network)}</div>
      <div class="code">${esc(code)}</div>
      <div class="meta">
        ${opts.durationHours ? `Valid ${esc(opts.durationHours)}h` : 'No time limit'}
        ${opts.dataCapMB ? ` · ${esc(opts.dataCapMB >= 1024 ? Number((opts.dataCapMB / 1024).toFixed(2)) + ' GB' : opts.dataCapMB + ' MB')}` : ''}
      </div>
      <div class="hint">Connect to WiFi, enter this code as username.<br/>Leave password blank.</div>
    </div>`).join('');
  const html = `<!doctype html><html><head><title>Guest WiFi Vouchers</title><style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .card { border: 1.5px dashed #94a3b8; border-radius: 10px; padding: 14px; text-align: center; break-inside: avoid; }
    .net  { font-size: 12px; color: #475569; margin-bottom: 6px; }
    .code { font-size: 20px; font-weight: 700; letter-spacing: 1px; font-family: ui-monospace, monospace; }
    .meta { font-size: 11px; color: #64748b; margin-top: 6px; }
    .hint { font-size: 9.5px; color: #94a3b8; margin-top: 8px; line-height: 1.4; }
    @media print { body { margin: 8px; } }
  </style></head><body><div class="grid">${cards}</div></body></html>`;
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.opener = null; // the sheet can't navigate or touch the manager's tab
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

function SetupWizard({ deviceId, interfaces, isAP, onDone }: {
  deviceId: number;
  interfaces: { name: string; type: string }[];
  isAP: boolean;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'ssid' | 'existing'>(isAP ? 'ssid' : 'existing');
  const [form, setForm] = useState({
    name: 'guest',
    ssid: 'Guest WiFi',
    passphrase: '',
    vlanId: '',
    interfaceName: interfaces[0]?.name ?? '',
    gatewayCidr: '10.5.50.1/24',
    poolRange: '10.5.50.10-10.5.50.254',
    dnsName: '',
    rateLimit: '10M/10M',
    masquerade: true,
  });
  const set = <K extends keyof typeof form>(k: K) => (v: typeof form[K]) => setForm(f => ({ ...f, [k]: v }));
  const [warnings, setWarnings] = useState<string[]>([]);

  const mutation = useMutation({
    meta: { inlineError: true },
    mutationFn: () => guestWifiApi.setup(deviceId, {
      name: form.name,
      gatewayCidr: form.gatewayCidr,
      poolRange: form.poolRange,
      dnsName: form.dnsName || undefined,
      rateLimit: form.rateLimit || undefined,
      masquerade: form.masquerade,
      ...(mode === 'ssid'
        ? {
            ssid: { ssid: form.ssid, passphrase: form.passphrase || undefined },
            vlanId: form.vlanId ? parseInt(form.vlanId, 10) : undefined,
          }
        : { interfaceName: form.interfaceName }),
    }),
    onSuccess: (r) => {
      setWarnings(r.data.warnings ?? []);
      if ((r.data.warnings ?? []).length === 0) onDone();
    },
  });

  // Setup succeeded but produced warnings — show them with a continue button
  if (warnings.length > 0) {
    return (
      <div className="card p-6 max-w-2xl">
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle className="w-5 h-5 text-green-500" />
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Guest network created — review these</h2>
        </div>
        <div className="space-y-2 mb-4">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />{w}
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" onClick={onDone}>Continue to Guest WiFi</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6 max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <Ticket className="w-5 h-5 text-blue-500" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Set up Guest WiFi</h2>
      </div>
      <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">
        Builds the whole guest network in one pass: broadcasts a new guest SSID, isolates the traffic
        (VLAN or dedicated bridge), and stands up the captive portal — pool, DHCP, portal server, rate-limited guest profile, NAT.
      </p>

      {/* Mode toggle */}
      <div className="flex rounded-lg border border-gray-200 dark:border-slate-700 p-1 gap-1 w-fit mb-5">
        {isAP && (
          <button onClick={() => setMode('ssid')}
            className={clsx('px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              mode === 'ssid' ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700')}>
            Create new guest SSID
          </button>
        )}
        <button onClick={() => setMode('existing')}
          className={clsx('px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
            mode === 'existing' ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700')}>
          Use existing interface
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {mode === 'ssid' ? (
          <>
            <div>
              <label className="label">Guest SSID</label>
              <input className="input" value={form.ssid} onChange={e => set('ssid')(e.target.value)} placeholder="Guest WiFi" maxLength={32} />
              <p className="text-xs text-gray-400 mt-1">A new virtual AP is created on every radio (2.4 + 5 GHz).</p>
            </div>
            <div>
              <label className="label">WiFi password (optional)</label>
              <input className="input font-mono" value={form.passphrase} onChange={e => set('passphrase')(e.target.value)} placeholder="empty = open network" />
              <p className="text-xs text-gray-400 mt-1">Open is typical for captive portals — the voucher is the gate.</p>
            </div>
            <div>
              <label className="label">Guest VLAN ID (recommended)</label>
              <input type="number" min={1} max={4094} className="input font-mono" value={form.vlanId} onChange={e => set('vlanId')(e.target.value)} placeholder="e.g. 50" />
              <p className="text-xs text-gray-400 mt-1">Tags guest traffic for firewall/isolation. Empty = dedicated guest bridge instead.</p>
            </div>
          </>
        ) : (
          <div>
            <label className="label">Interface</label>
            <select className="input" value={form.interfaceName} onChange={e => set('interfaceName')(e.target.value)}>
              {interfaces.map(i => <option key={i.name} value={i.name}>{i.name}{i.type ? ` (${i.type})` : ''}</option>)}
            </select>
            <p className="text-xs text-gray-400 mt-1">An existing guest bridge/VLAN/SSID interface.</p>
          </div>
        )}
        <div>
          <label className="label">Network name</label>
          <input className="input" value={form.name} onChange={e => set('name')(e.target.value)} placeholder="guest" />
          <p className="text-xs text-gray-400 mt-1">Names the hotspot, pool &amp; profiles (a–z, 0–9, dash).</p>
        </div>
        <div>
          <label className="label">Gateway address (CIDR)</label>
          <input className="input font-mono" value={form.gatewayCidr} onChange={e => set('gatewayCidr')(e.target.value)} placeholder="10.5.50.1/24" />
        </div>
        <div>
          <label className="label">DHCP pool range</label>
          <input className="input font-mono" value={form.poolRange} onChange={e => set('poolRange')(e.target.value)} placeholder="10.5.50.10-10.5.50.254" />
        </div>
        <div>
          <label className="label">Guest speed limit (rx/tx)</label>
          <input className="input font-mono" value={form.rateLimit} onChange={e => set('rateLimit')(e.target.value)} placeholder="10M/10M" />
          <p className="text-xs text-gray-400 mt-1">Per-guest cap. Leave empty for unlimited.</p>
        </div>
        <div>
          <label className="label">Portal DNS name (optional)</label>
          <input className="input font-mono" value={form.dnsName} onChange={e => set('dnsName')(e.target.value)} placeholder="wifi.guest" />
        </div>
      </div>

      <label className="mt-4 flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-slate-300">
        <input type="checkbox" className="w-4 h-4 rounded" checked={form.masquerade} onChange={e => set('masquerade')(e.target.checked)} />
        NAT guest traffic to the internet (adds a masquerade rule for the guest subnet)
      </label>

      {mode === 'existing' && (
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Pick a dedicated guest interface. Enabling a hotspot on your main LAN interface will put a captive portal in front of <em>every</em> client on it.</span>
        </div>
      )}

      {mutation.isError && (
        <p className="mt-3 text-sm text-red-500">
          {(mutation.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Setup failed'}
        </p>
      )}

      <div className="mt-5 flex justify-end">
        <button className="btn-primary flex items-center gap-2"
          disabled={mutation.isPending || (mode === 'ssid' ? !form.ssid.trim() : !form.interfaceName)}
          onClick={() => mutation.mutate()}>
          {mutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {mutation.isPending ? 'Setting up…' : 'Create Guest Network'}
        </button>
      </div>
    </div>
  );
}

// ─── Voucher generator ───────────────────────────────────────────────────────

function VoucherGenerator({ deviceId, userProfiles, networkName, onCreated }: {
  deviceId: number;
  userProfiles: HS[];
  networkName: string;
  onCreated: () => void;
}) {
  const [count, setCount] = useState(10);
  const [durationHours, setDurationHours] = useState(24);
  const [dataCapMB, setDataCapMB] = useState(0);
  const [profile, setProfile] = useState(userProfiles.find(p => (p['name'] || '').includes('guest'))?.['name'] ?? userProfiles[0]?.['name'] ?? '');
  const [result, setResult] = useState<string[] | null>(null);

  const mutation = useMutation({
    meta: { inlineError: true },
    mutationFn: () => guestWifiApi.createVouchers(deviceId, {
      count,
      durationHours: durationHours > 0 ? durationHours : undefined,
      dataCapMB: dataCapMB > 0 ? dataCapMB : undefined,
      userProfile: profile || undefined,
    }),
    onSuccess: (r) => { setResult(r.data.codes); onCreated(); },
  });

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Plus className="w-4 h-4 text-green-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Generate vouchers</h3>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="label">Count</label>
          <input type="number" min={1} max={100} className="input" value={count} onChange={e => setCount(parseInt(e.target.value) || 1)} />
        </div>
        <div>
          <label className="label">Valid for (hours)</label>
          <input type="number" min={0} className="input" step="any" value={durationHours} onChange={e => setDurationHours(parseFloat(e.target.value) || 0)} />
          <p className="text-[10px] text-gray-400 mt-0.5">0 = unlimited</p>
        </div>
        <div>
          <label className="label">Data cap (MB)</label>
          <input type="number" min={0} className="input" step="any" value={dataCapMB} onChange={e => setDataCapMB(parseFloat(e.target.value) || 0)} />
          <p className="text-[10px] text-gray-400 mt-0.5">0 = unlimited</p>
        </div>
        <div>
          <label className="label">Speed profile</label>
          <select className="input" value={profile} onChange={e => setProfile(e.target.value)}>
            {userProfiles.map(p => (
              <option key={p['.id'] ?? p['name']} value={p['name']}>
                {p['name']}{p['rate-limit'] ? ` (${p['rate-limit']})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      {mutation.isError && (
        <p className="mt-3 text-sm text-red-500">
          {(mutation.error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to create vouchers'}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button className="btn-primary flex items-center gap-2" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Ticket className="w-4 h-4" />}
          {mutation.isPending ? 'Generating…' : `Generate ${count}`}
        </button>
      </div>

      {/* Result modal */}
      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setResult(null)}>
          <div className="card w-full max-w-lg p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="w-5 h-5 text-green-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{result.length} voucher{result.length !== 1 ? 's' : ''} created</h3>
              <button className="ml-auto text-gray-400 hover:text-gray-600" onClick={() => setResult(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto mb-4">
              {result.map(c => (
                <div key={c} className="px-2 py-1.5 rounded bg-gray-100 dark:bg-slate-700 text-center font-mono text-sm text-gray-800 dark:text-slate-200">{c}</div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setResult(null)}>Close</button>
              <button className="btn-primary flex items-center gap-2"
                onClick={() => printVouchers(result, { network: networkName, durationHours: durationHours > 0 ? durationHours : undefined, dataCapMB: dataCapMB > 0 ? dataCapMB : undefined })}>
                <Printer className="w-4 h-4" />Print sheet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function GuestWifiPage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [wgHost, setWgHost] = useState('');

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });
  // Hotspots belong on the device that serves the guest network: an AP or the
  // gateway router. Switches (and 'other') aren't sensible portal hosts.
  const online = (devices as Device[]).filter(
    d => d.status === 'online' && (d.device_type === 'wireless_ap' || d.device_type === 'router')
  );
  const devId = typeof deviceId === 'number' ? deviceId : (online[0]?.id ?? 0);

  const { data: overview, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['guest-wifi-overview', devId],
    queryFn: () => guestWifiApi.overview(devId).then(r => r.data),
    enabled: devId > 0,
  });

  const hasServer = (overview?.servers?.length ?? 0) > 0;

  const { data: users = [] } = useQuery({
    queryKey: ['guest-wifi-users', devId],
    queryFn: () => guestWifiApi.users(devId).then(r => r.data),
    enabled: devId > 0 && hasServer,
  });
  const { data: active = [] } = useQuery({
    queryKey: ['guest-wifi-active', devId],
    queryFn: () => guestWifiApi.active(devId).then(r => r.data),
    enabled: devId > 0 && hasServer,
    refetchInterval: 30_000,
  });
  const { data: walledGarden = [] } = useQuery({
    queryKey: ['guest-wifi-wg', devId],
    queryFn: () => guestWifiApi.walledGarden(devId).then(r => r.data),
    enabled: devId > 0 && hasServer,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['guest-wifi-overview', devId] });
    qc.invalidateQueries({ queryKey: ['guest-wifi-users', devId] });
    qc.invalidateQueries({ queryKey: ['guest-wifi-active', devId] });
    qc.invalidateQueries({ queryKey: ['guest-wifi-wg', devId] });
  };

  const toggleServer = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => guestWifiApi.setServerDisabled(devId, id, disabled),
    onSuccess: invalidateAll,
  });
  const deleteUser = useMutation({ mutationFn: (id: string) => guestWifiApi.deleteUser(devId, id), onSuccess: invalidateAll });
  const kickGuest = useMutation({ mutationFn: (id: string) => guestWifiApi.disconnect(devId, id), onSuccess: invalidateAll });
  const addWg = useMutation({ mutationFn: (host: string) => guestWifiApi.addWalledGarden(devId, host), onSuccess: () => { setWgHost(''); invalidateAll(); } });
  const removeWg = useMutation({ mutationFn: (id: string) => guestWifiApi.removeWalledGarden(devId, id), onSuccess: invalidateAll });

  const vouchers = useMemo(() => users.filter(u => (u['comment'] || '').startsWith('voucher')), [users]);
  const networkName = overview?.servers?.[0]?.['name'] ?? 'Guest WiFi';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Guest WiFi</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            Captive portal, vouchers, and guest session management (RouterOS Hotspot)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-auto" value={devId} onChange={e => setDeviceId(parseInt(e.target.value))}>
            {online.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.device_type === 'wireless_ap' ? 'AP' : 'Router'})
              </option>
            ))}
          </select>
          <button className="btn-secondary flex items-center gap-2" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={clsx('w-4 h-4', isFetching && 'animate-spin')} />Refresh
          </button>
        </div>
      </div>

      {online.length === 0 ? (
        <div className="card p-10 text-center text-sm text-gray-400 dark:text-slate-500">No online devices.</div>
      ) : isLoading ? (
        <div className="card p-10 text-center text-sm text-gray-400 dark:text-slate-500">
          <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading hotspot state…
        </div>
      ) : !hasServer ? (
        canWrite
          ? <SetupWizard deviceId={devId} interfaces={overview?.interfaces ?? []}
              isAP={online.find(d => d.id === devId)?.device_type === 'wireless_ap'} onDone={invalidateAll} />
          : <div className="card p-10 text-center text-sm text-gray-400 dark:text-slate-500">No guest network configured on this device.</div>
      ) : (
        <>
          {/* Server status + KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {overview!.servers.map(s => {
              const disabled = s['disabled'] === 'true';
              return (
                <div key={s['.id']} className="card p-4 flex items-center gap-3">
                  <div className={clsx('p-2 rounded-lg', disabled ? 'bg-gray-100 dark:bg-slate-700' : 'bg-green-50 dark:bg-green-900/20')}>
                    <Wifi className={clsx('w-5 h-5', disabled ? 'text-gray-400' : 'text-green-600 dark:text-green-400')} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s['name']}</div>
                    <div className="text-xs text-gray-400 dark:text-slate-500 font-mono truncate">{s['interface']} · {disabled ? 'disabled' : 'running'}</div>
                  </div>
                  {canWrite && (
                    <button onClick={() => toggleServer.mutate({ id: s['.id'], disabled: !disabled })}
                      className={clsx('ml-auto p-1.5 rounded-lg transition-colors', disabled ? 'text-gray-400 hover:text-green-600' : 'text-green-500 hover:text-red-500')}
                      title={disabled ? 'Enable portal' : 'Disable portal'}>
                      <Power className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20"><Users className="w-5 h-5 text-blue-600 dark:text-blue-400" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{active.length}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400">Guests online</div>
              </div>
            </div>
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-900/20"><Ticket className="w-5 h-5 text-violet-600 dark:text-violet-400" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{vouchers.length}</div>
                <div className="text-xs text-gray-500 dark:text-slate-400">Vouchers issued</div>
              </div>
            </div>
          </div>

          {/* Voucher generator */}
          {canWrite && (
            <VoucherGenerator deviceId={devId} userProfiles={overview!.userProfiles} networkName={networkName} onCreated={invalidateAll} />
          )}

          {/* Vouchers table */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Ticket className="w-4 h-4 text-violet-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Vouchers ({vouchers.length})</h3>
              {vouchers.length > 0 && (
                <button className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                  onClick={() => printVouchers(vouchers.map(v => v['name']), { network: networkName })}>
                  <Printer className="w-3.5 h-3.5" />Print all
                </button>
              )}
            </div>
            {vouchers.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No vouchers yet — generate a batch above.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Code</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Profile</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Time limit</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Used</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Data</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Batch</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
                    {vouchers.map((v, i) => {
                      const used = (v['uptime'] && v['uptime'] !== '0s');
                      return (
                        <tr key={v['.id'] ?? i} className={clsx('hover:bg-blue-50/40 dark:hover:bg-slate-700/30', i % 2 === 0 ? 'bg-white dark:bg-slate-900/20' : 'bg-gray-50 dark:bg-slate-800/40')}>
                          <td className="px-4 py-2.5 font-mono font-semibold text-gray-900 dark:text-white">{v['name']}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">{v['profile'] || 'default'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400"><Clock className="w-3 h-3 inline mr-1" />{v['limit-uptime'] || '∞'}</td>
                          <td className="px-4 py-2.5 text-xs">
                            <span className={clsx('px-1.5 py-0.5 rounded-full font-medium', used ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400')}>
                              {used ? `used ${v['uptime']}` : 'unused'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400"><Database className="w-3 h-3 inline mr-1" />{v['limit-bytes-total'] ? formatBytes(v['limit-bytes-total']) : '∞'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500">{(v['comment'] || '').replace('voucher ', '')}</td>
                          <td className="px-4 py-2.5 text-right">
                            {canWrite && (
                              <button onClick={() => deleteUser.mutate(v['.id'])} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-slate-700" title="Delete voucher">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Active guests */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Guests online ({active.length})</h3>
            </div>
            {active.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No guests connected right now.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">User / Code</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">IP</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">MAC</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Session</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Down / Up</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
                    {active.map((a, i) => (
                      <tr key={a['.id'] ?? i} className={clsx('hover:bg-blue-50/40 dark:hover:bg-slate-700/30', i % 2 === 0 ? 'bg-white dark:bg-slate-900/20' : 'bg-gray-50 dark:bg-slate-800/40')}>
                        <td className="px-4 py-2.5 font-mono font-medium text-gray-900 dark:text-white">{a['user'] || '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-slate-400">{a['address'] || '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-slate-400">{a['mac-address'] || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">{a['uptime'] || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">{formatBytes(a['bytes-out'])} / {formatBytes(a['bytes-in'])}</td>
                        <td className="px-4 py-2.5 text-right">
                          {canWrite && (
                            <button onClick={() => kickGuest.mutate(a['.id'])} className="text-xs text-red-500 hover:text-red-600 hover:underline" title="Disconnect guest">
                              Disconnect
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Walled garden */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Walled garden</h3>
              <span className="text-xs text-gray-400 dark:text-slate-500">sites reachable before login</span>
            </div>
            <div className="p-4 space-y-3">
              {canWrite && (
                <div className="flex gap-2">
                  <input className="input flex-1 font-mono" value={wgHost} onChange={e => setWgHost(e.target.value)}
                    placeholder="*.example.com" onKeyDown={e => { if (e.key === 'Enter' && wgHost.trim()) addWg.mutate(wgHost.trim()); }} />
                  <button className="btn-secondary flex items-center gap-1.5" disabled={!wgHost.trim() || addWg.isPending} onClick={() => addWg.mutate(wgHost.trim())}>
                    <Plus className="w-4 h-4" />Allow
                  </button>
                </div>
              )}
              {walledGarden.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">No walled-garden entries.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {walledGarden.map((w, i) => (
                    <span key={w['.id'] ?? i} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs font-mono">
                      {w['dst-host'] || w['dst-address'] || '—'}
                      {canWrite && (
                        <button onClick={() => removeWg.mutate(w['.id'])} className="hover:text-red-500"><X className="w-3 h-3" /></button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
