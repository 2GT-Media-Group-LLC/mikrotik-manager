import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, RefreshCw, AlertTriangle, Save } from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { apiErrorMessage } from '../utils/apiError';

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch" aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span className={clsx('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
    </button>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="pt-0.5">{children}</div>
      <div>
        <div className="text-sm font-medium text-gray-700 dark:text-slate-200">{label}</div>
        {description && <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{description}</p>}
      </div>
    </div>
  );
}

export default function NetworkServicesNTPPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | ''>('');

  // Server form
  const [serverEnabled, setServerEnabled]   = useState(false);
  const [serverBroadcast, setServerBroadcast] = useState(false);
  const [serverManycast, setServerManycast]   = useState(false);

  // Client form
  const [clientEnabled, setClientEnabled]   = useState(false);
  const [clientMode, setClientMode]         = useState('unicast');
  const [clientServers, setClientServers]   = useState('');

  const [dirty, setDirty] = useState(false);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const deviceId = typeof selectedDeviceId === 'number' ? selectedDeviceId : 0;
  const selectedDevice = devices.find(d => d.id === deviceId);

  const { data: ntp, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ['ns-ntp', deviceId],
    queryFn: () => networkServicesApi.getNtp(deviceId).then(r => r.data),
    enabled: deviceId > 0,
  });

  // Conflict detection
  const { data: overview = [] } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as Record<string, unknown>[]),
    staleTime: 60_000,
  });
  const conflictDevices = overview.filter(d => {
    if ((d.id as number) === deviceId) return false;
    const n = d.ntp as { server_enabled: boolean } | null;
    return n?.server_enabled;
  });

  useEffect(() => {
    if (ntp) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setServerEnabled(ntp.server?.['enabled'] === 'yes');
      setServerBroadcast(ntp.server?.['broadcast'] === 'yes');
      setServerManycast(ntp.server?.['manycast'] === 'yes');
      setClientEnabled(ntp.client?.['enabled'] === 'yes');
      setClientMode(ntp.client?.['mode'] || 'unicast');
      setClientServers(ntp.client?.['servers'] || '');
      setDirty(false);
    }
  }, [ntp]);

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => networkServicesApi.setNtp(deviceId, {
      server_enabled: serverEnabled, server_broadcast: serverBroadcast, server_manycast: serverManycast,
      client_enabled: clientEnabled, client_mode: clientMode, client_servers: clientServers,
    }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['ns-ntp', deviceId] });
      qc.invalidateQueries({ queryKey: ['network-services-overview'] });
    },
  });

  function mark() { setDirty(true); }

  const serverHasData = ntp && Object.keys(ntp.server || {}).length > 0;
  const clientHasData = ntp && Object.keys(ntp.client || {}).length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">NTP Server</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Network Time Protocol server and client configuration</p>
        </div>
        {deviceId > 0 && (
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />Refresh
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

      {/* Conflict warning */}
      {conflictDevices.length > 0 && deviceId > 0 && serverEnabled && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>NTP server also enabled on: <strong>{conflictDevices.map(d => d.name as string).join(', ')}</strong>. Multiple NTP servers may cause time drift.</span>
        </div>
      )}

      {deviceId === 0 && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Select a device above.</div>}
      {deviceId > 0 && isLoading && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}
      {deviceId > 0 && error && (
        <div className="card p-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />Failed: {(error as Error).message}
        </div>
      )}

      {ntp && (
        <div className="space-y-4">
          {/* NTP Server */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">NTP Server</h2>
              <span className="ml-auto">
                <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                  serverEnabled ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400')}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', serverEnabled ? 'bg-green-500' : 'bg-gray-400')} />
                  {serverEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </span>
            </div>
            <div className="p-5 space-y-4">
              {!serverHasData ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">This device has no NTP server. On RouterOS 6 it comes with the optional ntp package; the client below works without it.</p>
              ) : (
                <>
                  <SettingRow label="Enable NTP Server" description="Allow other devices on the network to sync their clocks to this device.">
                    <Toggle checked={serverEnabled} onChange={v => { setServerEnabled(v); mark(); }} disabled={!canWrite} />
                  </SettingRow>
                  <SettingRow label="Broadcast Mode" description="Periodically broadcast the current time on the local network segment.">
                    <Toggle checked={serverBroadcast} onChange={v => { setServerBroadcast(v); mark(); }} disabled={!canWrite || !serverEnabled} />
                  </SettingRow>
                  <SettingRow label="Manycast Mode" description="Respond to manycast NTP client requests.">
                    <Toggle checked={serverManycast} onChange={v => { setServerManycast(v); mark(); }} disabled={!canWrite || !serverEnabled} />
                  </SettingRow>
                </>
              )}
            </div>
          </div>

          {/* NTP Client */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">NTP Client</h2>
              <span className="ml-auto">
                <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                  clientEnabled ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400')}>
                  <span className={clsx('w-1.5 h-1.5 rounded-full', clientEnabled ? 'bg-green-500' : 'bg-gray-400')} />
                  {clientEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </span>
            </div>
            <div className="p-5 space-y-4">
              {!clientHasData ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">NTP client settings not available (requires RouterOS 7).</p>
              ) : (
                <>
                  <SettingRow label="Enable NTP Client" description="Sync this device's clock to upstream NTP servers.">
                    <Toggle checked={clientEnabled} onChange={v => { setClientEnabled(v); mark(); }} disabled={!canWrite} />
                  </SettingRow>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Mode</label>
                    <select className="input w-full max-w-xs" value={clientMode}
                      onChange={e => { setClientMode(e.target.value); mark(); }} disabled={!canWrite || !clientEnabled}>
                      <option value="unicast">Unicast (direct server)</option>
                      <option value="broadcast">Broadcast (listen for broadcasts)</option>
                      <option value="multicast">Multicast</option>
                      <option value="manycast">Manycast (auto-discover)</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                      Unicast is recommended for most setups.
                    </p>
                  </div>

                  {(clientMode === 'unicast' || clientMode === 'manycast') && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">NTP Servers</label>
                      <input type="text" className="input w-full max-w-sm" value={clientServers}
                        onChange={e => { setClientServers(e.target.value); mark(); }}
                        placeholder="pool.ntp.org,time.cloudflare.com" disabled={!canWrite || !clientEnabled} />
                      <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Comma-separated list of NTP server addresses.</p>
                    </div>
                  )}

                  {ntp.client['status'] && (
                    <div className="pt-3 border-t border-gray-100 dark:border-slate-800">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        <div>
                          <div className="text-xs text-gray-400 dark:text-slate-500 mb-0.5">Sync Status</div>
                          <div className="text-sm font-medium text-gray-900 dark:text-white capitalize">{ntp.client['status']}</div>
                        </div>
                        {ntp.client['synced-server'] && (
                          <div>
                            <div className="text-xs text-gray-400 dark:text-slate-500 mb-0.5">Synced Server</div>
                            <div className="text-sm font-medium text-gray-900 dark:text-white">{ntp.client['synced-server']}</div>
                          </div>
                        )}
                        {ntp.client['last-adjustment'] && (
                          <div>
                            <div className="text-xs text-gray-400 dark:text-slate-500 mb-0.5">Last Adjustment</div>
                            <div className="text-sm font-medium text-gray-900 dark:text-white">{ntp.client['last-adjustment']}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Save bar */}
          {canWrite && dirty && (
            <div className="card p-4 flex items-center gap-3">
              <button onClick={() => save.mutate()} disabled={save.isPending}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
                <Save className="w-3.5 h-3.5" />{save.isPending ? 'Saving…' : 'Save Changes'}
              </button>
              <button onClick={() => {
                if (ntp) {
                  setServerEnabled(ntp.server?.['enabled'] === 'yes');
                  setServerBroadcast(ntp.server?.['broadcast'] === 'yes');
                  setServerManycast(ntp.server?.['manycast'] === 'yes');
                  setClientEnabled(ntp.client?.['enabled'] === 'yes');
                  setClientMode(ntp.client?.['mode'] || 'unicast');
                  setClientServers(ntp.client?.['servers'] || '');
                  setDirty(false);
                }
              }} className="text-sm text-gray-500 hover:text-gray-700">Discard</button>
              {save.isError && <span className="text-sm text-red-500">{apiErrorMessage(save.error)}</span>}
              {save.isSuccess && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
