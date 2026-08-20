import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wifi, Plus, Pencil, Trash2, RefreshCw, ChevronDown, ChevronRight,
  Eye, EyeOff, CheckCircle, XCircle, Power, ScanLine, Radio,
} from 'lucide-react';
import { wirelessApi, settingsApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import type { WirelessAP } from '../types';
import clsx from 'clsx';

// ─── Radio helpers ────────────────────────────────────────────────────────────

function parseRadioLabel(radio: Record<string, string>): string {
  const iface = radio['interface'] || radio['name'] || '';
  const bands = radio['bands'] || '';
  const hwType = radio['hw-type'] || '';

  // Determine primary frequency from band prefixes
  const has6g = bands.includes('6ghz');
  const has5g = bands.includes('5ghz');
  const freqLabel = has6g ? '6 GHz' : has5g ? '5 GHz' : '2.4 GHz';

  // Highest supported standard
  const standard = bands.includes('-ax:') ? 'Wi-Fi 6 (802.11ax)'
    : bands.includes('-ac:')              ? 'Wi-Fi 5 (802.11ac)'
    : bands.includes('-n:')               ? 'Wi-Fi 4 (802.11n)'
    :                                       '802.11g/b';

  const hw = hwType ? ` · ${hwType}` : '';
  return `${iface} — ${freqLabel} ${standard}${hw}`;
}

/** Filter BANDS_WIFI to only show bands supported by the given radio. */
function getFilteredBands(radioName: string, radioInfo: Record<string, string>[]) {
  const radio = radioInfo.find(r => r['interface'] === radioName);
  if (!radio) return BANDS_WIFI;
  const bands = radio['bands'] || '';
  const has2g = bands.includes('2ghz');
  const has5g = bands.includes('5ghz');
  const has6g = bands.includes('6ghz');
  return BANDS_WIFI.filter(b => {
    if (!b.value) return true; // always show Auto
    if (b.value.startsWith('2ghz') && !has2g) return false;
    if (b.value.startsWith('5ghz') && !has5g) return false;
    if (b.value.startsWith('6ghz') && !has6g) return false;
    return true;
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveIface {
  '.id'?: string;
  name: string;
  ssid?: string;
  mode?: string;
  band?: string;
  frequency?: string;
  'channel-width'?: string;
  'tx-power'?: string;
  'tx-power-mode'?: string;
  'antenna-gain'?: string;
  country?: string;
  installation?: string;
  disabled?: string;
  running?: string;
  'mac-address'?: string;
  security?: string;          // new wifi pkg: named security profile reference
  'security-profile'?: string; // legacy pkg
  'master-interface'?: string;
  bridge?: string;            // bridge this interface is a member of
  'bridge-pvid'?: string;     // PVID (untagged VLAN) on the bridge port
  [key: string]: string | undefined;
}


// RouterOS 7 wifi package band values (used when interface names are wifi1/wifi2)
const BANDS_WIFI = [
  { value: '',          label: 'Auto (device default)' },
  { value: '2ghz-ax',  label: '2.4 GHz — 802.11ax (Wi-Fi 6)' },
  { value: '2ghz-n',   label: '2.4 GHz — 802.11n' },
  { value: '2ghz-g',   label: '2.4 GHz — 802.11g' },
  { value: '2ghz-b',   label: '2.4 GHz — 802.11b' },
  { value: '5ghz-ax',  label: '5 GHz — 802.11ax (Wi-Fi 6)' },
  { value: '5ghz-ac',  label: '5 GHz — 802.11ac' },
  { value: '5ghz-n',   label: '5 GHz — 802.11n' },
  { value: '5ghz-a',   label: '5 GHz — 802.11a' },
  { value: '6ghz-ax',  label: '6 GHz — 802.11ax (Wi-Fi 6E)' },
];

// Legacy wireless package band values (used when interface names are wlan1/wlan2)
const BANDS_LEGACY = [
  { value: '',              label: 'Auto (device default)' },
  { value: '2ghz-b/g/n',   label: '2.4 GHz (b/g/n)' },
  { value: '2ghz-b/g',     label: '2.4 GHz (b/g)' },
  { value: '2ghz-onlyn',   label: '2.4 GHz (n only)' },
  { value: '2ghz-onlyg',   label: '2.4 GHz (g only)' },
  { value: '5ghz-a/n/ac',  label: '5 GHz (a/n/ac)' },
  { value: '5ghz-a/n',     label: '5 GHz (a/n)' },
  { value: '5ghz-onlyac',  label: '5 GHz (ac only)' },
  { value: '5ghz-onlyn',   label: '5 GHz (n only)' },
];

const CHANNEL_WIDTHS = [
  { value: '',               label: 'Auto (device default)' },
  { value: '20mhz',          label: '20 MHz' },
  { value: '40mhz',          label: '40 MHz' },
  { value: '80mhz',          label: '80 MHz' },
  { value: '160mhz',         label: '160 MHz' },
  { value: '20/40mhz',       label: '20/40 MHz' },
  { value: '20/40/80mhz',    label: '20/40/80 MHz' },
  { value: '80+80mhz',       label: '80+80 MHz' },
];

// RouterOS 7 wifi package modes
const MODES_WIFI = [
  { value: 'ap',          label: 'AP (access point)' },
  { value: 'station',     label: 'Station (client)' },
  { value: 'mesh-point',  label: 'Mesh Point' },
];

// Legacy wireless package modes
const MODES_LEGACY = [
  { value: 'ap-bridge',            label: 'AP Bridge (multi-client AP)' },
  { value: 'bridge',               label: 'Bridge (single-client AP)' },
  { value: 'station',              label: 'Station (client)' },
  { value: 'station-bridge',       label: 'Station Bridge' },
  { value: 'station-pseudobridge', label: 'Station Pseudobridge' },
  { value: 'wds-slave',            label: 'WDS Slave' },
];

const TX_POWER_MODES = [
  { value: 'default',         label: 'Default (card max)' },
  { value: 'card-rates',      label: 'Card Rates' },
  { value: 'all-rates-once',  label: 'All Rates Once' },
  { value: 'manual-table',    label: 'Manual Table' },
];

const AUTH_TYPES = ['wpa-psk', 'wpa2-psk', 'wpa3-psk', 'wpa-eap', 'wpa2-eap', 'wpa3-eap'];

// WPA1 and WPA3 cannot coexist — MikroTik rejects the combination
const WPA1 = new Set(['wpa-psk', 'wpa-eap']);
const WPA3 = new Set(['wpa3-psk', 'wpa3-eap']);

/** Returns true when enabling `authType` would create an invalid WPA1+WPA3 mix. */
function isAuthConflict(selected: string[], authType: string): boolean {
  if (selected.includes(authType)) return false; // already on — unchecking is always allowed
  const hasWpa1 = selected.some(t => WPA1.has(t));
  const hasWpa3 = selected.some(t => WPA3.has(t));
  if (WPA3.has(authType) && hasWpa1) return true;
  if (WPA1.has(authType) && hasWpa3) return true;
  return false;
}
// ─── Small helpers ────────────────────────────────────────────────────────────

function PasswordInput({ value, onChange, placeholder = 'passphrase', disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        className="input pr-9"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        disabled={disabled}
      />
      <button
        type="button"
        tabIndex={-1}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        onClick={() => setShow(s => !s)}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function AdvancedSection({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-slate-800/60 text-sm font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700/50 transition-colors"
      >
        <span>Advanced Settings</span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {open && <div className="p-4 space-y-3 bg-white dark:bg-slate-800/20">{children}</div>}
    </div>
  );
}

function FormRow({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 items-start">
      <div className="col-span-1 pt-2">
        <label className="text-sm font-medium text-gray-700 dark:text-slate-300">{label}</label>
        {hint && <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{hint}</p>}
      </div>
      <div className="col-span-2">{children}</div>
    </div>
  );
}

// ─── SSID Modal ───────────────────────────────────────────────────────────────

interface SsidForm {
  ssid: string; mode: string; band: string;
  passphrase: string; authentication_types: string[];
  bridge: string; vlan_id: string;
  disabled: boolean; master_interface: string;
  // advanced
  frequency: string; channel_width: string; tx_power: string; tx_power_mode: string;
  antenna_gain: string; country: string; installation: string;
}

function defaultSsidForm(isNewWifiPkg: boolean, firstRadio: string, firstRadioBand = ''): SsidForm {
  return {
    ssid: '', mode: isNewWifiPkg ? 'ap' : 'ap-bridge', band: isNewWifiPkg ? firstRadioBand : '',
    passphrase: '', authentication_types: isNewWifiPkg ? ['wpa2-psk'] : [],
    bridge: '', vlan_id: '',
    disabled: false, master_interface: isNewWifiPkg ? firstRadio : '',
    frequency: '', channel_width: '', tx_power: '', tx_power_mode: 'default',
    antenna_gain: '0', country: '', installation: 'indoor',
  };
}

function SsidModal({
  apId, existing, isNewWifiPkg, availableRadios, allAps, onClose,
}: {
  apId: number;
  existing?: LiveIface;
  isNewWifiPkg: boolean;
  availableRadios: { name: string; band: string }[];
  allAps?: WirelessAP[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;

  // Bulk deployment state — create mode only
  const onlineAps = (allAps ?? []).filter(a => a.status === 'online');
  const [deployToApIds, setDeployToApIds] = useState<number[]>(() => onlineAps.map(a => a.id));
  const [deployOpen, setDeployOpen] = useState(true);
  const isBulk = !isEdit && deployToApIds.length > 1;

  // Fetch hardware radio info (needed for band filtering in new wifi pkg)
  const { data: radioInfo = [] } = useQuery({
    queryKey: ['wifi-radios', apId],
    queryFn:  () => wirelessApi.getRadios(apId).then(r => r.data as Record<string, string>[]),
    enabled:  isNewWifiPkg,
    staleTime: 300_000,
  });

  const radioLabelMap = new Map(radioInfo.map(r => [r['interface'], parseRadioLabel(r)]));
  const radioLabel = (name: string) => radioLabelMap.get(name) ?? name;

  // Fetch bridges — only needed in single-AP mode
  const { data: bridgeInfo = { bridges: [], ports: [] } } = useQuery({
    queryKey: ['wifi-bridges', apId],
    queryFn:  () => wirelessApi.getBridges(apId).then(r => r.data as {
      bridges: Record<string, string>[];
      ports:   Record<string, string>[];
    }),
    enabled: !isBulk,
    staleTime: 60_000,
  });

  const parseArr = (v?: string) => v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];

  const [form, setForm] = useState<SsidForm>(() => existing ? {
    ssid:                existing.ssid || '',
    mode:                existing.mode || (isNewWifiPkg ? 'ap' : 'ap-bridge'),
    band:                existing.band || '',
    passphrase:          existing['passphrase'] || '',
    authentication_types: parseArr(existing['authentication-types']).length > 0
      ? parseArr(existing['authentication-types'])
      : isNewWifiPkg ? ['wpa2-psk'] : [],
    bridge:              existing.bridge || '',
    vlan_id:             existing['bridge-pvid'] || '',
    disabled:            existing.disabled === 'true',
    master_interface:    existing['master-interface'] || '',
    frequency:           existing.frequency || '',
    channel_width:       existing['channel-width'] || '',
    tx_power:            existing['tx-power'] || '',
    tx_power_mode:       existing['tx-power-mode'] || 'default',
    antenna_gain:        existing['antenna-gain'] || '0',
    country:             existing.country || '',
    installation:        existing.installation || 'indoor',
  } : defaultSsidForm(isNewWifiPkg, availableRadios[0]?.name ?? '', availableRadios[0]?.band ?? ''));

  const set = (k: keyof SsidForm) => (v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const handleRadioChange = (radioName: string) => {
    const filtered = getFilteredBands(radioName, radioInfo);
    // Best supported band = first non-Auto entry; fall back to radio's current band
    const bestBand = filtered.find(b => b.value !== '')?.value
      ?? availableRadios.find(r => r.name === radioName)?.band
      ?? '';
    setForm(f => ({ ...f, master_interface: radioName, band: bestBand }));
  };

  // When radioInfo finishes loading, upgrade the initial radio's band to its best supported standard
  useEffect(() => {
    if (!isEdit && radioInfo.length > 0) {
      setForm(f => {
        if (!f.master_interface) return f;
        const filtered = getFilteredBands(f.master_interface, radioInfo);
        const bestBand = filtered.find(b => b.value !== '')?.value ?? f.band;
        return bestBand !== f.band ? { ...f, band: bestBand } : f;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radioInfo]);

  const currentRadioName = isEdit
    ? (existing?.['master-interface'] || existing?.name || '')
    : form.master_interface;
  const availableBands = isNewWifiPkg ? getFilteredBands(currentRadioName, radioInfo) : BANDS_LEGACY;

  const toggleAuthType = (val: string) => {
    setForm(f => {
      const arr = f.authentication_types;
      return { ...f, authentication_types: arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val] };
    });
  };

  // Single-AP mutation
  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => isEdit
      ? wirelessApi.updateInterface(apId, existing!.name, data)
      : wirelessApi.createInterface(deployToApIds[0] ?? apId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wireless-ifaces', apId] });
      onClose();
    },
  });

  // Bulk mutation
  type BulkResult = { id: number; name: string; ok: boolean; error?: string };
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
  const bulkMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      wirelessApi.bulkCreateInterfaces({ apIds: deployToApIds, ...data }),
    onSuccess: (res) => {
      const results = (res.data as { results: BulkResult[] }).results;
      setBulkResults(results);
      results.forEach(r => {
        if (r.ok) qc.invalidateQueries({ queryKey: ['wireless-ifaces', r.id] });
      });
    },
  });

  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.ssid.trim()) { setError('SSID name is required'); return; }
    if (!isEdit && form.authentication_types.length > 0 && !form.passphrase.trim()) {
      setError('Passphrase is required when authentication types are selected');
      return;
    }
    if (!isEdit && deployToApIds.length === 0) {
      setError('Select at least one AP to deploy to');
      return;
    }
    const data: Record<string, unknown> = {
      ssid: form.ssid, mode: form.mode, disabled: form.disabled,
    };
    if (form.band) data.band = form.band;
    if (form.passphrase.trim()) data.passphrase = form.passphrase;
    if (form.authentication_types.length > 0) data.authentication_types = form.authentication_types;
    // Bridge and radio are per-device — only apply in single-AP mode
    if (!isBulk) {
      data.bridge = form.bridge;
      if (form.bridge && form.vlan_id) data.vlan_id = form.vlan_id;
      if (form.master_interface) data.master_interface = form.master_interface;
    }
    if (form.frequency)     data.frequency     = form.frequency;
    if (form.channel_width) data.channel_width = form.channel_width;
    if (form.tx_power)      data.tx_power      = form.tx_power;
    if (form.tx_power_mode) data.tx_power_mode = form.tx_power_mode;
    if (form.antenna_gain)  data.antenna_gain  = form.antenna_gain;
    if (form.country)       data.country       = form.country;
    if (form.installation)  data.installation  = form.installation;

    if (isBulk) {
      bulkMutation.mutate(data);
    } else {
      mutation.mutate(data);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            {isEdit ? `Edit SSID — ${existing!.name}` : 'Add SSID / Virtual AP'}
          </h3>
        </div>

        {/* Bulk deployment results */}
        {bulkResults ? (
          <div className="p-5">
            <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
              Deployed to <strong>{bulkResults.filter(r => r.ok).length}</strong> of <strong>{bulkResults.length}</strong> APs.
            </p>
            <div className="space-y-2">
              {bulkResults.map(r => (
                <div key={r.id} className={clsx('flex items-start gap-2 text-sm',
                  r.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400')}>
                  {r.ok
                    ? <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                  <div>
                    <span className="font-medium">{r.name}</span>
                    {!r.ok && <p className="text-xs mt-0.5 text-red-400">{r.error}</p>}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-5 pt-4 border-t border-gray-100 dark:border-slate-700">
              <button className="btn-primary text-sm" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <FormRow label="SSID" hint="Broadcast network name">
            <input className="input" value={form.ssid} onChange={e => set('ssid')(e.target.value)} placeholder="MyNetwork" />
          </FormRow>

          {/* Bridge and VLAN — single-AP mode only (per-device in bulk) */}
          {!isBulk && (
            <>
              <FormRow label="Network (Bridge)" hint="Clients need a bridge to get an IP and pass traffic">
                <select className="input" value={form.bridge} onChange={e => {
                  set('bridge')(e.target.value);
                  if (!e.target.value) set('vlan_id')('');
                }}>
                  <option value="">— None (no network) —</option>
                  {bridgeInfo.bridges.map(b => (
                    <option key={b['name']} value={b['name']}>{b['name']}</option>
                  ))}
                </select>
              </FormRow>
              {form.bridge && (
                <FormRow label="VLAN ID (PVID)" hint="Untagged VLAN for this SSID; leave blank for untagged">
                  <input className="input" type="number" min={1} max={4094}
                    value={form.vlan_id} onChange={e => set('vlan_id')(e.target.value)} placeholder="e.g. 20" />
                </FormRow>
              )}
            </>
          )}

          {/* Radio selection — single-AP create only */}
          {!isBulk && isNewWifiPkg && !isEdit && (
            <FormRow label="Radio" hint="Physical radio to attach this SSID to">
              <select className="input" value={form.master_interface} onChange={e => handleRadioChange(e.target.value)}>
                {availableRadios.length > 0
                  ? availableRadios.map(r => <option key={r.name} value={r.name}>{radioLabel(r.name)}</option>)
                  : <option value="">No radios found</option>
                }
              </select>
            </FormRow>
          )}
          {/* Security — always shown; backend applies inline for new wifi pkg */}
          <FormRow label="Auth Types" hint="WPA1 and WPA3 cannot be combined">
            <div className="flex flex-wrap gap-3">
              {AUTH_TYPES.map(t => {
                const conflict = isAuthConflict(form.authentication_types, t);
                return (
                  <label key={t} className={clsx('flex items-center gap-1.5 select-none', conflict ? 'cursor-not-allowed opacity-40' : 'cursor-pointer')}>
                    <input
                      type="checkbox"
                      className="w-3.5 h-3.5 rounded"
                      checked={form.authentication_types.includes(t)}
                      disabled={conflict}
                      onChange={() => toggleAuthType(t)}
                    />
                    <span className="text-xs font-mono text-gray-700 dark:text-slate-300">{t}</span>
                  </label>
                );
              })}
            </div>
          </FormRow>
          <FormRow label="Passphrase" hint={isEdit ? 'Leave blank to keep existing' : 'Min 8 chars; leave blank for open'}>
            <PasswordInput
              value={form.passphrase}
              onChange={v => set('passphrase')(v)}
            />
          </FormRow>
          <FormRow label="Band">
            <select className="input" value={form.band} onChange={e => set('band')(e.target.value)}>
              {availableBands.map(b => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Mode">
            <select className="input" value={form.mode} onChange={e => set('mode')(e.target.value)}>
              {(isNewWifiPkg ? MODES_WIFI : MODES_LEGACY).map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Disabled">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded"
                checked={form.disabled}
                onChange={e => set('disabled')(e.target.checked)}
              />
              <span className="text-sm text-gray-600 dark:text-slate-400">Interface disabled</span>
            </label>
          </FormRow>

          {/* Advanced */}
          <AdvancedSection>
            <FormRow label="Frequency" hint="MHz (auto if blank)">
              <input className="input" type="number" value={form.frequency} onChange={e => set('frequency')(e.target.value)} placeholder="auto" />
            </FormRow>
            <FormRow label="Channel Width">
              <select className="input" value={form.channel_width} onChange={e => set('channel_width')(e.target.value)}>
                {CHANNEL_WIDTHS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </FormRow>
            {!isNewWifiPkg && (
              <>
                <FormRow label="TX Power" hint="dBm (empty = default)">
                  <input className="input" type="number" value={form.tx_power} onChange={e => set('tx_power')(e.target.value)} placeholder="default" />
                </FormRow>
                <FormRow label="TX Power Mode">
                  <select className="input" value={form.tx_power_mode} onChange={e => set('tx_power_mode')(e.target.value)}>
                    {TX_POWER_MODES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </FormRow>
                <FormRow label="Antenna Gain" hint="dBi">
                  <input className="input" type="number" value={form.antenna_gain} onChange={e => set('antenna_gain')(e.target.value)} placeholder="0" />
                </FormRow>
                <FormRow label="Country">
                  <input className="input" value={form.country} onChange={e => set('country')(e.target.value)} placeholder="united states" />
                </FormRow>
                <FormRow label="Installation">
                  <select className="input" value={form.installation} onChange={e => set('installation')(e.target.value)}>
                    <option value="indoor">Indoor</option>
                    <option value="outdoor">Outdoor</option>
                    <option value="any">Any</option>
                  </select>
                </FormRow>
                <FormRow label="Master Interface" hint="For virtual APs sharing a radio">
                  <input className="input" value={form.master_interface} onChange={e => set('master_interface')(e.target.value)} placeholder="wlan1" />
                </FormRow>
              </>
            )}
          </AdvancedSection>

          {/* Deploy to APs — shown in create mode when multiple APs exist */}
          {!isEdit && allAps && allAps.length > 1 && (
            <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <button type="button" onClick={() => setDeployOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-slate-800/60 text-sm font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700/50 transition-colors">
                <span>
                  Deploy to APs
                  <span className="ml-2 text-xs font-normal text-blue-600 dark:text-blue-400">
                    {deployToApIds.length} of {onlineAps.length} online selected
                  </span>
                </span>
                {deployOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              {deployOpen && (
                <div className="p-4 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer pb-2 border-b border-gray-100 dark:border-slate-700">
                    <input type="checkbox" className="w-3.5 h-3.5 rounded"
                      checked={deployToApIds.length === onlineAps.length && onlineAps.length > 0}
                      onChange={e => setDeployToApIds(e.target.checked ? onlineAps.map(a => a.id) : [])} />
                    <span className="text-sm font-medium text-gray-700 dark:text-slate-300">All online APs</span>
                  </label>
                  {allAps.map(ap => {
                    const isOnline = ap.status === 'online';
                    return (
                      <label key={ap.id} className={clsx('flex items-center gap-2 text-sm',
                        isOnline ? 'cursor-pointer' : 'cursor-not-allowed opacity-50')}>
                        <input type="checkbox" className="w-3.5 h-3.5 rounded"
                          checked={deployToApIds.includes(ap.id)} disabled={!isOnline}
                          onChange={e => setDeployToApIds(ids =>
                            e.target.checked ? [...ids, ap.id] : ids.filter(id => id !== ap.id)
                          )} />
                        <span className="text-gray-700 dark:text-slate-300">{ap.name}</span>
                        <span className="text-xs text-gray-400">{ap.ip_address}</span>
                        {!isOnline && <span className="text-xs text-amber-500">offline</span>}
                      </label>
                    );
                  })}
                  {isBulk && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 pt-2 border-t border-gray-100 dark:border-slate-700">
                      Bridge and radio settings are per-device — configure them individually after deployment.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
          {(mutation.error || bulkMutation.error) && (
            <p className="text-sm text-red-500">
              {((mutation.error || bulkMutation.error) as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Operation failed'}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={mutation.isPending || bulkMutation.isPending}>
              {(mutation.isPending || bulkMutation.isPending)
                ? 'Saving…'
                : isEdit ? 'Save Changes'
                : isBulk ? `Deploy to ${deployToApIds.length} APs`
                : 'Create SSID'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}

// ─── Spectral Scan Settings ───────────────────────────────────────────────────

const SPECTRAL_INTERVALS = [
  { value: 1,  label: 'Every hour' },
  { value: 6,  label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 48, label: 'Every 48 hours' },
];

function SpectralScanSettings({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then(r => r.data as Record<string, unknown>),
  });

  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnabled(!!settings['spectral_scan_enabled']);
      setIntervalHours((settings['spectral_scan_interval_hours'] as number) || 24);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      settingsApi.update({
        spectral_scan_enabled: enabled,
        spectral_scan_interval_hours: intervalHours,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <ScanLine className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Spectral Scan Schedule</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Automatically run spectrum scans on all wireless AP radios at the configured interval.
          Results are viewable in the <strong>Radio</strong> tab of each device.
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 rounded text-indigo-600"
              checked={enabled}
              disabled={!canWrite}
              onChange={e => setEnabled(e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable scheduled scans</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-slate-400">Interval:</label>
            <select
              className="input w-auto text-sm"
              value={intervalHours}
              disabled={!canWrite || !enabled}
              onChange={e => setIntervalHours(Number(e.target.value))}
            >
              {SPECTRAL_INTERVALS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {canWrite && (
            <button
              className="btn-primary text-sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saved ? 'Saved!' : saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── AP Scan Settings ─────────────────────────────────────────────────────────

const AP_SCAN_INTERVALS = [
  { value: 1,  label: 'Every hour' },
  { value: 6,  label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
  { value: 48, label: 'Every 48 hours' },
];

function APScanSettings({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then(r => r.data as Record<string, unknown>),
  });

  const [enabled, setEnabled]             = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [saved, setSaved]                 = useState(false);

  useEffect(() => {
    if (settings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnabled(!!settings['ap_scan_enabled']);
      setIntervalHours((settings['ap_scan_interval_hours'] as number) || 24);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      settingsApi.update({
        ap_scan_enabled: enabled,
        ap_scan_interval_hours: intervalHours,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <Radio className="w-4 h-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">AP Scan Schedule</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Automatically scan for nearby access points on all wireless AP radios at the configured
          interval. Results are viewable in the <strong>Radio</strong> tab of each device.
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 rounded text-blue-600"
              checked={enabled}
              disabled={!canWrite}
              onChange={e => setEnabled(e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Enable scheduled scans</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-slate-400">Interval:</label>
            <select
              className="input w-auto text-sm"
              value={intervalHours}
              disabled={!canWrite || !enabled}
              onChange={e => setIntervalHours(Number(e.target.value))}
            >
              {AP_SCAN_INTERVALS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {canWrite && (
            <button
              className="btn-primary text-sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saved ? 'Saved!' : saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function WirelessSettingsPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [selectedApId, setSelectedApId] = useState<number | null>(null);

  const { data: aps = [] } = useQuery({
    queryKey: ['wireless-aps'],
    queryFn: () => wirelessApi.list().then(r => r.data as WirelessAP[]),
  });

  // Auto-select first AP
  useEffect(() => {
    if (aps.length > 0 && selectedApId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedApId(aps[0].id);
    }
  }, [aps, selectedApId]);

  const selectedAp = aps.find(a => a.id === selectedApId);

  const { data: ifaces = [], isLoading: ifaceLoading, refetch: refetchIfaces } = useQuery({
    queryKey: ['wireless-ifaces', selectedApId],
    queryFn: () => wirelessApi.getInterfaces(selectedApId!).then(r => r.data as LiveIface[]),
    enabled: !!selectedApId && selectedAp?.status === 'online',
  });

  const deleteSsidMutation = useMutation({
    mutationFn: (name: string) => wirelessApi.deleteInterface(selectedApId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wireless-ifaces', selectedApId] }),
  });

  const toggleSsidMutation = useMutation({
    mutationFn: ({ name, disabled }: { name: string; disabled: boolean }) =>
      wirelessApi.updateInterface(selectedApId!, name, { disabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wireless-ifaces', selectedApId] }),
  });

  // Detect new RouterOS 7 wifi package by interface naming (wifi1/wifi2 vs wlan1/wlan2).
  // When ifaces haven't loaded yet, default to true so the security fields are visible.
  const isNewWifiPkg = ifaces.length > 0
    ? ifaces.some(i => i.name?.startsWith('wifi') || i['default-name']?.startsWith('wifi'))
    : true;

  const [ssidModal, setSsidModal] = useState<{ open: boolean; existing?: LiveIface }>({ open: false });

  const isOffline = selectedAp && selectedAp.status !== 'online';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Wireless Settings</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
          Manage SSIDs and radio configuration
        </p>
      </div>

      {/* AP selector */}
      {aps.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Access Point:</label>
          <select
            className="input w-auto"
            value={selectedApId ?? ''}
            onChange={e => setSelectedApId(Number(e.target.value))}
          >
            {aps.map(ap => (
              <option key={ap.id} value={ap.id}>
                {ap.name} ({ap.ip_address}) — {ap.status}
              </option>
            ))}
          </select>
        </div>
      )}

      {aps.length === 0 && (
        <div className="card p-8 text-center text-gray-400 dark:text-slate-500 text-sm">
          No wireless APs found. Add a device with type <strong>Wireless AP</strong> in Devices.
        </div>
      )}

      {selectedAp && (
        <>
          {isOffline && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              <strong>{selectedAp.name}</strong> is currently <strong>{selectedAp.status}</strong> — live configuration requires the device to be online.
            </div>
          )}

          {/* ── SSIDs ─────────────────────────────────────────────────────── */}
          <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                  Wireless Interfaces
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => refetchIfaces()}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                    title="Refresh"
                    disabled={isOffline}
                  >
                    <RefreshCw className={clsx('w-4 h-4', ifaceLoading && 'animate-spin')} />
                  </button>
                  {canWrite && !isOffline && (
                    <button
                      onClick={() => setSsidModal({ open: true })}
                      className="btn-primary flex items-center gap-1.5 text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Add SSID
                    </button>
                  )}
                </div>
              </div>

              {isOffline ? (
                <div className="p-8 text-center text-gray-400 dark:text-slate-500 text-sm">
                  Device must be online to view and manage SSIDs.
                </div>
              ) : ifaceLoading ? (
                <div className="p-8 text-center text-gray-400"><RefreshCw className="w-5 h-5 animate-spin inline mr-2" />Loading…</div>
              ) : ifaces.length === 0 ? (
                <div className="p-8 text-center text-gray-400 dark:text-slate-500 text-sm">No wireless interfaces found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                        <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Interface</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">SSID</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Network</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Band</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Security</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500 dark:text-slate-400">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
                      {ifaces.map((iface, i) => (
                        <tr key={iface.name} className={clsx(
                          'hover:bg-blue-50/40 dark:hover:bg-slate-700/30 transition-colors',
                          i % 2 === 1 ? 'bg-gray-50 dark:bg-slate-800/40' : 'bg-white dark:bg-slate-900/20'
                        )}>
                          <td className="px-4 py-3 font-mono text-xs font-medium text-gray-800 dark:text-slate-200">
                            {iface.name}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                            {iface.ssid || <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 dark:text-slate-400">
                            {iface.bridge
                              ? (
                                <span
                                  className="font-mono"
                                  title={iface['network_source'] === 'capsman-datapath'
                                    ? 'From the CAPsMAN datapath, not a local bridge port'
                                    : undefined}
                                >
                                  {iface.bridge}
                                  {iface['bridge-pvid'] ? <span className="text-gray-400"> VLAN {iface['bridge-pvid']}</span> : ''}
                                  {iface['network_source'] === 'capsman-datapath' && <span className="text-gray-400"> (datapath)</span>}
                                </span>
                              )
                              : iface['managed_by_capsman']
                                ? <span className="text-gray-400" title="This interface is provisioned by CAPsMAN and its datapath does not name a bridge">via controller</span>
                                : <span className="text-amber-500 font-medium">no network</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 dark:text-slate-400">
                            {iface.band || '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 dark:text-slate-400">
                            {iface['security'] && !iface['security'].startsWith('*')
                              ? iface['security']
                              : iface['security-profile']
                              ? iface['security-profile']
                              : iface['authentication-types']
                              ? <span className="text-green-600 dark:text-green-400">{iface['authentication-types']}</span>
                              : <span className="text-amber-500 font-medium">open</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {iface.disabled === 'true' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                                <XCircle className="w-3 h-3" />Disabled
                              </span>
                            ) : iface.running === 'true' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                                <CheckCircle className="w-3 h-3" />Running
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                                <Power className="w-3 h-3" />Enabled, not running
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {canWrite && (
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => toggleSsidMutation.mutate({ name: iface.name, disabled: iface.disabled !== 'true' })}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
                                  title={iface.disabled === 'true' ? 'Enable' : 'Disable'}
                                >
                                  <Power className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => setSsidModal({ open: true, existing: iface })}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                  title="Edit"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => {
                                    if (confirm(`Delete SSID "${iface.name}"?`))
                                      deleteSsidMutation.mutate(iface.name);
                                  }}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                  title="Delete"
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
                </div>
              )}
            </div>
        </>
      )}

      {/* ── Spectral Scan Schedule ───────────────────────────────────── */}
      <SpectralScanSettings canWrite={canWrite} />

      {/* ── AP Scan Schedule ─────────────────────────────────────────── */}
      <APScanSettings canWrite={canWrite} />

      {/* Modals */}
      {ssidModal.open && selectedApId && (
        <SsidModal
          apId={selectedApId}
          existing={ssidModal.existing}
          isNewWifiPkg={!!isNewWifiPkg}
          availableRadios={ifaces.filter(i => !i['master-interface'] && i.name).map(i => ({ name: i.name, band: i.band || i['channel.band'] || '' }))}
          allAps={aps}
          onClose={() => setSsidModal({ open: false })}
        />
      )}
    </div>
  );
}
