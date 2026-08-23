import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Search, Trash2, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { eventsApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { useSocket } from '../hooks/useSocket';
import { format } from 'date-fns';
import type { EventSeverity } from '../types';
import clsx from 'clsx';

const severityIcon = (severity: EventSeverity) => {
  if (severity === 'error' || severity === 'critical') return AlertCircle;
  if (severity === 'warning') return AlertTriangle;
  return Info;
};

const severityColor = (severity: EventSeverity): string => {
  if (severity === 'error' || severity === 'critical') return 'text-red-500';
  if (severity === 'warning') return 'text-yellow-500';
  return 'text-blue-500';
};

const ALL_SEVERITIES = ['error', 'warning', 'info'] as const;

export default function EventsPage() {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [search, setSearch] = useState('');
  const [severities, setSeverities] = useState<Set<string>>(new Set(ALL_SEVERITIES));
  const [topic, setTopic] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [page, setPage] = useState(0);
  // RouterOS reports topics as a comma-separated list, so the server splits them
  // into individual tokens and counts them across the whole table — the operator
  // picks from what actually exists rather than guessing a spelling (#108).
  const { data: topicList = [] } = useQuery({
    queryKey: ['event-topics'],
    queryFn: () => eventsApi.topics().then(r => r.data),
    staleTime: 300_000,
  });
  const PAGE_SIZE = 100;

  const toggleSeverity = (s: string) => {
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
    setPage(0);
  };

  // No filter when all or none selected (show everything); filter when partially selected
  const severityParam =
    severities.size === 0 || severities.size === ALL_SEVERITIES.length
      ? undefined
      : [...severities].join(',');

  const { data: eventsData, isLoading } = useQuery({
    queryKey: ['events', { search, severityParam, topic, deviceId, page }],
    queryFn: () =>
      eventsApi
        .list({
          search: search || undefined,
          severity: severityParam,
          topic: topic || undefined,
          deviceId: deviceId ? parseInt(deviceId) : undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        })
        .then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  const clearMutation = useMutation({
    mutationFn: () => eventsApi.clear(deviceId ? parseInt(deviceId) : undefined),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['events'] }); setPage(0); },
  });

  useSocket({
    'events:updated': () => queryClient.invalidateQueries({ queryKey: ['events'] }),
  });

  const events = eventsData?.events ?? [];
  const total = eventsData?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Events
          {total > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({total.toLocaleString()})
            </span>
          )}
          {eventsData?.criticalCount ? (
            <span className="ml-2 px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs rounded-full font-medium">
              {eventsData.criticalCount} critical (24h)
            </span>
          ) : null}
        </h1>
        {canWrite && (
          <button
            onClick={() => {
              if (confirm('Clear all events? This cannot be undone.')) clearMutation.mutate();
            }}
            className="btn-secondary flex items-center gap-2 text-red-500 hover:text-red-600"
          >
            <Trash2 className="w-4 h-4" />
            Clear
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full sm:flex-1 sm:min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            className="input pl-9"
            placeholder="Search messages or topics…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>

        {topicList.length > 0 && (
          <select
            className="input w-full sm:w-44"
            value={topic}
            onChange={(e) => { setTopic(e.target.value); setPage(0); }}
          >
            <option value="">All topics</option>
            {topicList.map(t => (
              <option key={t.topic} value={t.topic}>{t.topic} ({t.count})</option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-3 px-3 py-1.5 border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800">
          {([
            { key: 'error', label: 'Error', color: 'text-red-500' },
            { key: 'warning', label: 'Warning', color: 'text-yellow-500' },
            { key: 'info', label: 'Info', color: 'text-blue-500' },
          ] as const).map(({ key, label, color }) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={severities.has(key)}
                onChange={() => toggleSeverity(key)}
                className="w-3.5 h-3.5 rounded accent-current cursor-pointer"
              />
              <span className={clsx('text-xs font-medium', color)}>{label}</span>
            </label>
          ))}
        </div>

        <select
          className="input w-full sm:w-44"
          value={deviceId}
          onChange={(e) => { setDeviceId(e.target.value); setPage(0); }}
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading...</div>
      ) : events.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <Bell className="w-12 h-12 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">No events found</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700">
                <th className="table-header px-4 py-2.5 text-left">Time</th>
                <th className="table-header px-4 py-2.5 text-left w-24">Severity</th>
                <th className="table-header px-4 py-2.5 text-left">Device</th>
                <th className="table-header px-4 py-2.5 text-left">Topic</th>
                <th className="table-header px-4 py-2.5 text-left">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {events.map((ev) => {
                const Icon = severityIcon(ev.severity);
                return (
                  <tr
                    key={ev.id}
                    className={clsx(
                      'hover:bg-gray-50 dark:hover:bg-slate-700/30',
                      (ev.severity === 'error' || ev.severity === 'critical') &&
                        'bg-red-50/30 dark:bg-red-900/10'
                    )}
                  >
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {format(new Date(ev.event_time), 'MMM d, HH:mm:ss')}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', severityColor(ev.severity))}>
                        <Icon className="w-3.5 h-3.5" />
                        {ev.severity}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400">
                      {ev.device_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-400 dark:text-slate-500">
                      {ev.topic || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-slate-300">
                      {ev.message}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-slate-400">
            Showing {(page * PAGE_SIZE + 1).toLocaleString()}–{Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}
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
    </div>
  );
}
