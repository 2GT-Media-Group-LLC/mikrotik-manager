import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';

import { devicesApi, eventsApi } from '../services/api';
import type { FirewallEvent } from '../services/api';
import DevicePicker from '../components/common/DevicePicker';
import { useSocket } from '../hooks/useSocket';
import { useCanWrite } from '../hooks/useCanWrite';
import FirewallMonitoringModal from '../components/firewall/FirewallMonitoringModal';

const PAGE_SIZE = 100;
const FIREWALL_WINDOW_MS = 24 * 60 * 60 * 1000;

function actionClass(action: FirewallEvent['action']): string {
  switch (action) {
    case 'drop':
      return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
    case 'reject':
      return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400';
    case 'accept':
      return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400';
    case 'fasttrack':
      return 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400';
    default:
      return 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300';
  }
}

function endpoint(ip: string, port?: number): string {
  return port != null ? `${ip}:${port}` : ip;
}

export default function FirewallEventsPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [monitoringOpen, setMonitoringOpen] = useState(false);

  const [search, setSearch] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [action, setAction] = useState('');
  const [protocol, setProtocol] = useState('');
  const [page, setPage] = useState(0);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: [
      'firewall-events',
      { search, deviceId, action, protocol, page },
    ],
    queryFn: () =>
      eventsApi
        .firewall({
          search: search || undefined,
          since: new Date(Date.now() - FIREWALL_WINDOW_MS).toISOString(),
          deviceId: deviceId ? Number(deviceId) : undefined,
          action: action
            ? (action as FirewallEvent['action'])
            : undefined,
          protocol: protocol || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        })
        .then((r) => r.data),
    refetchInterval: 30_000,
  });

  useSocket({
    'events:updated': () =>
      queryClient.invalidateQueries({ queryKey: ['firewall-events'] }),
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalLabel = total.toLocaleString();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Firewall Events
          {total > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({totalLabel})
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2 flex-wrap">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">
              Updated {format(new Date(dataUpdatedAt), 'HH:mm:ss')}
            </span>
          )}

          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="btn-secondary flex items-center gap-2"
          >
            <RefreshCw
              className={clsx(
                'w-4 h-4',
                isFetching && 'animate-spin'
              )}
            />
            Refresh
          </button>

          {canWrite && (
            <button
              onClick={() => setMonitoringOpen(true)}
              className="btn-secondary flex items-center gap-2"
            >
              <Settings2 className="w-4 h-4" />
              Configure monitoring
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full sm:flex-1 sm:min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            className="input pl-9"
            placeholder="Search source, destination, port, interface or prefix…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </div>

        <select
          className="input w-full sm:w-40"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All actions</option>
          <option value="accept">Accept</option>
          <option value="drop">Drop</option>
          <option value="reject">Reject</option>
          <option value="fasttrack">FastTrack</option>
          <option value="unknown">Unknown</option>
        </select>

        <select
          className="input w-full sm:w-40"
          value={protocol}
          onChange={(e) => {
            setProtocol(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All protocols</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="icmp">ICMP</option>
          <option value="icmpv6">ICMPv6</option>
          <option value="gre">GRE</option>
          <option value="esp">ESP</option>
        </select>

        <DevicePicker
          className="w-full sm:w-56"
          emptyLabel="All devices"
          devices={devices}
          aria-label="Device"
          value={deviceId ? Number(deviceId) : null}
          onChange={(id) => {
            setDeviceId(id == null ? '' : String(id));
            setPage(0);
          }}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">
          Loading...
        </div>
      ) : events.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <ShieldCheck className="w-12 h-12 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">
            No firewall events found
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Time</th>
                  <th className="table-header px-4 py-2.5 text-left">Action</th>
                  <th className="table-header px-4 py-2.5 text-left">Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Source</th>
                  <th className="table-header px-4 py-2.5 text-left">Destination</th>
                  <th className="table-header px-4 py-2.5 text-left">Proto</th>
                  <th className="table-header px-4 py-2.5 text-left">Chain</th>
                  <th className="table-header px-4 py-2.5 text-left">In</th>
                  <th className="table-header px-4 py-2.5 text-left">Out</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {events.map((event) => (
                  <tr
                    key={event.id}
                    title={event.rawMessage}
                    className={clsx(
                      'hover:bg-gray-50 dark:hover:bg-slate-700/30',
                      event.action === 'drop' &&
                        'bg-red-50/30 dark:bg-red-900/10'
                    )}
                  >
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {format(new Date(event.eventTime), 'MMM d, HH:mm:ss')}
                    </td>

                    <td className="px-4 py-2.5">
                      <span
                        className={clsx(
                          'inline-flex px-2 py-0.5 rounded-full text-xs font-medium uppercase',
                          actionClass(event.action)
                        )}
                      >
                        {event.action}
                      </span>
                    </td>

                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {event.deviceName || '—'}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
                      {endpoint(event.srcIp, event.srcPort)}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
                      {endpoint(event.dstIp, event.dstPort)}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      {event.protocol}
                      {event.tcpFlags ? ` (${event.tcpFlags})` : ''}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400">
                      {event.chain}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {event.inInterface || '—'}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {event.outInterface || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-slate-400">
            Showing {(page * PAGE_SIZE + 1).toLocaleString()}–
            {(page * PAGE_SIZE + events.length).toLocaleString()} of {totalLabel}
          </span>

          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="btn-secondary py-1 text-xs"
            >
              ← Previous
            </button>

            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * PAGE_SIZE >= total}
              className="btn-secondary py-1 text-xs"
            >
              Next →
            </button>
          </div>
        </div>
      )}
      <FirewallMonitoringModal
        open={monitoringOpen}
        onClose={() => setMonitoringOpen(false)}
        devices={devices}
        initialDeviceId={deviceId ? Number(deviceId) : null}
      />
    </div>
  );
}
