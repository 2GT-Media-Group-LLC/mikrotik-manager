import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Globe, RefreshCw, AlertTriangle, Save, Trash2, Plus, Pencil, X, Check, Eraser,
} from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';

type NS = Record<string, string>;

// ─── DNS record types ─────────────────────────────────────────────────────────

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'TXT', 'SRV'] as const;
type RecordType = typeof RECORD_TYPES[number];

// ─── Static record form modal ─────────────────────────────────────────────────

interface RecordFormProps {
  deviceId: number;
  existing?: NS;
  onClose: () => void;
}

function RecordForm({ deviceId, existing, onClose }: RecordFormProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.['name'] || '');
  const [type, setType] = useState<RecordType>((existing?.['type'] as RecordType) || 'A');
  const [address, setAddress] = useState(existing?.['address'] || '');
  const [cname, setCname] = useState(existing?.['cname'] || '');
  const [text, setText] = useState(existing?.['text'] || '');
  const [ttl, setTtl] = useState(existing?.['ttl'] || '');
  const [disabled, setDisabled] = useState(existing?.['disabled'] === 'true');

  const save = useMutation({
    mutationFn: () => {
      const body: NS = { name, type };
      if (type === 'A' || type === 'AAAA') body['address'] = address;
      else if (type === 'CNAME') body['cname'] = cname;
      else if (type === 'TXT') body['text'] = text;
      else body['address'] = address; // MX, NS, PTR, SRV share address field
      if (ttl) body['ttl'] = ttl;
      else if (existing) body['ttl'] = '';   // back to the default TTL on the device
      body['disabled'] = disabled ? 'yes' : 'no';

      return existing?.['.id']
        ? networkServicesApi.updateDnsStatic(deviceId, existing['.id'], body)
        : networkServicesApi.addDnsStatic(deviceId, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-dns', deviceId] }); onClose(); },
  });

  const valueLabel = type === 'CNAME' ? 'CNAME Target' : type === 'TXT' ? 'Text' : 'Address / Target';
  const valuePlaceholder =
    type === 'A' ? '192.168.1.10' :
    type === 'AAAA' ? '2001:db8::1' :
    type === 'CNAME' ? 'alias.example.com' :
    type === 'TXT' ? '"v=spf1 include:example.com ~all"' :
    type === 'MX' || type === 'NS' ? 'mail.example.com' :
    type === 'PTR' ? 'hostname.example.com' :
    '_sip._tcp.example.com';

  const valueField = type === 'TXT'
    ? <textarea className="input w-full h-20 resize-y" value={text} onChange={e => setText(e.target.value)} placeholder={valuePlaceholder} />
    : type === 'CNAME'
    ? <input className="input w-full" value={cname} onChange={e => setCname(e.target.value)} placeholder={valuePlaceholder} />
    : <input className="input w-full" value={address} onChange={e => setAddress(e.target.value)} placeholder={valuePlaceholder} />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {existing ? 'Edit' : 'Add'} DNS Record
          </h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Name *</label>
              <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="hostname.local" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Type</label>
              <select className="input w-full" value={type} onChange={e => setType(e.target.value as RecordType)}>
                {RECORD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">{valueLabel} *</label>
            {valueField}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">TTL</label>
              <input className="input w-full" value={ttl} onChange={e => setTtl(e.target.value)} placeholder="e.g. 5m (blank = default)" />
            </div>
            <div className="flex items-end gap-2 pb-0.5">
              <button role="switch" aria-checked={disabled}
                onClick={() => setDisabled(v => !v)}
                className={clsx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors mb-0.5', disabled ? 'bg-gray-300 dark:bg-slate-600' : 'bg-blue-600')}>
                <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', disabled ? 'translate-x-0' : 'translate-x-4')} />
              </button>
              <span className="text-xs text-gray-600 dark:text-slate-300">Enabled</span>
            </div>
          </div>
        </div>
        <div className="px-5 pb-4 flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={!name || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
            <Check className="w-3.5 h-3.5" />
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{(save.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function NetworkServicesDNSPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | ''>('');

  // Settings form state
  const [serversInput, setServersInput] = useState('');
  const [allowRemote, setAllowRemote] = useState(false);
  const [maxUdpSize, setMaxUdpSize] = useState('');
  const [cacheSize, setCacheSize] = useState('');
  const [cacheMaxTtl, setCacheMaxTtl] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [recordForm, setRecordForm] = useState<NS | null | 'new'>(null);
  const [flushMsg, setFlushMsg] = useState('');

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const deviceId = typeof selectedDeviceId === 'number' ? selectedDeviceId : 0;
  const selectedDevice = devices.find(d => d.id === deviceId);

  const { data: dns, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ['ns-dns', deviceId],
    queryFn: () => networkServicesApi.getDns(deviceId).then(r => r.data),
    enabled: deviceId > 0,
  });

  // Sync settings form
  useEffect(() => {
    if (dns?.settings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setServersInput(dns.settings['servers'] || '');
      setAllowRemote(dns.settings['allow-remote-requests'] === 'yes');
      setMaxUdpSize(dns.settings['max-udp-packet-size'] || '');
      setCacheSize(dns.settings['cache-size'] || '');
      setCacheMaxTtl(dns.settings['cache-max-ttl'] || '');
      setSettingsDirty(false);
    }
  }, [dns?.settings]);

  // Conflict detection
  const { data: overview = [] } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as NS[]),
    staleTime: 60_000,
  });
  const conflictDevices = overview.filter(d => {
    if (parseInt(d['id']) === deviceId) return false;
    return (d['dns'] as unknown as { allow_remote: boolean } | null)?.allow_remote;
  });

  const saveSettings = useMutation({
    mutationFn: () => networkServicesApi.setDns(deviceId, {
      servers: serversInput, allow_remote_requests: allowRemote,
      max_udp_packet_size: maxUdpSize, cache_size: cacheSize, cache_max_ttl: cacheMaxTtl,
    }),
    onSuccess: () => { setSettingsDirty(false); qc.invalidateQueries({ queryKey: ['ns-dns', deviceId] }); qc.invalidateQueries({ queryKey: ['network-services-overview'] }); },
  });

  const flushCache = useMutation({
    mutationFn: () => networkServicesApi.flushDns(deviceId),
    onSuccess: () => { setFlushMsg('Cache flushed'); setTimeout(() => setFlushMsg(''), 3000); },
  });

  const deleteRecord = useMutation({
    mutationFn: (id: string) => networkServicesApi.deleteDnsStatic(deviceId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ns-dns', deviceId] }),
  });

  const statics = dns?.statics || [];

  function mark() { setSettingsDirty(true); }

  return (
    <div className="space-y-6">
      {/* Record form modal */}
      {recordForm && (
        <RecordForm
          deviceId={deviceId}
          existing={recordForm === 'new' ? undefined : recordForm as NS}
          onClose={() => setRecordForm(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">DNS Server</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">DNS resolver settings and static records</p>
        </div>
        {deviceId > 0 && (
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
            Refresh
          </button>
        )}
      </div>

      {/* Device selector */}
      <div className="card p-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-2">Select Device</label>
        <select className="input w-full max-w-xs" value={selectedDeviceId}
          onChange={e => setSelectedDeviceId(e.target.value === '' ? '' : parseInt(e.target.value))}>
          <option value="">— Choose a device —</option>
          {devices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.ip_address}){d.status !== 'online' ? ' — offline' : ''}</option>)}
        </select>
        {selectedDevice?.status !== 'online' && deviceId > 0 && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />This device is currently offline.
          </div>
        )}
      </div>

      {conflictDevices.length > 0 && deviceId > 0 && allowRemote && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>DNS remote requests also enabled on: <strong>{conflictDevices.map(d => d['name']).join(', ')}</strong>. Multiple DNS servers may cause resolution issues.</span>
        </div>
      )}

      {deviceId === 0 && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Select a device above.</div>}
      {deviceId > 0 && isLoading && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}
      {deviceId > 0 && error && (
        <div className="card p-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />Failed: {(error as Error).message}
        </div>
      )}

      {dns && (
        <>
          {/* ─── Settings ────────────────────────────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Globe className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">DNS Settings</h2>
              <div className="ml-auto flex items-center gap-2">
                {canWrite && (
                  <button
                    onClick={() => flushCache.mutate()}
                    disabled={flushCache.isPending}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-gray-600 dark:text-slate-300 border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                  >
                    <Eraser className="w-3 h-3" />
                    {flushCache.isPending ? 'Flushing…' : 'Flush Cache'}
                  </button>
                )}
                {flushMsg && <span className="text-xs text-green-600 dark:text-green-400">{flushMsg}</span>}
              </div>
            </div>
            <div className="p-5 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Upstream DNS Servers</label>
                <input type="text" className="input w-full max-w-sm" value={serversInput}
                  onChange={e => { setServersInput(e.target.value); mark(); }} placeholder="8.8.8.8,1.1.1.1" disabled={!canWrite} />
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Comma-separated upstream resolver addresses.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Max UDP Packet Size</label>
                  <input type="text" className="input w-full" value={maxUdpSize}
                    onChange={e => { setMaxUdpSize(e.target.value); mark(); }} placeholder="4096" disabled={!canWrite} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Cache Max TTL</label>
                  <input type="text" className="input w-full" value={cacheMaxTtl}
                    onChange={e => { setCacheMaxTtl(e.target.value); mark(); }} placeholder="e.g. 1d" disabled={!canWrite} />
                </div>
              </div>

              <div className="flex items-start gap-3">
                <button role="switch" aria-checked={allowRemote}
                  onClick={() => { if (canWrite) { setAllowRemote(v => !v); mark(); } }}
                  disabled={!canWrite}
                  className={clsx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5',
                    allowRemote ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600', !canWrite && 'opacity-50 cursor-not-allowed')}>
                  <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', allowRemote ? 'translate-x-4' : 'translate-x-0')} />
                </button>
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-slate-200">Allow Remote Requests</div>
                  <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Allow other devices to use this router as a DNS resolver.</p>
                </div>
              </div>

              {/* Read-only stats */}
              {(dns.settings['cache-used'] || dns.settings['cache-size'] || dns.settings['dynamic-servers']) && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-3 border-t border-gray-100 dark:border-slate-800">
                  {dns.settings['cache-size'] && <div><div className="text-xs text-gray-400 mb-0.5">Cache Size</div><div className="text-sm font-medium text-gray-900 dark:text-white">{dns.settings['cache-size']} KiB</div></div>}
                  {dns.settings['cache-used'] && <div><div className="text-xs text-gray-400 mb-0.5">Cache Used</div><div className="text-sm font-medium text-gray-900 dark:text-white">{dns.settings['cache-used']} KiB</div></div>}
                  {dns.settings['dynamic-servers'] && <div><div className="text-xs text-gray-400 mb-0.5">Dynamic Servers</div><div className="text-sm font-medium text-gray-900 dark:text-white">{dns.settings['dynamic-servers']}</div></div>}
                </div>
              )}

              {canWrite && settingsDirty && (
                <div className="flex items-center gap-3 pt-2">
                  <button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
                    <Save className="w-3.5 h-3.5" />{saveSettings.isPending ? 'Saving…' : 'Save Changes'}
                  </button>
                  <button onClick={() => {
                    const s = dns.settings;
                    setServersInput(s['servers'] || ''); setAllowRemote(s['allow-remote-requests'] === 'yes');
                    setMaxUdpSize(s['max-udp-packet-size'] || ''); setCacheSize(s['cache-size'] || '');
                    setCacheMaxTtl(s['cache-max-ttl'] || ''); setSettingsDirty(false);
                  }} className="text-sm text-gray-500 hover:text-gray-700">Discard</button>
                  {saveSettings.isError && <span className="text-xs text-red-500">{(saveSettings.error as Error).message}</span>}
                </div>
              )}
              {canWrite && saveSettings.isSuccess && !settingsDirty && (
                <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
              )}
            </div>
          </div>

          {/* ─── Static Records ───────────────────────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Globe className="w-4 h-4 text-green-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Static DNS Records</h2>
              <span className="text-xs text-gray-400 dark:text-slate-500 ml-1">{statics.length}</span>
              {canWrite && (
                <button onClick={() => setRecordForm('new')}
                  className="ml-auto flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
                  <Plus className="w-3 h-3" />Add Record
                </button>
              )}
            </div>
            {statics.length === 0 ? (
              <div className="px-5 py-6 text-sm text-gray-400 dark:text-slate-500 text-center">No static records configured.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Type</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Value</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">TTL</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                      {canWrite && <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {statics.map((r, i) => {
                      const isDisabled = r['disabled'] === 'true';
                      const value = r['address'] || r['cname'] || r['text'] || '—';
                      return (
                        <tr key={r['.id'] || i} className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40', i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{r['name'] || '—'}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-mono font-medium">
                              {r['type'] || 'A'}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-slate-300 max-w-xs truncate">{value}</td>
                          <td className="px-4 py-3 text-gray-500 dark:text-slate-400 text-xs">{r['ttl'] || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                              isDisabled ? 'bg-gray-100 dark:bg-slate-700 text-gray-500' : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400')}>
                              <span className={clsx('w-1.5 h-1.5 rounded-full', isDisabled ? 'bg-gray-400' : 'bg-green-500')} />
                              {isDisabled ? 'Disabled' : 'Active'}
                            </span>
                          </td>
                          {canWrite && (
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => setRecordForm(r)} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"><Pencil className="w-3.5 h-3.5" /></button>
                                <button onClick={() => { if (confirm(`Delete record "${r['name']}"?`)) deleteRecord.mutate(r['.id']); }}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
