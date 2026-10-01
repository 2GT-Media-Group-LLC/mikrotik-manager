import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, RefreshCw, AlertTriangle, Save, CheckCircle, XCircle, Radio,
} from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { networkServicesApi, settingsApi, trafficApi } from '../services/api';
import { useCanWrite, useIsFleetAdmin } from '../hooks/useCanWrite';

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

export default function NetworkServicesNetflowPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();

  // ── Collector settings ────────────────────────────────────────────────────
  const { data: settings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsApi.get().then(r => r.data),
  });

  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('2055');
  const [version, setVersion] = useState('9');
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    if (settings && !loaded) {
      setEnabled(settings['netflow_enabled'] === true);
      setAddress(String(settings['netflow_collector_address'] ?? ''));
      setPort(String(settings['netflow_collector_port'] ?? '2055'));
      setVersion(String(settings['netflow_version'] ?? '9'));
      setAcceptUnknown(settings['netflow_accept_unknown'] === true);
      setLoaded(true);
    }
  }, [settings, loaded]);

  async function saveCollectorSettings(overrides: Record<string, unknown> = {}) {
    setSaving(true); setSaveMsg('');
    try {
      await settingsApi.update({
        netflow_enabled: enabled,
        netflow_collector_address: address.trim(),
        netflow_collector_port: parseInt(port, 10) || 2055,
        netflow_version: version,
        ...overrides,
      });
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      qc.invalidateQueries({ queryKey: ['traffic-status'] });
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e) {
      setSaveMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleListenerToggle(value: boolean) {
    setEnabled(value);
    await saveCollectorSettings({ netflow_enabled: value });
  }

  // ── Collector status (live) ───────────────────────────────────────────────
  // A site-limited account gets its own exporters only (P1-7).
  const isFleetAdmin = useIsFleetAdmin();
  const { data: status } = useQuery({
    queryKey: ['traffic-status'],
    queryFn: () => trafficApi.status().then(r => r.data),
    refetchInterval: 10_000,
  });

  // ── Fleet device state ────────────────────────────────────────────────────
  const { data: fleet, isLoading: fleetLoading, refetch, isFetching, error: fleetError } = useQuery({
    queryKey: ['ns-netflow-fleet'],
    queryFn: () => networkServicesApi.netflowFleet().then(r => r.data),
  });

  const [togglePending, setTogglePending] = useState<number | null>(null);
  const [toggleError, setToggleError] = useState('');

  async function handleDeviceToggle(deviceId: number, value: boolean) {
    setTogglePending(deviceId); setToggleError('');
    try {
      await networkServicesApi.setNetflow(deviceId, value);
      qc.invalidateQueries({ queryKey: ['ns-netflow-fleet'] });
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } }; message: string };
      setToggleError(err.response?.data?.error || err.message);
    } finally {
      setTogglePending(null);
    }
  }

  const addressMissing = !address.trim();
  const devices = fleet?.devices ?? [];
  const unidentified = (status?.exporters ?? []).filter(e => e.deviceId < 0);
  const rejected = status?.rejectedSources ?? [];

  async function handleAcceptUnknown(value: boolean) {
    setAcceptUnknown(value);
    await saveCollectorSettings({ netflow_accept_unknown: value });
  }

  function deviceBadge(d: (typeof devices)[number]) {
    if (d.error) {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"><XCircle className="w-3 h-3" />Unreachable</span>;
    }
    if (!d.enabled) {
      return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">Disabled</span>;
    }
    if (!d.target_matches_collector) {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"><AlertTriangle className="w-3 h-3" />Wrong target</span>;
    }
    if (!d.last_flow_at) {
      return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">No flows yet</span>;
    }
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"><CheckCircle className="w-3 h-3" />Exporting</span>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">NetFlow</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Per-client traffic analytics via NetFlow/IPFIX export — view results on the{' '}
            <Link to="/traffic" className="text-blue-600 dark:text-blue-400 hover:underline">Traffic</Link> page
          </p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />Refresh
        </button>
      </div>

      {/* Collector card */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <Radio className="w-4 h-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Collector</h2>
          {status && (
            <span className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
              status.listening
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400')}>
              <span className={clsx('w-1.5 h-1.5 rounded-full', status.listening ? 'bg-green-500' : 'bg-gray-400')} />
              {status.listening ? `Listening on udp/${status.port}` : 'Stopped'}
            </span>
          )}
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <Toggle checked={enabled} onChange={handleListenerToggle} disabled={!canWrite || saving} />
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-slate-200">Enable NetFlow collector</div>
              <p className="text-xs text-gray-400 dark:text-slate-500">
                Receives NetFlow v9 / IPFIX exports from your MikroTik devices and aggregates per-client traffic.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-1">
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">
                Collector Address <span className="text-red-500">*</span>
              </label>
              <input className="input w-full" value={address} onChange={e => setAddress(e.target.value)}
                placeholder="192.168.1.100" disabled={!canWrite} />
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                The IP of this server as reachable by your devices (the Docker host IP, not the container).
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Port</label>
              <input type="number" className="input w-full" value={port} onChange={e => setPort(e.target.value)}
                min="1" max="65535" disabled={!canWrite} />
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                Must match the host port mapping (NETFLOW_PORT, default 2055).
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Version</label>
              <select className="input w-full" value={version} onChange={e => setVersion(e.target.value)} disabled={!canWrite}>
                <option value="9">NetFlow v9</option>
                <option value="ipfix">IPFIX</option>
              </select>
            </div>
          </div>

          {isFleetAdmin && (
            <div className="flex items-start gap-3">
              <Toggle checked={acceptUnknown} onChange={(v) => { void handleAcceptUnknown(v); }} disabled={saving} />
              <div>
                <div className="text-sm font-medium text-gray-700 dark:text-slate-200">Accept flows from unidentified exporters</div>
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  Only turn this on if NAT sits between your routers and this server, so their flows arrive from a
                  gateway address instead of the router&apos;s own (common with Docker Desktop). NetFlow has no
                  authentication, so this lets any device on your network send traffic figures. Public addresses are
                  always refused. Clients are matched only where their address belongs to one site.
                </p>
              </div>
            </div>
          )}

          {addressMissing && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" />Set the collector address before enabling devices below.
            </div>
          )}

          <div className="flex items-center gap-3">
            {canWrite && (
              <button onClick={() => saveCollectorSettings()} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors">
                <Save className="w-3.5 h-3.5" />{saving ? 'Saving…' : 'Save Settings'}
              </button>
            )}
            {saveMsg && (
              <span className={clsx('text-sm', saveMsg === 'Saved' ? 'text-green-600 dark:text-green-400' : 'text-red-500')}>{saveMsg}</span>
            )}
          </div>

          {unidentified.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                Receiving flows from unidentified source{unidentified.length > 1 ? 's' : ''}{' '}
                <span className="font-mono">{unidentified.map(e => e.deviceName.replace(/^(?:Unidentified|Shared address) \((.+)\)$/, '$1')).join(', ')}</span>.
                This usually means NAT sits between your routers and the collector, or devices in different
                sites share an address. Flows are still processed, but can&apos;t be tied to one exporting device,
                so clients are matched only where their address belongs to a single site.
              </div>
            </div>
          )}

          {rejected.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div>Refusing flows from sources that aren&apos;t managed devices:</div>
                <ul className="space-y-0.5">
                  {rejected.map((r) => (
                    <li key={r.address}>
                      <span className="font-mono">{r.address}</span> ({r.packets.toLocaleString()} packets):{' '}
                      {r.reason === 'public_address'
                        ? 'a public address, refused even with unidentified exporters accepted. If you see this, the collector is reachable from outside your network.'
                        : 'if this is a NAT gateway in front of your routers, turn on "Accept flows from unidentified exporters".'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {status && status.packetsReceived > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-gray-100 dark:border-slate-800">
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Packets received</div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{status.packetsReceived.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Flows decoded</div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{status.flowsDecoded.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Flows attributed</div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{status.flowsAttributed.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Unknown exporters</div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{status.packetsFromUnknownExporter.toLocaleString()}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Devices */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
            Devices<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({devices.length} online)</span>
          </h2>
        </div>

        {toggleError && (
          <div className="px-5 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400 border-b border-gray-100 dark:border-slate-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />{toggleError}
          </div>
        )}

        {fleetLoading && <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading device state…</div>}
        {!!fleetError && (
          <div className="p-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />Failed: {(fleetError as Error).message}
          </div>
        )}
        {!fleetLoading && !fleetError && devices.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">No online devices found.</div>
        )}

        {devices.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Device</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Flows</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Last Flow</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Export</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d, i) => (
                  <tr key={d.id}
                    className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40',
                      i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{d.name}</div>
                      <div className="font-mono text-xs text-gray-400 dark:text-slate-500">{d.ip_address}</div>
                    </td>
                    <td className="px-4 py-3">{deviceBadge(d)}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-slate-300">{d.flows_received.toLocaleString()}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-slate-400 text-xs">
                      {d.last_flow_at ? formatDistanceToNow(parseISO(d.last_flow_at), { addSuffix: true }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end">
                        <Toggle
                          checked={!!d.enabled && d.target_matches_collector}
                          onChange={v => handleDeviceToggle(d.id, v)}
                          disabled={!canWrite || !!d.error || togglePending === d.id || (addressMissing && !d.enabled)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
