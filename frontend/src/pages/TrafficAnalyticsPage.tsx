import { useDateTimeFormat } from '../hooks/useDateTimeFormat';
import { useRef, useState } from 'react';
import { useRowsHeight } from '../hooks/useRowsHeight';
import { useRememberedRange } from '../hooks/useRememberedRange';
import { Link } from 'react-router-dom';
import LoadError from '../components/common/LoadError';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ReferenceArea, type MouseHandlerDataParam,
} from 'recharts';
import { chartTooltip, pieTooltip } from '../components/common/chartTooltip';
import { Activity, ArrowDown, ArrowUp, BarChart3, Router as RouterIcon, Settings2, AlertTriangle, X, Globe, MapPin, ZoomIn, ZoomOut } from 'lucide-react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import type { DateTimeFormatters } from '../utils/dateTimeFormat';
import clsx from 'clsx';
import { trafficApi, type TrafficApp } from '../services/api';
import DestinationsList from '../components/traffic/DestinationsList';
import DnsNamesList from '../components/traffic/DnsNamesList';
import { useThemeStore } from '../store/themeStore';
import { trafficFormat } from '../utils/trafficUnits';

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

const APP_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#a855f7',
  '#64748b', '#0ea5e9', '#d946ef', '#22c55e',
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function formatCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Axis labels: dates when the view spans days, else times. */
function timeFormatter(days: boolean, formatTime: DateTimeFormatters['formatTime']) {
  return (t: string) => {
    try {
      const d = parseISO(t);
      return days ? format(d, 'MMM d') : formatTime(d);
    } catch {
      return t;
    }
  };
}

// Destinations and DNS names are stored by the UTC hour (which is the local
// hour except in half-hour time zones).
const HOUR_MS = 3_600_000;
const onHour = (t: string) => Date.parse(t) % HOUR_MS === 0;
const floorHour = (t: string) => new Date(Math.floor(Date.parse(t) / HOUR_MS) * HOUR_MS).toISOString();
const ceilHour = (t: string) => new Date(Math.ceil(Date.parse(t) / HOUR_MS) * HOUR_MS).toISOString();

/** "Nov 17, 8:00 PM – 9:00 PM", or both dates when the window crosses a day. */
function windowLabel(w: { from: string; to: string }, formatDateTime: DateTimeFormatters['formatDateTime'], formatTime: DateTimeFormatters['formatTime']): string {
  const a = new Date(w.from), b = new Date(w.to);
  const sameDay = a.toDateString() === b.toDateString();
  return `${formatDateTime(a, { year: undefined })} – ${sameDay ? formatTime(b) : formatDateTime(b, { year: undefined })}`;
}

function clientLabel(c: { mac: string; custom_name: string | null; hostname: string | null; vendor: string | null }): string {
  if (c.mac === 'unknown') return 'Unattributed (local)';
  if (c.mac === 'other') return 'Other clients';
  return c.custom_name || c.hostname || c.vendor || c.mac;
}

/**
 * Dragging across a chart picks a window to zoom to (#463). Both charts share
 * one drag, so the band shows on each. Points are labelled with the end of the
 * span they sum, so the window starts one span before the first point picked.
 */
function useDragZoom(series: { time: string }[], onPick: (from: string, to: string) => void) {
  // Recharts calls these on the next animation frame, with the handler that was
  // current when the event fired, and works out the point under the mouse on a
  // frame of its own. So a quick drag's moves can carry a handler from before
  // the mouse-down rendered, and a mouse-down can come before its point is
  // known. The ref is always the latest drag, and a drag whose mouse-down had
  // no point starts at the first move that has one.
  type Drag = { a: string | null; b: string | null };
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const label = (s: MouseHandlerDataParam | null | undefined) => (s?.activeLabel != null ? String(s.activeLabel) : null);
  const step = (() => {
    let min = Infinity;
    for (let i = 1; i < series.length; i++) min = Math.min(min, Date.parse(series[i].time) - Date.parse(series[i - 1].time));
    return Number.isFinite(min) && min > 0 ? min : 60_000;
  })();
  const handlers = {
    onMouseDown: (s: MouseHandlerDataParam) => { const l = label(s); setDrag({ a: l, b: l }); },
    onMouseMove: (s: MouseHandlerDataParam) => {
      const l = label(s), d = dragRef.current;
      if (d && l && l !== d.b) setDrag({ a: d.a ?? l, b: l });
    },
    onMouseUp: (s: MouseHandlerDataParam) => {
      const l = label(s), d = dragRef.current;
      const a = d?.a, b = l ?? d?.b;
      if (a && b && a !== b) {
        const [from, to] = [Date.parse(a), Date.parse(b)].sort((x, y) => x - y);
        onPick(new Date(from - step).toISOString(), new Date(to).toISOString());
      }
      setDrag(null);
    },
    onMouseLeave: () => setDrag(null),
  };
  const band = drag?.a && drag.b && drag.a !== drag.b
    ? <ReferenceArea x1={drag.a} x2={drag.b} fill="#3b82f6" fillOpacity={0.12} stroke="#3b82f6" strokeOpacity={0.4} />
    : null;
  return { handlers, band };
}

/**
 * One application's traffic (#366): who generates it, and where it goes. A
 * client's "Where to" opens its destinations for this application.
 */
function AppClientsCard({ app, range, onClose }: { app: string; range: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'clients' | 'destinations' | 'names'>('clients');
  // DNS traffic also has the names behind it, from AdGuard Home (#366 step 3).
  const isDns = app === 'DNS';
  const tabs = isDns ? (['clients', 'destinations', 'names'] as const) : (['clients', 'destinations'] as const);
  const [whereTo, setWhereTo] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['traffic-app-clients', app, range],
    queryFn: () => trafficApi.appClients(app, range).then((r) => r.data),
  });
  const max = Math.max(1, ...(data?.clients ?? []).map((c) => c.total_bytes));
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
        <Activity className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200 truncate">{app}</h2>
        <div className="flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden text-xs" role="tablist">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={clsx('px-2.5 py-1', tab === t ? 'bg-indigo-500 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/40')}>
              {t === 'clients' ? 'Who\u2019s using it' : t === 'destinations' ? 'Where it goes' : 'Names looked up'}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 dark:text-slate-500 ml-auto flex-shrink-0">
          {data ? `${data.client_count} client${data.client_count === 1 ? '' : 's'} · ${formatBytes(data.total_bytes)}` : ''}
        </span>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-slate-200" title="Close"><X className="w-4 h-4" /></button>
      </div>
      {tab === 'names' ? <DnsNamesList range={range} className="max-h-[28rem] overflow-y-auto" />
        : tab === 'destinations' ? <DestinationsList range={range} app={app} className="max-h-[28rem] overflow-y-auto" />
        : isLoading ? <div className="p-6 text-center text-sm text-gray-400">Loading…</div>
        : isError ? <div className="p-6 text-center text-sm text-red-500">The metrics database could not be read, so this data is unavailable right now.</div>
        : !data || data.clients.length === 0 ? <div className="p-6 text-center text-sm text-gray-400 dark:text-slate-500">No client traffic for {app} in this range.</div>
        : (
          <div className="divide-y divide-gray-100 dark:divide-slate-800 max-h-[28rem] overflow-y-auto">
            {data.clients.map((c) => {
              const isReal = c.mac !== 'unknown' && c.mac !== 'other';
              return (
                <div key={c.mac} onClick={() => isReal && navigate(`/clients/${encodeURIComponent(c.mac)}`)}
                  className={clsx('px-5 py-2', isReal && 'cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700/40 transition-colors')}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="min-w-0 truncate">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{clientLabel(c)}</span>
                      {isReal && <span className="ml-2 font-mono text-xs text-gray-400 dark:text-slate-500">{c.ip_address || c.mac}</span>}
                    </div>
                    <span className="text-xs text-gray-500 dark:text-slate-400 flex-shrink-0 w-12 text-right">{(c.share * 100).toFixed(1)}%</span>
                    <span className="text-sm font-semibold text-gray-700 dark:text-slate-200 flex-shrink-0 w-20 text-right">{formatBytes(c.total_bytes)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, (c.total_bytes / max) * 100)}%` }} />
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-gray-400 dark:text-slate-500">
                    <span className="inline-flex items-center gap-0.5"><ArrowDown className="w-3 h-3" />{formatBytes(c.download_bytes)}</span>
                    <span className="inline-flex items-center gap-0.5"><ArrowUp className="w-3 h-3" />{formatBytes(c.upload_bytes)}</span>
                    {c.mac !== 'other' && (
                      <button type="button" className="ml-auto inline-flex items-center gap-0.5 text-teal-600 dark:text-teal-400 hover:underline"
                        onClick={(e) => { e.stopPropagation(); setWhereTo(whereTo === c.mac ? null : c.mac); }}>
                        <MapPin className="w-3 h-3" />{whereTo === c.mac ? 'Hide' : isDns ? 'Names' : 'Where to'}
                      </button>
                    )}
                  </div>
                  {whereTo === c.mac && (
                    <div className="mt-2 -mx-5 border-t border-gray-100 dark:border-slate-800 bg-gray-50/60 dark:bg-slate-900/40" onClick={(e) => e.stopPropagation()}>
                      {isDns && c.mac !== 'unknown'
                        ? <DnsNamesList range={range} mac={c.mac} limit={15} />
                        : <DestinationsList range={range} app={app} mac={c.mac} limit={10} />}
                    </div>
                  )}
                </div>
              );
            })}
            {data.client_count > data.clients.length && (
              <div className="px-5 py-2 text-xs text-gray-400 dark:text-slate-500">The top {data.clients.length} of {data.client_count} clients.</div>
            )}
          </div>
        )}
    </div>
  );
}

export default function TrafficAnalyticsPage() {
  const { formatDateTime, formatTime } = useDateTimeFormat();
  const [range, setPreset] = useRememberedRange<Range>('traffic-analytics', '24h', RANGES);
  // A window picked on the chart (#463), inside the preset; everything on the
  // page follows it. Picking a preset leaves it.
  const [zoom, setZoom] = useState<{ from: string; to: string } | null>(null);
  const setRange = (r: Range) => { setZoom(null); setPreset(r); };
  const view = zoom ? `${zoom.from}/${zoom.to}` : range;
  const spanMs = zoom ? Date.parse(zoom.to) - Date.parse(zoom.from) : { '1h': 1, '24h': 24, '7d': 168, '30d': 720 }[range] * 3_600_000;
  const showDays = spanMs > 2 * 86_400_000;
  // A window in the past doesn't change; only a preset keeps up with now.
  const refetch = zoom ? false : 60_000;
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  // Top Talkers was a fixed list of ten with no way to look anything up, which
  // is unusable on a network of any size — you could see the loudest ten and
  // nothing else. Filtering happens client-side because the rows are already
  // here; asking the server again per keystroke would be slower and no more
  // accurate.
  const [clientQuery, setClientQuery] = useState('');
  const [topLimit, setTopLimit] = useState(10);
  // Top Talkers shows five rows and scrolls for the rest, so it stays the
  // height of Traffic by Application beside it.
  const [talkerListRef, talkerListPx] = useRowsHeight(5, 64, 1);
  const navigate = useNavigate();

  const { data: series = [], isLoading: seriesLoading, isError: seriesError, error: seriesErr } = useQuery({
    queryKey: ['traffic-timeseries', view],
    queryFn: () => trafficApi.timeseries(view).then(r => r.data),
    refetchInterval: refetch,
  });

  const { data: topClients = [], isLoading: clientsLoading, isError: clientsError } = useQuery({
    queryKey: ['traffic-top-clients', view, topLimit],
    queryFn: () => trafficApi.topClients(view, topLimit).then(r => r.data),
    refetchInterval: refetch,
  });

  const { data: apps = [], isLoading: appsLoading, isError: appsError } = useQuery({
    queryKey: ['traffic-apps', view],
    queryFn: () => trafficApi.apps(view).then(r => r.data),
    refetchInterval: refetch,
  });

  const { data: status } = useQuery({
    queryKey: ['traffic-status'],
    queryFn: () => trafficApi.status().then(r => r.data),
    refetchInterval: 30_000,
  });

  const isLoading = seriesLoading || clientsLoading || appsLoading;
  // A zoomed window with nothing in it still shows the page, so you can zoom back out.
  const hasData = series.length > 0 || topClients.length > 0 || apps.length > 0 || !!zoom;
  const { handlers: zoomHandlers, band: zoomBand } = useDragZoom(series, (from, to) => setZoom({ from, to }));
  // Volume per point, or bits and packets per second (Settings → Appearance).
  const tf = trafficFormat(useThemeStore((s) => s.trafficUnits), formatCount);
  const chartSeries = tf.rate
    ? series.map((p) => ({
      ...p,
      download: tf.bytes(p.download, p.seconds),
      upload: tf.bytes(p.upload, p.seconds),
      downloadPackets: tf.packets(p.downloadPackets ?? 0, p.seconds),
    }))
    : series;
  const zoomLabel = zoom ? windowLabel(zoom, formatDateTime, formatTime) : '';
  // Destinations and DNS names are kept by the hour, so they cover every hour the window touches.
  const hourly = zoom && !(onHour(zoom.from) && onHour(zoom.to))
    ? windowLabel({ from: floorHour(zoom.from), to: ceilHour(zoom.to) }, formatDateTime, formatTime) : null;

  const totalUpload = series.reduce((s, p) => s + p.upload, 0);
  const totalDownload = series.reduce((s, p) => s + p.download, 0);
  const totalAppBytes = apps.reduce((s, a) => s + a.bytes, 0);
  const maxClientBytes = topClients[0]?.total_bytes || 1;

  // Match on anything the row actually shows — name, IP, MAC or vendor — so a
  // search for "192.168.1." or "apple" both behave the way people expect.
  const visibleClients = (() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return topClients;
    return topClients.filter((c) =>
      [clientLabel(c), c.ip_address, c.mac, c.vendor]
        .some((v) => v && String(v).toLowerCase().includes(q))
    );
  })();

  // Collector data-health: how much of the received traffic we could attribute
  const exporters = [...(status?.exporters || [])].sort((a, b) => b.flows - a.flows);
  const pktReceived = status?.packetsReceived || 0;
  const pktUnattributed = status?.packetsFromUnknownExporter || 0;
  const attributionRate = pktReceived > 0 ? ((pktReceived - pktUnattributed) / pktReceived) * 100 : 0;

  // Donut: top 8 categories, rest folded into "Other"
  const donutData: (TrafficApp & { folded?: boolean })[] = (() => {
    const top = apps.slice(0, 8);
    const rest = apps.slice(8).reduce((s, a) => s + a.bytes, 0);
    return rest > 0 ? [...top, { app: 'Other', bytes: rest, folded: true }] : top;
  })();
  // A slice or legend row opens who's using that application (#366).
  const pickApp = (app: string) => setSelectedApp((cur) => (cur === app ? null : app));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Traffic</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Per-client traffic analytics from NetFlow/IPFIX</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="card p-1 flex rounded-lg gap-1">
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={clsx('px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  range === r && !zoom
                    ? 'bg-blue-600 text-white shadow-sm'
                    : range === r
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700')}>
                {r}
              </button>
            ))}
          </div>
          <Link to="/network-services/netflow"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            <Settings2 className="w-3.5 h-3.5" />Configure
          </Link>
        </div>
      </div>

      {zoom && (
        <div className="card px-4 py-2.5 flex items-center gap-3 flex-wrap text-sm">
          <ZoomIn className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <span className="text-gray-700 dark:text-slate-200">Zoomed to <span className="font-semibold">{zoomLabel}</span></span>
          {hourly && (
            <span className="text-xs text-gray-400 dark:text-slate-500">Destinations and names are kept by the hour, so they cover {hourly}.</span>
          )}
          <button onClick={() => setZoom(null)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-gray-300 dark:border-slate-600 text-xs text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            <ZoomOut className="w-3.5 h-3.5" />Back to {range}
          </button>
        </div>
      )}

      {/* Empty state */}
      {/* A failed read is an error, not "set up NetFlow" (outside review J3). */}
      {(seriesError || clientsError || appsError) && (
        <div className="card"><LoadError what="traffic data" error={seriesErr} /></div>
      )}

      {!isLoading && !hasData && !(seriesError || clientsError || appsError) && (
        <div className="card p-12 text-center space-y-3">
          <Activity className="w-10 h-10 mx-auto text-gray-300 dark:text-slate-600" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">No traffic data yet</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 max-w-md mx-auto">
            Enable the NetFlow collector and turn on traffic export for your routers to start
            collecting per-client usage and protocol analytics.
          </p>
          <Link to="/network-services/netflow"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <Settings2 className="w-3.5 h-3.5" />Set up NetFlow
          </Link>
        </div>
      )}

      {hasData && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <ArrowDown className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Download ({zoom ? 'selection' : range})</div>
                <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(totalDownload)}</div>
              </div>
            </div>
            <div className="card p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-100 dark:bg-violet-900/30">
                <ArrowUp className="w-5 h-5 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <div className="text-xs text-gray-400 dark:text-slate-500">Upload ({zoom ? 'selection' : range})</div>
                <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(totalUpload)}</div>
              </div>
            </div>
          </div>

          {/* Throughput chart */}
          <div className="card p-5">
            <div className="flex items-baseline justify-between gap-2 flex-wrap mb-4">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Network Traffic</h2>
              <span className="text-xs text-gray-400 dark:text-slate-500">Drag across a chart to zoom in</span>
            </div>
            {zoom && series.length === 0 && (
              <div className="text-sm text-gray-400 dark:text-slate-500 text-center py-2">No traffic in this window.</div>
            )}
            <div className="select-none cursor-crosshair">
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartSeries} {...zoomHandlers}>
                <defs>
                  <linearGradient id="dl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ul" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-slate-700" />
                <XAxis dataKey="time" tickFormatter={timeFormatter(showDays, formatTime)} tick={{ fontSize: 11 }} stroke="currentColor" />
                <YAxis tickFormatter={v => tf.bytesLabel(v)} tick={{ fontSize: 11 }} width={tf.rate ? 84 : 70} stroke="currentColor" />
                <Tooltip
                  labelFormatter={t => { try { return formatDateTime(parseISO(String(t)), { year: undefined }); } catch { return String(t); } }}
                  formatter={(value, name) => [tf.bytesLabel(Number(value)), name === 'download' ? 'Download' : 'Upload']}
                  {...chartTooltip}
                />
                <Legend formatter={(v: string) => (v === 'download' ? 'Download' : 'Upload')} />
                <Area type="monotone" dataKey="download" stroke="#3b82f6" fill="url(#dl)" strokeWidth={2} />
                <Area type="monotone" dataKey="upload" stroke="#8b5cf6" fill="url(#ul)" strokeWidth={2} />
                {zoomBand}
              </AreaChart>
            </ResponsiveContainer>
            </div>
          </div>

          {/* Inbound packets chart */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200 mb-4">Inbound Packets</h2>
            <div className="select-none cursor-crosshair">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartSeries} {...zoomHandlers}>
                <defs>
                  <linearGradient id="pktIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-slate-700" />
                <XAxis dataKey="time" tickFormatter={timeFormatter(showDays, formatTime)} tick={{ fontSize: 11 }} stroke="currentColor" />
                <YAxis tickFormatter={v => tf.packetsAxis(v)} tick={{ fontSize: 11 }} width={tf.rate ? 84 : 55} stroke="currentColor" />
                <Tooltip
                  labelFormatter={t => { try { return formatDateTime(parseISO(String(t)), { year: undefined }); } catch { return String(t); } }}
                  formatter={(value) => [tf.packetsLabel(Number(value)), 'Inbound']}
                  {...chartTooltip}
                />
                <Area type="monotone" dataKey="downloadPackets" stroke="#10b981" fill="url(#pktIn)" strokeWidth={2} />
                {zoomBand}
              </AreaChart>
            </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top talkers: five rows high, scrolling for the rest */}
            <div className="card overflow-hidden lg:col-start-1 lg:row-start-1">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <BarChart3 className="w-4 h-4 text-blue-500" />
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Top Talkers</h2>
                  <span className="text-xs text-gray-400 dark:text-slate-500 ml-auto">
                    {clientQuery.trim()
                      ? `${visibleClients.length} of ${topClients.length}`
                      : `top ${topClients.length}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={clientQuery}
                    onChange={(e) => setClientQuery(e.target.value)}
                    placeholder="Filter by IP, name, MAC or vendor…"
                    className="input text-xs py-1 flex-1 min-w-0"
                  />
                  <select
                    value={topLimit}
                    onChange={(e) => setTopLimit(Number(e.target.value))}
                    className="input text-xs py-1 w-auto"
                    title="How many clients to rank"
                  >
                    {[10, 25, 50].map((n) => <option key={n} value={n}>Top {n}</option>)}
                  </select>
                </div>
              </div>
              {topClients.length === 0
                ? <div className="p-6 flex items-center justify-center text-center text-sm text-gray-400 dark:text-slate-500" style={{ height: talkerListPx }}>No client traffic recorded.</div>
                : visibleClients.length === 0
                ? <div className="p-6 flex items-center justify-center text-center text-sm text-gray-400 dark:text-slate-500" style={{ height: talkerListPx }}>
                    No client in the top {topClients.length} matches “{clientQuery.trim()}”.
                  </div>
                : (
                  <div ref={talkerListRef} className="divide-y divide-gray-100 dark:divide-slate-800 overflow-y-auto" style={{ height: talkerListPx }}>
                    {visibleClients.map(c => {
                      const isReal = c.mac !== 'unknown' && c.mac !== 'other';
                      return (
                        <div key={c.mac}
                          onClick={() => isReal && navigate(`/clients/${encodeURIComponent(c.mac)}`)}
                          className={clsx('px-5 py-2', isReal && 'cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700/40 transition-colors')}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{clientLabel(c)}</span>
                              {isReal && (
                                <span className="ml-2 font-mono text-xs text-gray-400 dark:text-slate-500">{c.ip_address || c.mac}</span>
                              )}
                            </div>
                            <span className="text-sm font-semibold text-gray-700 dark:text-slate-200 flex-shrink-0">{formatBytes(c.total_bytes)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                            <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.max(2, (c.total_bytes / maxClientBytes) * 100)}%` }} />
                          </div>
                          <div className="mt-0.5 flex gap-3 text-xs text-gray-400 dark:text-slate-500">
                            <span className="inline-flex items-center gap-0.5"><ArrowDown className="w-3 h-3" />{formatBytes(c.download_bytes)}</span>
                            <span className="inline-flex items-center gap-0.5"><ArrowUp className="w-3 h-3" />{formatBytes(c.upload_bytes)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>

            {/* App categories: beside Top Talkers and the same height. On wide
                screens contain:size keeps its own content out of the row's sizing,
                so Top Talkers sets the height and this card fills it. */}
            <div className="card overflow-hidden flex flex-col lg:col-start-2 lg:row-start-1 lg:[contain:size]">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Traffic by Application</h2>
              </div>
              {apps.length === 0
                ? <div className="p-6 flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-slate-500">No application data recorded.</div>
                : (
                  <div className="p-5 flex-1 min-h-0 overflow-y-auto flex flex-col sm:flex-row sm:items-center gap-5">
                    {/* Donut — grows to fill the available space */}
                    <div className="relative w-full sm:w-1/2 flex-shrink-0">
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie data={donutData} dataKey="bytes" nameKey="app" innerRadius="58%" outerRadius="92%" paddingAngle={1.5} stroke="none"
                            className="cursor-pointer"
                            onClick={(_d, i) => { const d = donutData[i]; if (d && !d.folded) pickApp(d.app); }}>
                            {donutData.map((entry, i) => (
                              <Cell key={entry.app} fill={APP_COLORS[i % APP_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(value, name) => [
                              `${formatBytes(Number(value))}${totalAppBytes > 0 ? ` · ${((Number(value) / totalAppBytes) * 100).toFixed(1)}%` : ''}`,
                              name,
                            ]}
                            {...pieTooltip}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      {/* Center label */}
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <span className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-slate-500">Total</span>
                        <span className="text-base font-bold text-gray-900 dark:text-white">{formatBytes(totalAppBytes)}</span>
                      </div>
                    </div>
                    {/* Legend — uses the vertical space beside the donut */}
                    <div className="flex-1 min-w-0 space-y-1.5">
                      {apps.slice(0, 12).map((a, i) => (
                        <button key={a.app} onClick={() => pickApp(a.app)} title={`Who's using ${a.app}`}
                          className={clsx('w-full flex items-center gap-2 text-sm text-left rounded px-1 -mx-1 hover:bg-gray-50 dark:hover:bg-slate-700/40',
                            selectedApp === a.app && 'bg-indigo-50 dark:bg-indigo-900/20')}>
                          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: APP_COLORS[i % APP_COLORS.length] }} />
                          <span className="text-gray-700 dark:text-slate-300 flex-1 truncate">{a.app}</span>
                          <span className="text-gray-500 dark:text-slate-400 text-xs w-12 text-right">
                            {totalAppBytes > 0 ? `${((a.bytes / totalAppBytes) * 100).toFixed(1)}%` : ''}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-white w-20 text-right">{formatBytes(a.bytes)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
            </div>

            {/* Right column under it: who uses the picked application, then data
                health. Before Top Destinations in the page so on a phone the
                picked application's clients open right under the donut. */}
            <div className="space-y-6 lg:col-start-2 lg:row-start-2 self-start">
            {selectedApp && <AppClientsCard app={selectedApp} range={view} onClose={() => setSelectedApp(null)} />}

            {/* Flow sources & data health */}
            <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <RouterIcon className="w-4 h-4 text-cyan-500" />
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Flow Sources &amp; Data Health</h2>
              </div>
              <span className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
                status?.listening
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400')}>
                <span className={clsx('w-1.5 h-1.5 rounded-full', status?.listening ? 'bg-emerald-500' : 'bg-gray-400')} />
                {status?.listening ? `Listening :${status.port}` : 'Collector stopped'}
              </span>
            </div>
            <div className="p-5 space-y-4">
              {/* The charts and the sources below follow the site selector; the
                  collector's own counters cover everything it receives (#236). */}
              {status?.site_filtered && (
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  Showing this site&apos;s flow sources. Packet and attribution counts cover the whole collector.
                </p>
              )}
              {/* Health summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-gray-400 dark:text-slate-500">Packets received{status?.site_filtered ? ' (all sites)' : ''}</div>
                  <div className="text-base font-bold text-gray-900 dark:text-white">{formatCount(pktReceived)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-slate-500" title="Flows counted into Traffic, including those in Unattributed (local).">Flows counted{status?.site_filtered ? ' (all sites)' : ''}</div>
                  <div className="text-base font-bold text-gray-900 dark:text-white">{formatCount(status?.flowsAttributed || 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-slate-500" title="Packets from a device recognised as the exporter. How much traffic was matched to a client shows in Top Talkers, as what isn't in Unattributed (local) (Discussion #486).">From known exporters{status?.site_filtered ? ' (all sites)' : ''}</div>
                  <div className={clsx('text-base font-bold',
                    attributionRate >= 90 ? 'text-emerald-600 dark:text-emerald-400'
                      : attributionRate >= 60 ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400')}>
                    {pktReceived > 0 ? `${attributionRate.toFixed(0)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-slate-500">{status?.site_filtered ? 'Exporting devices here' : 'Exporting devices'}</div>
                  <div className="text-base font-bold text-gray-900 dark:text-white">{exporters.length}</div>
                </div>
              </div>

              {/* Low-attribution hint */}
              {pktReceived > 0 && attributionRate < 90 && (
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    {formatCount(pktUnattributed)} packets came from an unrecognized exporter (often NAT in the path).
                    Their traffic is still counted but may not map to the right device.
                  </span>
                </div>
              )}

              {/* Per-exporter rows */}
              {exporters.length === 0
                ? <div className="text-sm text-gray-400 dark:text-slate-500">{status?.site_filtered ? 'No routers in this site have exported flows yet.' : 'No routers have exported flows yet.'} <Link to="/network-services/netflow" className="text-blue-600 dark:text-blue-400 hover:underline">Configure NetFlow export →</Link></div>
                : (
                  <div className="divide-y divide-gray-100 dark:divide-slate-800 -mb-1">
                    {exporters.map(e => (
                      <div key={e.deviceId} className="flex items-center justify-between py-2 gap-3">
                        <div className="min-w-0 flex items-center gap-2">
                          <RouterIcon className="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 flex-shrink-0" />
                          <span className="text-sm text-gray-700 dark:text-slate-200 truncate">{e.deviceName}</span>
                        </div>
                        <div className="flex items-center gap-4 flex-shrink-0 text-xs text-gray-500 dark:text-slate-400">
                          <span>{formatCount(e.flows)} flows</span>
                          <span>{formatCount(e.packets)} pkts</span>
                          <span className="w-24 text-right text-gray-400 dark:text-slate-500">
                            {e.lastSeen ? `${formatDistanceToNow(parseISO(e.lastSeen))} ago` : 'never'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
            </div>
            </div>

            {/* Where the site's traffic goes (#366 step 2), under Top Talkers */}
            <div className="card overflow-hidden self-start lg:col-start-1 lg:row-start-2">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                <Globe className="w-4 h-4 text-teal-500" />
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Top Destinations</h2>
                <span className="text-xs text-gray-400 dark:text-slate-500 ml-auto">Click one to see who used it</span>
              </div>
              <DestinationsList range={view} limit={15} className="max-h-[32rem] overflow-y-auto" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
