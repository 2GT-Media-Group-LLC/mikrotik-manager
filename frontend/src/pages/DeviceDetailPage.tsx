import { useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Activity, Cpu, MemoryStick, Clock, ExternalLink, TerminalSquare, ShieldCheck, Copy, Check,
} from 'lucide-react';
import { hostPort, winboxAddress } from '../utils/deviceAddress';
import { devicesApi, metricsApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import SwitchPortDiagram from '../components/ports/SwitchPortDiagram';
import DeviceTagPicker from '../components/devices/DeviceTagPicker';
import TerminalModal from '../components/TerminalModal';
import DeviceLocationSection from '../components/device-detail/DeviceLocationSection';
import VlansTab from '../components/device-detail/VlansTab';
import RoutingTab from '../components/device-detail/RoutingTab';
import FirewallTab from '../components/device-detail/FirewallTab';
import SystemConfigTab from '../components/device-detail/SystemConfigTab';
import ConfigHistoryTab from '../components/device-detail/ConfigHistoryTab';
import HardwareTab from '../components/device-detail/HardwareTab';
import ToolsTab from '../components/device-detail/ToolsTab';
import RadiosTab from '../components/device-detail/RadiosTab';
import LteTab from '../components/device-detail/LteTab';
import ConnectionsTab from '../components/device-detail/ConnectionsTab';
import QueuesTab from '../components/device-detail/QueuesTab';
import SecurityTab from '../components/device-detail/SecurityTab';
import clsx from 'clsx';
import { displayState, STATE_LABEL } from '../utils/deviceState';
import DeviceHealthCard from '../components/device-detail/DeviceHealthCard';
import { DeviceIdentityBanner } from '../components/security/IdentityChange';
import { isWirelessDevice } from '../utils/wireless';
import SshOnlyBanner from '../components/device-detail/SshOnlyBanner';

type TabKey = 'overview' | 'ports' | 'vlans' | 'routing' | 'firewall' | 'security' | 'queues' | 'connections' | 'config' | 'config-history' | 'hardware' | 'tools' | 'radios' | 'lte';

function formatUptime(raw: string): string {
  if (!raw) return '—';
  const weeks   = parseInt(raw.match(/(\d+)w/)?.[1] ?? '0', 10);
  const days    = parseInt(raw.match(/(\d+)d/)?.[1] ?? '0', 10);
  const hours   = parseInt(raw.match(/(\d+)h/)?.[1] ?? '0', 10);
  const minutes = parseInt(raw.match(/(\d+)m/)?.[1] ?? '0', 10);
  const seconds = parseInt(raw.match(/(\d+)s/)?.[1] ?? '0', 10);

  const parts: string[] = [];
  if (weeks)   parts.push(`${weeks} ${weeks   === 1 ? 'Week'   : 'Weeks'}`);
  if (days)    parts.push(`${days} ${days     === 1 ? 'Day'    : 'Days'}`);
  if (hours)   parts.push(`${hours} ${hours   === 1 ? 'Hour'   : 'Hours'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`);

  // Only show seconds when nothing larger is present (uptime < 1 minute)
  if (parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? 'Second' : 'Seconds'}`);

  return parts.join(' ');
}

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [searchParams] = useSearchParams();
  const VALID_TABS: TabKey[] = ['overview', 'ports', 'vlans', 'routing', 'firewall', 'security', 'queues', 'connections', 'config', 'config-history', 'hardware', 'tools', 'radios', 'lte'];
  const requestedTab = searchParams.get('tab') as TabKey | null;
  const [activeTab, setActiveTab] = useState<TabKey>(requestedTab && VALID_TABS.includes(requestedTab) ? requestedTab : 'overview');
  const [autoOpenBridge, setAutoOpenBridge] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  const deviceId = parseInt(id!);

  const { data: device, isLoading } = useQuery({
    queryKey: ['device', deviceId],
    queryFn: () => devicesApi.get(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: resources } = useQuery({
    queryKey: ['device-resources-live', deviceId],
    queryFn: () => devicesApi.getResources(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
    // Read over the API, which an SSH-only device doesn't have yet (#174).
    enabled: device?.status === 'online' && !device?.ssh_only,
  });

  const { data: availability } = useQuery({
    queryKey: ['device-availability', deviceId],
    queryFn: () => metricsApi.deviceAvailability(deviceId, '30d').then((r) => r.data),
    refetchInterval: 60_000,
  });

  // "Use this name": take the router's identity and follow it from now on (#253).
  const adoptIdentity = useMutation({
    meta: { inlineError: true },
    mutationFn: () => devicesApi.update(deviceId, { unlock_name: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['device', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => devicesApi.sync(deviceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['device', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['interfaces', deviceId] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!device) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <p className="text-gray-500">Device not found</p>
        <button onClick={() => navigate('/devices')} className="btn-secondary">
          Back to Devices
        </button>
      </div>
    );
  }

  // Show the Radios tab when the device actually has radios, not when someone
  // tagged it "wireless_ap". A router can carry radios, and a CAPsMAN controller is
  // normally tagged a router — both had no way to reach this tab (#94).
  const isWirelessAP = isWirelessDevice(device);

  const allTabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'ports', label: 'Ports' },
    { key: 'vlans', label: 'VLANs' },
    { key: 'routing', label: 'Routing' },
    { key: 'firewall', label: 'Firewall' },
    { key: 'security', label: 'Security' },
    // RouterOS L3 features are available on every managed device, so show them
    // for all device types (the tabs render a clean empty state when unused).
    { key: 'queues', label: 'Bandwidth' },
    { key: 'connections', label: 'Connections' },
    { key: 'config', label: 'Config' },
    { key: 'config-history', label: 'Config History' },
    { key: 'hardware', label: 'Hardware' },
    ...(isWirelessAP ? [{ key: 'radios' as TabKey, label: 'Radios' }] : []),
    // Cellular is a property of the hardware, not the device type: a modem turns
    // up on routers, CPE and travel gear alike, so the flag is set from the
    // interface list rather than inferred (discussion #85).
    ...(device.has_lte ? [{ key: 'lte' as TabKey, label: 'LTE' }] : []),
    { key: 'tools', label: 'Tools' },
  ];
  // Added over SSH only (#174): only what works without the API.
  const tabs = allTabs.filter((t) => !device.ssh_only || t.key === 'overview' || t.key === 'config-history');
  // A tab that isn't offered (an SSH-only device, or a link to one) shows the overview.
  const shownTab: TabKey = tabs.some((t) => t.key === activeTab) ? activeTab : 'overview';

  const cpuLoad = parseInt(resources?.['cpu-load'] || '0', 10);
  const memTotal = parseInt(resources?.['total-memory'] || '0', 10);
  const memFree = parseInt(resources?.['free-memory'] || '0', 10);
  const memUsed = memTotal - memFree;
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  const formatMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => navigate('/devices')}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors flex-shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">{device.name}</h1>
              <DeviceTagPicker deviceId={deviceId} />
              {(() => {
                const st = displayState(device);
                return (
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                      st === 'online' && 'status-online',
                      st === 'degraded' && 'status-degraded',
                      st === 'offline' && 'status-offline',
                      (st === 'unknown' || st === 'expected-offline') && 'status-unknown'
                    )}
                  >
                    <span
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full',
                        st === 'online' && 'bg-green-500 animate-pulse',
                        st === 'degraded' && 'bg-amber-500 animate-pulse',
                        st === 'offline' && 'bg-red-500',
                        (st === 'unknown' || st === 'expected-offline') && 'bg-gray-400'
                      )}
                    />
                    {STATE_LABEL[st]}
                  </span>
                );
              })()}
              {device.user_manager && (
                <Link to={`/user-manager?device=${device.id}`} title="This device runs User Manager (RADIUS)"
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 hover:underline">
                  User Manager
                </Link>
              )}
            </div>
            <p className="text-sm text-gray-500 dark:text-slate-400 font-mono truncate">
              {/* An SSH-only device is reached on its SSH port (#174). */}
              {device.ssh_only ? `${hostPort(device.ip_address, device.ssh_port ?? 22)} (SSH)` : hostPort(device.ip_address, device.api_port)}
              <button type="button" title="Copy the address for Winbox" aria-label="Copy the address for Winbox"
                onClick={() => { void navigator.clipboard.writeText(winboxAddress(device.ip_address)).then(() => { setAddrCopied(true); setTimeout(() => setAddrCopied(false), 1500); }); }}
                className="inline-flex align-middle ml-1.5 p-0.5 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">
                {addrCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              {device.model && ` · ${device.model}`}
              {device.ros_version && ` · ROS ${device.ros_version}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:ml-auto sm:flex-shrink-0">
          <button
            onClick={() => window.open(
              // An IPv6 literal needs brackets in a URL (addresses can be IPv6 since #170).
              `http://${device.ip_address.includes(':') ? `[${device.ip_address}]` : device.ip_address}/`,
              '_blank', 'noopener,noreferrer')}
            className="btn-secondary flex items-center gap-2 text-sm"
            title="Open device web interface"
          >
            <ExternalLink className="w-4 h-4" />
            <span className="hidden sm:inline">Web Admin</span>
          </button>
          {canWrite && (
            <button
              onClick={() => setShowTerminal(true)}
              className="btn-secondary flex items-center gap-2 text-sm"
              title="Open SSH terminal"
            >
              <TerminalSquare className="w-4 h-4" />
              <span className="hidden sm:inline">Terminal</span>
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="btn-secondary flex items-center gap-2 text-sm"
            >
              <RefreshCw className={clsx('w-4 h-4', syncMutation.isPending && 'animate-spin')} />
              <span className="hidden sm:inline">Sync</span>
            </button>
          )}
        </div>
      </div>

      {/* A changed certificate or host key stops the manager connecting (P1-4). */}
      <DeviceIdentityBanner deviceId={deviceId} deviceName={device.name} />
      {device.ssh_only && <SshOnlyBanner device={device} />}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap',
              shownTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {shownTab === 'overview' && (
        <div className="space-y-4">
          {/* Resource stats (read over the API; none for an SSH-only device, #174) */}
          {!device.ssh_only && (
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">CPU Load</span>
              </div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {resources ? `${cpuLoad}%` : '—'}
              </div>
              {resources && (
                <div className="mt-2 h-1.5 bg-gray-200 dark:bg-slate-600 rounded-full">
                  <div
                    className={clsx(
                      'h-full rounded-full transition-all',
                      cpuLoad > 80 ? 'bg-red-500' : cpuLoad > 50 ? 'bg-yellow-500' : 'bg-green-500'
                    )}
                    style={{ width: `${cpuLoad}%` }}
                  />
                </div>
              )}
            </div>

            <div className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <MemoryStick className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Memory</span>
              </div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {resources ? `${memPercent}%` : '—'}
              </div>
              {resources && (
                <div className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                  {formatMB(memUsed)} / {formatMB(memTotal)}
                </div>
              )}
            </div>

            <div className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Uptime</span>
              </div>
              <div className="text-xl font-bold text-gray-900 dark:text-white truncate">
                {resources ? formatUptime(resources['uptime'] || '') : '—'}
              </div>
            </div>

            <div className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Version</span>
              </div>
              <div className="text-sm font-bold text-gray-900 dark:text-white">
                {device.ros_version || '—'}
              </div>
              <div className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                {device.firmware_version || ''}
              </div>
            </div>
          </div>
          )}

          {/* Availability card */}
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-4 h-4 text-blue-500" />
              <span className="text-sm font-semibold text-gray-900 dark:text-white">30-Day Availability</span>
            </div>
            {availability ? (
              <div className="flex flex-wrap gap-6">
                <div>
                  <div className={clsx(
                    'text-3xl font-bold',
                    availability.uptimePct >= 99 ? 'text-green-500' : availability.uptimePct >= 95 ? 'text-yellow-500' : 'text-red-500'
                  )}>
                    {availability.uptimePct.toFixed(2)}%
                  </div>
                  <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Uptime</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">{availability.totalOutages}</div>
                  <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Outages</div>
                </div>
                {availability.longestOutageSec > 0 && (
                  <div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-white">
                      {availability.longestOutageSec < 60
                        ? `${availability.longestOutageSec}s`
                        : availability.longestOutageSec < 3600
                        ? `${Math.round(availability.longestOutageSec / 60)}m`
                        : `${(availability.longestOutageSec / 3600).toFixed(1)}h`}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Longest outage</div>
                  </div>
                )}
                <div className="flex-1 min-w-[120px] self-center">
                  <div className="h-2 bg-gray-200 dark:bg-slate-600 rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-all',
                        availability.uptimePct >= 99 ? 'bg-green-500' : availability.uptimePct >= 95 ? 'bg-yellow-500' : 'bg-red-500'
                      )}
                      style={{ width: `${availability.uptimePct}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-400 dark:text-slate-500">No availability data yet</div>
            )}
          </div>

          {/* System details */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
              System Information
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="flex justify-between py-1 border-b border-gray-100 dark:border-slate-700">
                <span className="text-gray-500 dark:text-slate-400" title="The name shown in the manager">Name</span>
                <span className="font-medium text-gray-900 dark:text-white text-right">{device.name}</span>
              </div>
              {/* The router's own name, when it differs from the manager's (#253). */}
              {device.ros_identity && device.ros_identity.trim() !== device.name.trim() && (
                <div className="flex justify-between items-center gap-2 py-1 border-b border-gray-100 dark:border-slate-700">
                  <span className="text-gray-500 dark:text-slate-400" title="The name set on the router itself (/system identity)">Identity on the router</span>
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-gray-900 dark:text-white truncate">{device.ros_identity}</span>
                    {canWrite && (
                      <button type="button" disabled={adoptIdentity.isPending} onClick={() => adoptIdentity.mutate()}
                        title="Show the router's own name here, and follow it if it changes"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex-shrink-0 disabled:opacity-50">
                        {adoptIdentity.isPending ? 'Switching…' : 'Use this name'}
                      </button>
                    )}
                  </span>
                </div>
              )}
              {([
                ['IP Address', device.ip_address],
                ['Model', device.model || '—'],
                ['Serial Number', device.serial_number || '—'],
                ['RouterOS Version', device.ros_version || '—'],
                ['Firmware', device.firmware_version || '—'],
                ['Type', device.device_type],
                ['API Port', device.ssh_only ? 'Not enabled yet' : String(device.api_port)],
                ['Added', new Date(device.created_at).toLocaleDateString()],
                ['Last Seen', device.last_seen ? new Date(device.last_seen).toLocaleString() : '—'],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1 border-b border-gray-100 dark:border-slate-700">
                  <span className="text-gray-500 dark:text-slate-400">{k}</span>
                  <span className="font-medium text-gray-900 dark:text-white text-right">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Hardware health and intermittent setting (#168) */}
          <DeviceHealthCard device={device} />

          {/* Physical location, rack & notes */}
          <DeviceLocationSection device={device} />
        </div>
      )}

      {shownTab === 'ports' && (
        <SwitchPortDiagram
          deviceId={deviceId}
          deviceName={device?.name}
          autoOpenBridge={autoOpenBridge ?? undefined}
          onBridgeOpened={() => setAutoOpenBridge(null)}
        />
      )}
      {shownTab === 'vlans' && (
        <VlansTab
          deviceId={deviceId}
          deviceName={device?.name}
          deviceType={device?.device_type}
          onGoToPorts={(bridgeName) => { setAutoOpenBridge(bridgeName); setActiveTab('ports'); }}
        />
      )}
      {shownTab === 'routing' && <RoutingTab deviceId={deviceId} deviceName={device.name} />}
      {shownTab === 'firewall' && <FirewallTab deviceId={deviceId} deviceName={device.name} />}
      {shownTab === 'security' && <SecurityTab deviceId={deviceId} deviceName={device.name} />}
      {shownTab === 'queues' && <QueuesTab deviceId={deviceId} />}
      {shownTab === 'connections' && <ConnectionsTab deviceId={deviceId} />}
      {shownTab === 'config' && <SystemConfigTab deviceId={deviceId} device={device} />}
      {shownTab === 'config-history' && <ConfigHistoryTab deviceId={deviceId} />}
      {shownTab === 'hardware' && <HardwareTab deviceId={deviceId} />}
      {shownTab === 'radios' && <RadiosTab deviceId={deviceId} deviceStatus={device.status} />}
      {shownTab === 'lte' && <LteTab deviceId={deviceId} />}
      {shownTab === 'tools' && <ToolsTab deviceId={deviceId} />}

      {showTerminal && (
        <TerminalModal
          deviceId={deviceId}
          deviceName={device.name}
          onClose={() => setShowTerminal(false)}
        />
      )}
    </div>
  );
}
