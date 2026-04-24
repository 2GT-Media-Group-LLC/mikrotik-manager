import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Server, RefreshCw, CheckCircle, XCircle, MinusCircle,
  Globe, Clock, Shield, Wifi, FileText,
} from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi } from '../services/api';

interface DeviceServiceRow {
  id: number;
  name: string;
  ip_address: string;
  dhcp_v4: { total: number; enabled: number } | null;
  dhcp_v6: { total: number; enabled: number } | null;
  dns: { allow_remote: boolean; servers: string } | null;
  ntp: { server_enabled: boolean; client_enabled: boolean } | null;
  wireguard: { total: number; running: number } | null;
  syslog: { remote_count: number } | null;
  error?: string;
}

function ServiceCell({ active, label }: { active: boolean | null; label?: string }) {
  if (active === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500">
        <MinusCircle className="w-3.5 h-3.5" />
        {label ?? '—'}
      </span>
    );
  }
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
        <CheckCircle className="w-3.5 h-3.5" />
        {label ?? 'Active'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500">
      <XCircle className="w-3.5 h-3.5" />
      {label ?? 'Inactive'}
    </span>
  );
}

export default function NetworkServicesOverviewPage() {
  const navigate = useNavigate();

  const { data = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as unknown as DeviceServiceRow[]),
    refetchInterval: 60_000,
  });

  const serviceColumns = [
    { key: 'dhcp_v4', label: 'DHCP v4', icon: Server, href: '/network-services/dhcp' },
    { key: 'dhcp_v6', label: 'DHCP v6', icon: Server, href: '/network-services/dhcp' },
    { key: 'dns',     label: 'DNS',     icon: Globe,  href: '/network-services/dns' },
    { key: 'ntp',     label: 'NTP',     icon: Clock,  href: '/network-services/ntp' },
    { key: 'wireguard', label: 'WireGuard', icon: Shield,    href: '/network-services/wireguard' },
    { key: 'syslog',    label: 'Syslog',    icon: FileText,  href: '/network-services/syslog' },
  ] as const;

  // KPI: for each service, how many devices have it active?
  const kpis = serviceColumns.map((col) => {
    const active = data.filter((d) => {
      const svc = d[col.key];
      if (!svc) return false;
      if (col.key === 'dhcp_v4' || col.key === 'dhcp_v6') {
        return (svc as { enabled: number }).enabled > 0;
      }
      if (col.key === 'dns') return (svc as { allow_remote: boolean }).allow_remote;
      if (col.key === 'ntp') return (svc as { server_enabled: boolean }).server_enabled || (svc as { client_enabled: boolean }).client_enabled;
      if (col.key === 'wireguard') return (svc as { running: number }).running > 0;
      if (col.key === 'syslog') return (svc as { remote_count: number }).remote_count > 0;
      return false;
    }).length;
    return { ...col, active, total: data.length };
  });

  function renderCell(device: DeviceServiceRow, key: typeof serviceColumns[number]['key']) {
    const svc = device[key];
    if (device.error || !svc) {
      return <ServiceCell active={null} />;
    }
    if (key === 'dhcp_v4' || key === 'dhcp_v6') {
      const s = svc as { total: number; enabled: number };
      if (s.total === 0) return <ServiceCell active={null} label="None" />;
      return <ServiceCell active={s.enabled > 0} label={`${s.enabled}/${s.total} active`} />;
    }
    if (key === 'dns') {
      const s = svc as { allow_remote: boolean; servers: string };
      return <ServiceCell active={s.allow_remote} label={s.allow_remote ? 'Remote on' : 'Local only'} />;
    }
    if (key === 'ntp') {
      const s = svc as { server_enabled: boolean; client_enabled: boolean };
      const label = s.server_enabled ? 'Server on' : s.client_enabled ? 'Client only' : 'Disabled';
      return <ServiceCell active={s.server_enabled || s.client_enabled} label={label} />;
    }
    if (key === 'wireguard') {
      const s = svc as { total: number; running: number };
      if (s.total === 0) return <ServiceCell active={null} label="None" />;
      return <ServiceCell active={s.running > 0} label={`${s.running}/${s.total} up`} />;
    }
    if (key === 'syslog') {
      const s = svc as { remote_count: number };
      return <ServiceCell active={s.remote_count > 0} label={s.remote_count > 0 ? `${s.remote_count} remote` : 'No remote'} />;
    }
    return <ServiceCell active={null} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Network Services</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Service status across all online devices
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {kpis.map(({ key, label, icon: Icon, active, total, href }) => (
          <button
            key={key}
            onClick={() => navigate(href)}
            className="card p-4 flex flex-col gap-2 text-left hover:shadow-md transition-shadow cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
                <Icon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              </div>
              <span className="text-xs font-medium text-gray-500 dark:text-slate-400">{label}</span>
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{active}</div>
            <div className="text-xs text-gray-400 dark:text-slate-500">of {total} device{total !== 1 ? 's' : ''}</div>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
          <Wifi className="w-4 h-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Per-Device Service Status</h2>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading service status…</div>
        ) : data.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">No online devices found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Device</th>
                  {serviceColumns.map((col) => (
                    <th key={col.key} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((device, i) => (
                  <tr
                    key={device.id}
                    className={clsx(
                      'border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40',
                      i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40'
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{device.name}</div>
                      <div className="text-xs text-gray-400 dark:text-slate-500">{device.ip_address}</div>
                      {device.error && (
                        <div className="text-xs text-red-500 mt-0.5">Connection failed</div>
                      )}
                    </td>
                    {serviceColumns.map((col) => (
                      <td key={col.key} className="px-4 py-3">
                        {renderCell(device, col.key)}
                      </td>
                    ))}
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
