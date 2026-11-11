import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { tagOf, ruleUrl } from '../utils/ruleTags';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Ban, ChevronLeft, ChevronRight, CircleCheck, CircleHelp, CircleX, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { pageItems, zoneColor } from '../utils/firewallLogView';
import { useDateTimeFormat } from '../hooks/useDateTimeFormat';
import { useFleetRefresh } from '../hooks/useFleetRefresh';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import clsx from 'clsx';

import { devicesApi, eventsApi } from '../services/api';
import type { FirewallEvent, FirewallGroup } from '../services/api';
import DevicePicker from '../components/common/DevicePicker';
import { useSocket } from '../hooks/useSocket';
import { useCanWrite } from '../hooks/useCanWrite';
import FirewallMonitoringModal from '../components/firewall/FirewallMonitoringModal';

const PAGE_SIZE = 100;

/** How far back the page reads. Stored lines older than retention are gone anyway. */
const RANGES: Record<string, { label: string; ms: number }> = {
  '1h': { label: 'Last hour', ms: 60 * 60 * 1000 },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_RANGE = '24h';

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

type LogView = 'grouped' | 'raw';
const VIEW_KEY = 'firewall-logs:view';
const NAMES_KEY = 'firewall-logs:names';

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window: the choice lasts this visit */ }
}

/** An address, or its name when "Resolve names" found one (the address is then the tooltip). */
function Address({ ip, port, name }: { ip: string; port?: number; name?: string }) {
  if (!name) return <>{endpoint(ip, port)}</>;
  return <span title={endpoint(ip, port)}>{name}{port != null ? <span className="text-gray-400 dark:text-slate-500">:{port}</span> : null}</span>;
}

/**
 * A from or to column (#415): the zone on a zone-managed device, else the
 * interface. An interface in no zone shows as itself, marked.
 */
function ZoneCell({ zoned, zone, iface, router }: { zoned?: boolean; zone?: string; iface?: string; router?: boolean }) {
  if (zoned && zone) {
    return (
      <span className={clsx('inline-flex px-2 py-0.5 rounded font-sans text-[11px] font-semibold uppercase tracking-wide', zoneColor(zone, !!router))}>
        {zone}
      </span>
    );
  }
  if (zoned && iface) return <span title="This interface isn't in any zone" className="italic">{iface}</span>;
  return <>{iface || '—'}</>;
}

function ActionIcon({ action }: { action: FirewallEvent['action'] }) {
  const cls = 'w-3.5 h-3.5';
  switch (action) {
    case 'drop': return <Ban className={cls} aria-hidden />;
    case 'reject': return <CircleX className={cls} aria-hidden />;
    case 'accept': return <CircleCheck className={cls} aria-hidden />;
    case 'fasttrack': return <Zap className={cls} aria-hidden />;
    default: return <CircleHelp className={cls} aria-hidden />;
  }
}

function ActionBadge({ action }: { action: FirewallEvent['action'] }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium uppercase', actionClass(action))}>
      <ActionIcon action={action} />
      {action}
    </span>
  );
}

function RuleChip({ prefix, deviceId }: { prefix: string; deviceId: number | null }) {
  const tag = tagOf(prefix);
  if (!tag || deviceId == null) return null;
  return (
    <Link to={ruleUrl(deviceId, tag)} title="The rule that logged this line"
      className="ml-1.5 px-1.5 rounded bg-gray-100 dark:bg-slate-700 text-[10px] text-gray-500 dark:text-slate-300 hover:text-blue-600 normal-case">
      rule mtm#{tag}
    </Link>
  );
}

export default function FirewallEventsPage() {
  const { formatTime, formatDateTime } = useDateTimeFormat();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [monitoringOpen, setMonitoringOpen] = useState(false);

  // A rule's "log lines" link (#369) arrives as ?device=ID&search=mtm#tag.
  const [urlParams] = useSearchParams();
  const [search, setSearch] = useState(() => urlParams.get('search') ?? '');
  const [deviceId, setDeviceId] = useState(() => (/^\d+$/.test(urlParams.get('device') ?? '') ? urlParams.get('device')! : ''));
  const [action, setAction] = useState('');
  const [protocol, setProtocol] = useState('');
  // ?range=7d lets a link open a longer window; anything else means the default.
  const [range, setRange] = useState(() => {
    const r = urlParams.get('range') ?? DEFAULT_RANGE;
    // Own keys only: `in` also accepts toString or __proto__, which then had
    // no window and broke the page.
    return Object.prototype.hasOwnProperty.call(RANGES, r) ? r : DEFAULT_RANGE;
  });
  const [page, setPage] = useState(0);
  // Grouped by default (#415): one line per rule, source, destination and port.
  const [view, setViewState] = useState<LogView>(() => (readPref(VIEW_KEY) === 'raw' ? 'raw' : 'grouped'));
  const setView = (v: LogView) => { setViewState(v); setPage(0); writePref(VIEW_KEY, v); };
  // Hostnames and reverse DNS instead of addresses (#415). Off by default:
  // reverse DNS sends the addresses to the manager's resolver.
  const [names, setNamesState] = useState(() => readPref(NAMES_KEY) === '1');
  const setNames = (v: boolean) => { setNamesState(v); writePref(NAMES_KEY, v ? '1' : '0'); };
  const debouncedSearch = useDebouncedValue(search);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: [
      'firewall-events',
      { search: debouncedSearch, deviceId, action, protocol, range, page, view, names },
    ],
    queryFn: async (): Promise<{ events: FirewallEvent[]; groups: FirewallGroup[]; total: number; scanLimit?: number }> => {
      const params = {
        search: debouncedSearch || undefined,
        since: new Date(Date.now() - RANGES[range].ms).toISOString(),
        deviceId: deviceId ? Number(deviceId) : undefined,
        action: action
          ? (action as FirewallEvent['action'])
          : undefined,
        protocol: protocol || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        names: names ? (1 as const) : undefined,
      };
      if (view === 'grouped') {
        const r = (await eventsApi.firewallGrouped(params)).data;
        return { events: [], groups: r.groups, total: r.total, scanLimit: r.scanLimit };
      }
      const r = (await eventsApi.firewall(params)).data;
      return { events: r.events, groups: [], total: r.total };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  // Refresh asks the devices for their logs now, then reads again as they land.
  const { refresh, refreshing } = useFleetRefresh(['logs'], refetch);

  const clearMutation = useMutation({
    mutationFn: () =>
      eventsApi.clearFirewall(
        deviceId ? Number(deviceId) : undefined
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['firewall-events'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['event-topics'] });
      setPage(0);
    },
  });

  useSocket({
    'events:updated': () =>
      queryClient.invalidateQueries({ queryKey: ['firewall-events'] }),
  });

  const events = data?.events ?? [];
  const groups = data?.groups ?? [];
  const shown = view === 'grouped' ? groups.length : events.length;
  const total = data?.total ?? 0;
  const totalLabel = total.toLocaleString();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const groupedLines = groups.reduce((a, g) => a + g.count, 0);
  // Zone columns (#415): "From zone / To zone" when every line on the page is
  // from a zone-managed device, "From / To" when some are, else In / Out.
  const lines: { zoned?: boolean }[] = view === 'grouped' ? groups : events;
  const allZoned = lines.length > 0 && lines.every((l) => l.zoned);
  const anyZoned = lines.some((l) => l.zoned);
  const fromLabel = allZoned ? 'From zone' : anyZoned ? 'From' : 'In';
  const toLabel = allZoned ? 'To zone' : anyZoned ? 'To' : 'Out';

  // A group's own lines: the raw view, narrowed to its source on its device.
  const openLines = (g: FirewallGroup) => {
    if (g.deviceId != null) setDeviceId(String(g.deviceId));
    // As the line spells the source, so 192.168.0.1 doesn't also find .101.
    const v6 = g.srcIp.includes(':');
    setSearch(g.dstPort != null ? (v6 ? `[${g.srcIp}]:` : `${g.srcIp}:`) : `${g.srcIp}->`);
    setView('raw');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Firewall Logs
          {total > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">
              ({totalLabel}{view === 'grouped' ? ` group${total === 1 ? '' : 's'}` : ''})
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2 flex-wrap">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">
              Updated {formatTime(dataUpdatedAt, { second: '2-digit' })}
            </span>
          )}

          <button
            onClick={() => void refresh()}
            disabled={isFetching || refreshing}
            className="btn-secondary flex items-center gap-2"
          >
            <RefreshCw
              className={clsx(
                'w-4 h-4',
                (isFetching || refreshing) && 'animate-spin'
              )}
            />
            Refresh
          </button>

          {canWrite && (
            <button
              onClick={() => {
                const scope = deviceId
                  ? 'for this device'
                  : 'in the current scope';

                if (
                  confirm(
                    `Clear firewall logs ${scope}? This cannot be undone.`
                  )
                ) {
                  clearMutation.mutate();
                }
              }}
              disabled={clearMutation.isPending}
              className="btn-secondary flex items-center gap-2 text-red-500 hover:text-red-600"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </button>
          )}

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
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden text-sm" role="group" aria-label="View">
          {(['grouped', 'raw'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v}
              title={v === 'grouped' ? 'One line per rule, source, destination and port, with a count' : 'Every line as the device logged it'}
              className={clsx('px-3 py-1.5', view === v ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40')}>
              {v === 'grouped' ? 'Grouped' : 'Raw'}
            </button>
          ))}
        </div>
        <button onClick={() => setNames(!names)} aria-pressed={names}
          title="Show client hostnames and reverse DNS instead of addresses. Hover a name for its address."
          className={clsx('px-3 py-1.5 rounded-lg border text-sm whitespace-nowrap',
            names ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40')}>
          Resolve names
        </button>
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

        <select
          className="input w-full sm:w-40"
          aria-label="Period"
          value={range}
          onChange={(e) => {
            setRange(e.target.value);
            setPage(0);
          }}
        >
          {Object.entries(RANGES).map(([key, r]) => (
            <option key={key} value={key}>{r.label}</option>
          ))}
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
      ) : shown === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <ShieldCheck className="w-12 h-12 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">
            No firewall events found
          </p>
        </div>
      ) : view === 'grouped' ? (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Last seen</th>
                  <th className="table-header px-4 py-2.5 text-left">Action</th>
                  <th className="table-header px-4 py-2.5 text-right">Count</th>
                  <th className="table-header px-4 py-2.5 text-left">Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Source</th>
                  <th className="table-header px-4 py-2.5 text-left">Destination</th>
                  <th className="table-header px-4 py-2.5 text-left">Proto</th>
                  <th className="table-header px-4 py-2.5 text-left">Rule</th>
                  <th className="table-header px-4 py-2.5 text-left">{fromLabel}</th>
                  <th className="table-header px-4 py-2.5 text-left">{toLabel}</th>
                  <th className="table-header px-4 py-2.5 text-left">First seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {groups.map((g, i) => (
                  <tr key={`${g.deviceId}|${g.prefix}|${g.chain}|${g.srcIp}|${g.dstIp}|${g.dstPort}|${g.protocol}|${i}`}
                    title={`Latest line: ${g.rawMessage}`}
                    className={clsx('hover:bg-gray-50 dark:hover:bg-slate-700/30', g.action === 'drop' && 'bg-red-50/30 dark:bg-red-900/10')}>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {formatDateTime(g.lastSeen, { year: undefined, second: '2-digit' })}
                    </td>
                    <td className="px-4 py-2.5">
                      <ActionBadge action={g.action} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => openLines(g)} title="Show these lines"
                        className="text-xs font-mono font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                        {g.count.toLocaleString()}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{g.deviceName || '—'}</td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap"><Address ip={g.srcIp} name={g.srcName} /></td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap"><Address ip={g.dstIp} port={g.dstPort} name={g.dstName} /></td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 uppercase whitespace-nowrap">{g.protocol}</td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400">
                      {/* Zones say where traffic went; the chain only repeats it (#415). */}
                      {(!g.zoned || !tagOf(g.prefix)) && g.chain}
                      <RuleChip prefix={g.prefix} deviceId={g.deviceId} />
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap"><ZoneCell zoned={g.zoned} zone={g.fromZone} iface={g.inInterface} router={g.chain === 'output'} /></td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap"><ZoneCell zoned={g.zoned} zone={g.toZone} iface={g.outInterface} router={g.chain === 'input'} /></td>
                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {formatDateTime(g.firstSeen, { year: undefined, second: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400 border-t border-gray-100 dark:border-slate-700">
            {groupedLines.toLocaleString()} line{groupedLines === 1 ? '' : 's'} in the groups on this page, folded by device, rule,
            source, destination and port (any source port). Grouping reads the newest {(data?.scanLimit ?? 0).toLocaleString()} matching
            lines; narrow by device or search to go further back. Click a count to see its lines.
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
                  <th className="table-header px-4 py-2.5 text-left">{allZoned ? 'Rule' : 'Chain'}</th>
                  <th className="table-header px-4 py-2.5 text-left">{fromLabel}</th>
                  <th className="table-header px-4 py-2.5 text-left">{toLabel}</th>
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
                      {formatDateTime(event.eventTime, { year: undefined, second: '2-digit' })}
                    </td>

                    <td className="px-4 py-2.5">
                      <ActionBadge action={event.action} />
                    </td>

                    <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      {event.deviceName || '—'}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
                      <Address ip={event.srcIp} port={event.srcPort} name={event.srcName} />
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
                      <Address ip={event.dstIp} port={event.dstPort} name={event.dstName} />
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 uppercase whitespace-nowrap">
                      {event.protocol}
                      {event.tcpFlags ? ` (${event.tcpFlags})` : ''}
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400">
                      {(!event.zoned || !tagOf(event.prefix)) && event.chain}
                      <RuleChip prefix={event.prefix} deviceId={event.deviceId} />
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      <ZoneCell zoned={event.zoned} zone={event.fromZone} iface={event.inInterface} router={event.chain === 'output'} />
                    </td>

                    <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">
                      <ZoneCell zoned={event.zoned} zone={event.toZone} iface={event.outInterface} router={event.chain === 'input'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
          <span className="text-gray-500 dark:text-slate-400">
            Showing {(page * PAGE_SIZE + 1).toLocaleString()}–
            {(page * PAGE_SIZE + shown).toLocaleString()} of {totalLabel} {view === 'grouped' ? 'groups' : 'lines'}
          </span>

          <nav className="flex items-center gap-1" aria-label="Pages">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
              className="btn-secondary px-2 py-1 text-xs" aria-label="Previous page">
              <ChevronLeft className="w-4 h-4" />
            </button>
            {pageItems(page, pageCount).map((item, i) => item === 'gap' ? (
              <span key={`gap${i}`} className="px-1.5 text-gray-400 dark:text-slate-500">…</span>
            ) : (
              <button key={item} onClick={() => setPage(item)} aria-current={item === page ? 'page' : undefined}
                className={clsx('min-w-8 px-2 py-1 rounded-lg text-xs font-medium',
                  item === page ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700/50')}>
                {(item + 1).toLocaleString()}
              </button>
            ))}
            <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}
              className="btn-secondary px-2 py-1 text-xs" aria-label="Next page">
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        </div>
      )}
      {monitoringOpen && (
        <FirewallMonitoringModal
          open
          onClose={() => setMonitoringOpen(false)}
          devices={devices}
          initialDeviceId={deviceId ? Number(deviceId) : null}
        />
      )}
    </div>
  );
}
