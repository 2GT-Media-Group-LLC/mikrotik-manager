import { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, Activity, Cpu, MemoryStick, Clock, ExternalLink, TerminalSquare, ShieldCheck,
} from 'lucide-react';
import { devicesApi, metricsApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import SwitchPortDiagram from '../components/ports/SwitchPortDiagram';
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
import ConnectionsTab from '../components/device-detail/ConnectionsTab';
import QueuesTab from '../components/device-detail/QueuesTab';
import SecurityTab from '../components/device-detail/SecurityTab';
import clsx from 'clsx';

type TabKey = 'overview' | 'ports' | 'vlans' | 'routing' | 'firewall' | 'security' | 'queues' | 'connections' | 'config' | 'config-history' | 'hardware' | 'tools' | 'radios';

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
  const VALID_TABS: TabKey[] = ['overview', 'ports', 'vlans', 'routing', 'firewall', 'security', 'queues', 'connections', 'config', 'config-history', 'hardware', 'tools', 'radios'];
  const requestedTab = searchParams.get('tab') as TabKey | null;
  const [activeTab, setActiveTab] = useState<TabKey>(requestedTab && VALID_TABS.includes(requestedTab) ? requestedTab : 'overview');
  const [autoOpenBridge, setAutoOpenBridge] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);

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
    enabled: device?.status === 'online',
  });

  const { data: availability } = useQuery({
    queryKey: ['device-availability', deviceId],
    queryFn: () => metricsApi.deviceAvailability(deviceId, '30d').then((r) => r.data),
    refetchInterval: 60_000,
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

  const isWirelessAP = device.device_type === 'wireless_ap';

  const tabs: { key: TabKey; label: string }[] = [
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
    { key: 'tools', label: 'Tools' },
  ];

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
              <span
                className={clsx(
                  'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                  device.status === 'online' && 'status-online',
                  device.status === 'offline' && 'status-offline',
                  device.status === 'unknown' && 'status-unknown'
                )}
              >
                <span
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full',
                    device.status === 'online' && 'bg-green-500 animate-pulse',
                    device.status === 'offline' && 'bg-red-500',
                    device.status === 'unknown' && 'bg-gray-400'
                  )}
                />
                {device.status}
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-slate-400 font-mono truncate">
              {device.ip_address}:{device.api_port}
              {device.model && ` · ${device.model}`}
              {device.ros_version && ` · ROS ${device.ros_version}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:ml-auto sm:flex-shrink-0">
          <button
            onClick={() => window.open(`http://${device.ip_address}/`, '_blank', 'noopener,noreferrer')}
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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap',
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Resource stats */}
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
              {[
                ['Name', device.name],
                ['IP Address', device.ip_address],
                ['Model', device.model || '—'],
                ['Serial Number', device.serial_number || '—'],
                ['RouterOS Version', device.ros_version || '—'],
                ['Firmware', device.firmware_version || '—'],
                ['Type', device.device_type],
                ['API Port', String(device.api_port)],
                ['Added', new Date(device.created_at).toLocaleDateString()],
                ['Last Seen', device.last_seen ? new Date(device.last_seen).toLocaleString() : '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between py-1 border-b border-gray-100 dark:border-slate-700">
                  <span className="text-gray-500 dark:text-slate-400">{k}</span>
                  <span className="font-medium text-gray-900 dark:text-white text-right">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Physical location, rack & notes */}
          <DeviceLocationSection device={device} />
        </div>
      )}

      {activeTab === 'ports' && (
        <SwitchPortDiagram
          deviceId={deviceId}
          deviceName={device?.name}
          autoOpenBridge={autoOpenBridge ?? undefined}
          onBridgeOpened={() => setAutoOpenBridge(null)}
        />
      )}
      {activeTab === 'vlans' && (
        <VlansTab
          deviceId={deviceId}
          deviceName={device?.name}
          deviceType={device?.device_type}
          onGoToPorts={(bridgeName) => { setAutoOpenBridge(bridgeName); setActiveTab('ports'); }}
        />
      )}
      {activeTab === 'routing' && <RoutingTab deviceId={deviceId} deviceName={device.name} />}
      {activeTab === 'firewall' && <FirewallTab deviceId={deviceId} />}
      {activeTab === 'security' && <SecurityTab deviceId={deviceId} deviceName={device.name} />}
      {activeTab === 'queues' && <QueuesTab deviceId={deviceId} />}
      {activeTab === 'connections' && <ConnectionsTab deviceId={deviceId} />}
      {activeTab === 'config' && <SystemConfigTab deviceId={deviceId} device={device} />}
      {activeTab === 'config-history' && <ConfigHistoryTab deviceId={deviceId} />}
      {activeTab === 'hardware' && <HardwareTab deviceId={deviceId} />}
      {activeTab === 'radios' && <RadiosTab deviceId={deviceId} deviceStatus={device.status} />}
      {activeTab === 'tools' && <ToolsTab deviceId={deviceId} />}

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
