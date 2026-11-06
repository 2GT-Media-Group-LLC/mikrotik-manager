import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { metricsApi, type GraphPoint } from '../../services/api';
import type { ResourcePoint } from '../../types';
import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { useRememberedRange } from '../../hooks/useRememberedRange';
import { chartTooltip } from '../common/chartTooltip';

/**
 * Device graphs (#402): CPU (overall and per core), memory, connections and
 * NAT, firewall drops, several interfaces at once, and temperatures. One
 * range for the tab, a hover cursor shared by every chart, and sections that
 * only appear where the device has the data. Averages per window with the
 * peak in each window, so a burst doesn't hide in the average.
 */
const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
const RANGE_MS: Record<string, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
const SYNC = 'device-graphs';
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];
type SectionId = 'cpu' | 'memory' | 'connections' | 'firewall' | 'interfaces' | 'health';
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'cpu', label: 'CPU' }, { id: 'memory', label: 'Memory' }, { id: 'connections', label: 'Connections' },
  { id: 'firewall', label: 'Firewall' }, { id: 'interfaces', label: 'Interfaces' }, { id: 'health', label: 'Health' },
];
const HIDDEN_KEY = 'device-graphs.hidden';
const COLLAPSED_KEY = 'device-graphs.collapsed';

const loadSet = (key: string): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]); } catch { return new Set(); }
};
const saveSet = (key: string, v: Set<string>) => { try { localStorage.setItem(key, JSON.stringify([...v])); } catch { /* private mode */ } };

const fmtK = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);
const fmtBits = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)} Gb/s` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} Mb/s` : v >= 1e3 ? `${(v / 1e3).toFixed(0)} kb/s` : `${Math.round(v)} b/s`);
const fmtPct = (v: number) => `${Math.round(v)}%`;
const fmtPps = (v: number) => (v >= 100 ? `${fmtK(v)}/s` : `${v.toFixed(v >= 1 ? 1 : 2)}/s`);

interface LineSpec { key: string; name: string; color: string; band?: string; dashed?: boolean }

/**
 * Every chart shares the same time axis (the range up to now), so they line
 * up, and the hover cursor follows the time, not the point's position.
 */
interface TimeAxis { domain: [number, number]; ticks: number[]; tick: (ms: number) => string }

function SeriesChart({ data, lines, unit, height = 150, domain, time }: {
  data: Record<string, unknown>[]; lines: LineSpec[]; unit: (v: number) => string; height?: number; domain?: [number, number]; time: TimeAxis;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} syncId={SYNC} syncMethod="value" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-slate-600" opacity={0.5} />
        <XAxis dataKey="ts" type="number" scale="time" domain={time.domain} ticks={time.ticks} allowDataOverflow tickFormatter={time.tick}
          tick={{ fontSize: 10 }} minTickGap={40} />
        <YAxis tickFormatter={unit} tick={{ fontSize: 10 }} width={64} domain={domain ?? [0, 'auto']} />
        <Tooltip {...chartTooltip} labelFormatter={(v) => time.tick(Number(v))}
          formatter={(v) => (Array.isArray(v) ? unit(Number(v[1])) : unit(Number(v)))} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {lines.map((l) => l.band
          ? <Area key={l.key} type="monotone" dataKey={l.band} stroke="none" fill={l.color} fillOpacity={0.18} name={`${l.name} peak`} isAnimationActive={false} legendType="none" />
          : null)}
        {lines.map((l) => (
          <Line key={`${l.key}-line`} type="monotone" dataKey={l.key} stroke={l.color} name={l.name} dot={false} strokeWidth={1.6}
            strokeDasharray={l.dashed ? '4 3' : undefined} isAnimationActive={false} connectNulls />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function Section({ id, title, summary, collapsed, onToggle, since, children }: {
  id: SectionId; title: string; summary?: React.ReactNode; collapsed: boolean; onToggle: (id: SectionId) => void;
  /** When the series began, if that's well inside the range: an empty start is "not recorded yet", not "nothing happened". */
  since?: string | null; children: React.ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={() => onToggle(id)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        {collapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
        {summary && <span className="text-xs text-gray-500 dark:text-slate-400 truncate">{summary}</span>}
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 space-y-3">
          {since && <p className="text-xs text-gray-400 dark:text-slate-500">Recorded since {since}; nothing before that in this range.</p>}
          {children}
        </div>
      )}
    </div>
  );
}

const sub = 'text-xs font-medium text-gray-500 dark:text-slate-400';

/** One graph series for the tab's range, refreshed each minute. */
function useGraphQuery<T>(deviceId: number, range: string, key: string, fn: () => Promise<T>) {
  return useQuery({ queryKey: ['device-graphs', deviceId, key, range], queryFn: fn, refetchInterval: 60_000 });
}

export default function GraphsTab({ deviceId }: { deviceId: number }) {
  const { formatTime, formatDateTime } = useDateTimeFormat();
  const [range, setRange] = useRememberedRange<string>('device-graphs', '24h');
  const [hidden, setHidden] = useState(() => loadSet(HIDDEN_KEY));
  const [collapsed, setCollapsed] = useState(() => loadSet(COLLAPSED_KEY));
  const [ifacePick, setIfacePick] = useState<string[]>([]);
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next); saveSet(key, next);
  };
  const short = range === '1h' || range === '6h' || range === '24h';
  const label = (t: string) => (short ? formatTime(t) : formatDateTime(t, { year: undefined }));
  const nowMs = Date.now();
  const start = nowMs - (RANGE_MS[range] ?? RANGE_MS['24h']);
  // The same labels on every chart, across the whole range, wherever a series has data.
  const ticks = Array.from({ length: 7 }, (_, i) => Math.round(start + ((nowMs - start) * i) / 6));
  const time: TimeAxis = { domain: [start, nowMs], ticks, tick: (ms) => label(new Date(ms).toISOString()) };

  const resources = useGraphQuery(deviceId, range, 'resources', () => metricsApi.deviceResources(deviceId, range).then((r) => r.data as ResourcePoint[]));
  const cores = useGraphQuery(deviceId, range, 'cores', () => metricsApi.deviceSeries(deviceId, 'cpu_cores', range).then((r) => r.data));
  const conntrack = useGraphQuery(deviceId, range, 'conntrack', () => metricsApi.deviceSeries(deviceId, 'conntrack', range).then((r) => r.data));
  const split = useGraphQuery(deviceId, range, 'split', () => metricsApi.deviceSeries(deviceId, 'conntrack_split', range).then((r) => r.data));
  const drops = useGraphQuery(deviceId, range, 'drops', () => metricsApi.deviceSeries(deviceId, 'firewall_drops', range).then((r) => r.data));
  const dropRules = useGraphQuery(deviceId, range, 'drop-rules', () => metricsApi.deviceDropRules(deviceId, range).then((r) => r.data));
  const temps = useGraphQuery(deviceId, range, 'temps', () => metricsApi.deviceSeries(deviceId, 'health_temps', range).then((r) => r.data));
  const ifaces = useQuery({
    queryKey: ['device-graphs', deviceId, 'interfaces', range, ifacePick.join(',')],
    queryFn: () => metricsApi.deviceInterfaces(deviceId, range, ifacePick).then((r) => r.data),
    refetchInterval: 60_000,
  });

  // A series that began well inside the range (new in this release, or a new
  // device) gets a note instead of a silently empty left side (aziz, #402).
  const sinceOf = (times: (string | number | undefined)[]) => {
    const first = Math.min(...times.map((t) => (typeof t === 'number' ? t : Date.parse(String(t)))).filter(Number.isFinite));
    return Number.isFinite(first) && first - start > (nowMs - start) * 0.05 ? formatDateTime(new Date(first).toISOString(), { year: undefined }) : null;
  };
  const fieldsOf = (rows: GraphPoint[] | undefined, re: RegExp) =>
    [...new Set((rows ?? []).flatMap((r) => Object.keys(r)).filter((k) => k !== 'time' && k !== 'label' && re.test(k) && !k.endsWith('_peak')))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const withLabels = (rows: GraphPoint[] | undefined, extra?: (r: GraphPoint) => Record<string, unknown>) =>
    (rows ?? []).map((r) => ({ ...r, ts: Date.parse(String(r.time)), ...(extra ? extra(r) : {}) }));

  // CPU and memory: average lines, a band up to each window's peak.
  const res = useMemo(() => (resources.data ?? []).map((p) => {
    const mem = p.memory_total ? ((p.memory_used ?? 0) / p.memory_total) * 100 : 0;
    const memPeak = p.memory_total && p.memory_used_peak !== undefined ? (p.memory_used_peak / p.memory_total) * 100 : undefined;
    return {
      ts: Date.parse(p.time), cpu: Math.round(p.cpu_load ?? 0), mem: Math.round(mem),
      cpuBand: p.cpu_load_peak !== undefined ? [Math.round(p.cpu_load ?? 0), Math.round(Math.max(p.cpu_load ?? 0, p.cpu_load_peak))] : undefined,
      memBand: memPeak !== undefined && memPeak - mem > 2 ? [Math.round(mem), Math.round(memPeak)] : undefined,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [resources.data, range]);
  const cpuAvg = res.length ? res.reduce((n, p) => n + p.cpu, 0) / res.length : null;
  const cpuMax = res.length ? Math.max(...res.map((p) => (p.cpuBand ? p.cpuBand[1] : p.cpu))) : null;
  const memNow = res.length ? res[res.length - 1].mem : null;
  const coreKeys = fieldsOf(cores.data, /^cpu\d+$/);

  const ctRows = conntrack.data ?? [];
  const ctLast = ctRows[ctRows.length - 1];
  const ctPeak = ctRows.reduce<{ v: number; t: string } | null>((m, r) => {
    const v = Number(r.total_peak ?? r.total ?? 0);
    return !m || v > m.v ? { v, t: String(r.time) } : m;
  }, null);
  const hasNewPs = ctRows.some((r) => r.new_ps !== undefined);
  const splitRows = split.data ?? [];
  const dropKeys = fieldsOf(drops.data, /^pps_/);
  const tempKeys = fieldsOf(temps.data, /^[a-z0-9_]+$/);

  const ifaceData = ifaces.data?.interfaces ?? [];
  const ifaceRows = useMemo(() => {
    const byTime = new Map<string, Record<string, unknown>>();
    for (const i of ifaceData) {
      for (const p of i.points) {
        const row = byTime.get(p.time) ?? { time: p.time, ts: Date.parse(p.time) };
        row[`${i.name}|rx`] = p.rx_bps ?? 0;
        row[`${i.name}|tx`] = p.tx_bps ?? 0;
        row[`${i.name}|pps`] = (p.rx_pps ?? 0) + (p.tx_pps ?? 0);
        if (i.speed_bps) row[`${i.name}|util`] = (Math.max(p.rx_bps ?? 0, p.tx_bps ?? 0) / i.speed_bps) * 100;
        byTime.set(p.time, row);
      }
    }
    return [...byTime.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ifaceData, range]);

  const has: Record<SectionId, boolean> = {
    cpu: res.length > 0, memory: res.length > 0, connections: ctRows.length > 0, firewall: dropKeys.length > 0,
    interfaces: ifaceData.length > 0 || (ifaces.data?.available.length ?? 0) > 0, health: tempKeys.length > 0,
  };
  const shown = (id: SectionId) => has[id] && !hidden.has(id);
  const onCollapse = (id: SectionId) => toggle(collapsed, setCollapsed, COLLAPSED_KEY, id);
  const prettyChain = (k: string) => k.replace(/^pps_/, '').replace(/_/g, ' ');
  const prettyTemp = (k: string) => k.replace(/_/g, ' ').replace(/temperature/, 'temp');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={clsx('px-2 py-1 text-xs rounded font-medium', range === r ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200')}>
              {r}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SECTIONS.filter((s) => has[s.id]).map((s) => (
            <button key={s.id} onClick={() => toggle(hidden, setHidden, HIDDEN_KEY, s.id)}
              className={clsx('px-2 py-0.5 rounded-full text-xs border', hidden.has(s.id)
                ? 'border-gray-300 dark:border-slate-600 text-gray-400' : 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300')}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {shown('cpu') && (
        <Section id="cpu" title="CPU" collapsed={collapsed.has('cpu')} onToggle={onCollapse} since={sinceOf(res.map((p) => p.ts))}
          summary={cpuAvg !== null ? `average ${Math.round(cpuAvg)}% · peak ${cpuMax}% in ${range}` : undefined}>
          <SeriesChart time={time} data={res} unit={fmtPct} domain={[0, 100]} lines={[{ key: 'cpu', band: 'cpuBand', name: 'CPU', color: '#f59e0b' }]} />
          {coreKeys.length > 1 && (
            <>
              <div className={sub}>Per core (a single core pinned at 100% doesn&apos;t show in the overall load)</div>
              <SeriesChart time={time} data={withLabels(cores.data)} unit={fmtPct} domain={[0, 100]} height={130}
                lines={coreKeys.map((k, i) => ({ key: k, name: k, color: COLORS[i % COLORS.length] }))} />
            </>
          )}
        </Section>
      )}

      {shown('memory') && (
        <Section id="memory" title="Memory" collapsed={collapsed.has('memory')} onToggle={onCollapse} since={sinceOf(res.map((p) => p.ts))}
          summary={memNow !== null ? `${memNow}% used now` : undefined}>
          <SeriesChart time={time} data={res} unit={fmtPct} domain={[0, 100]} height={120} lines={[{ key: 'mem', band: 'memBand', name: 'Memory used', color: '#8b5cf6' }]} />
        </Section>
      )}

      {shown('connections') && (
        <Section id="connections" title="Connections" collapsed={collapsed.has('connections')} onToggle={onCollapse} since={sinceOf(ctRows.map((r) => r.time))}
          summary={ctLast ? <>conntrack {fmtK(Number(ctLast.total ?? 0))} of {fmtK(Number(ctLast.max ?? 0))}
            {Number(ctLast.max) > 0 ? ` (${Math.round((Number(ctLast.total ?? 0) / Number(ctLast.max)) * 100)}%)` : ''}
            {ctPeak ? ` · peak ${fmtK(ctPeak.v)} at ${formatDateTime(ctPeak.t, { year: undefined })}` : ''}</> : undefined}>
          <SeriesChart time={time} data={withLabels(ctRows, (r) => ({ band: [Number(r.total ?? 0), Number(r.total_peak ?? r.total ?? 0)] }))} unit={fmtK}
            lines={[{ key: 'total', band: 'band', name: 'Active connections', color: '#8b5cf6' }]} />
          {splitRows.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div>
                <div className={sub}>By protocol</div>
                <SeriesChart time={time} data={withLabels(splitRows)} unit={fmtK} height={120}
                  lines={[{ key: 'tcp', name: 'TCP', color: '#3b82f6' }, { key: 'udp', name: 'UDP', color: '#10b981' }, { key: 'other', name: 'Other', color: '#94a3b8' }]} />
              </div>
              <div>
                <div className={sub}>NAT translations</div>
                <SeriesChart time={time} data={withLabels(splitRows)} unit={fmtK} height={120}
                  lines={[{ key: 'srcnat', name: 'src-nat', color: '#f59e0b' }, { key: 'dstnat', name: 'dst-nat', color: '#ef4444' }]} />
              </div>
            </div>
          )}
          {hasNewPs ? (
            <>
              <div className={sub}>New connections per second</div>
              <SeriesChart time={time} data={withLabels(ctRows)} unit={fmtPps} height={110} lines={[{ key: 'new_ps', name: 'New/s', color: '#06b6d4' }]} />
            </>
          ) : (
            <p className="text-xs text-gray-400 dark:text-slate-500">
              New connections per second need a counting rule on the router:
              <code className="ml-1 font-mono">/ip firewall mangle add chain=prerouting connection-state=new action=passthrough comment=mtm:new-conn</code>
            </p>
          )}
        </Section>
      )}

      {shown('firewall') && (
        <Section id="firewall" title="Firewall drops" collapsed={collapsed.has('firewall')} onToggle={onCollapse} since={sinceOf((drops.data ?? []).map((r) => r.time))}
          summary={dropRules.data && dropRules.data.length ? `top rule: ${dropRules.data[0].label} (${fmtK(dropRules.data[0].packets)} packets in ${range})` : 'packets/s dropped by drop and reject rules'}>
          <SeriesChart time={time} data={withLabels(drops.data)} unit={fmtPps}
            lines={dropKeys.map((k, i) => ({ key: k, name: prettyChain(k), color: COLORS[i % COLORS.length] }))} />
          {dropRules.data && dropRules.data.length > 0 && (
            <div>
              <div className={sub}>Top drop rules · {range}</div>
              <table className="w-full text-xs mt-1">
                <tbody>
                  {dropRules.data.map((r) => (
                    <tr key={r.rule} className="border-b border-gray-100 dark:border-slate-700">
                      <td className="py-1 pr-2 text-gray-500">{r.chain}</td>
                      <td className="py-1 pr-2">{r.label}</td>
                      <td className="py-1 text-right font-mono">{r.packets.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {shown('interfaces') && (
        <Section id="interfaces" title="Interfaces" collapsed={collapsed.has('interfaces')} onToggle={onCollapse} since={sinceOf(ifaceRows.map((r) => r.ts as number))}
          summary={ifacePick.length ? `${ifacePick.length} chosen` : 'the busiest in this range'}>
          <div className="flex flex-wrap gap-1.5">
            {(ifaces.data?.available ?? []).map((n) => {
              const on = ifacePick.length ? ifacePick.includes(n) : ifaceData.some((i) => i.name === n);
              return (
                <button key={n} onClick={() => {
                  const base = ifacePick.length ? ifacePick : ifaceData.map((i) => i.name);
                  setIfacePick(on ? base.filter((x) => x !== n) : [...base, n].slice(0, 8));
                }}
                  className={clsx('px-2 py-0.5 rounded text-[11px] font-mono border', on ? 'border-blue-500 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 text-gray-500')}>
                  {n}
                </button>
              );
            })}
            {ifacePick.length > 0 && <button onClick={() => setIfacePick([])} className="text-[11px] underline text-gray-500">busiest</button>}
          </div>
          {ifaceData.length === 0 ? <p className="text-xs text-gray-400">No traffic recorded in this range.</p> : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <div className={sub}>In (RX)</div>
                  <SeriesChart time={time} data={ifaceRows} unit={fmtBits} height={140}
                    lines={ifaceData.map((i, n) => ({ key: `${i.name}|rx`, name: i.name, color: COLORS[n % COLORS.length] }))} />
                </div>
                <div>
                  <div className={sub}>Out (TX)</div>
                  <SeriesChart time={time} data={ifaceRows} unit={fmtBits} height={140}
                    lines={ifaceData.map((i, n) => ({ key: `${i.name}|tx`, name: i.name, color: COLORS[n % COLORS.length] }))} />
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {ifaceData.some((i) => i.speed_bps) && (
                  <div>
                    <div className={sub}>Utilisation (busier direction, of link speed)</div>
                    <SeriesChart time={time} data={ifaceRows} unit={fmtPct} height={120} domain={[0, 100]}
                      lines={ifaceData.filter((i) => i.speed_bps).map((i) => ({ key: `${i.name}|util`, name: i.name, color: COLORS[ifaceData.indexOf(i) % COLORS.length] }))} />
                    {ifaceData.some((i) => !i.speed_bps) && (
                      <p className="text-xs text-gray-400 dark:text-slate-500">
                        Not shown, link speed unknown: {ifaceData.filter((i) => !i.speed_bps).map((i) => i.name).join(', ')}
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <div className={sub}>Packets per second</div>
                  <SeriesChart time={time} data={ifaceRows} unit={fmtPps} height={120}
                    lines={ifaceData.map((i, n) => ({ key: `${i.name}|pps`, name: i.name, color: COLORS[n % COLORS.length] }))} />
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-slate-500">A port&apos;s errors and drops are in its panel on the Ports tab.</p>
            </>
          )}
        </Section>
      )}

      {shown('health') && (
        <Section id="health" title="Temperature" collapsed={collapsed.has('health')} onToggle={onCollapse} since={sinceOf((temps.data ?? []).map((r) => r.time))}
          summary={temps.data?.length ? tempKeys.map((k) => `${prettyTemp(k)} ${Math.round(Number(temps.data![temps.data!.length - 1][k] ?? 0))}°C`).join(' · ') : undefined}>
          <SeriesChart time={time} data={withLabels(temps.data)} unit={(v) => `${Math.round(v)}°C`} height={130}
            lines={tempKeys.map((k, i) => ({ key: k, name: prettyTemp(k), color: COLORS[i % COLORS.length] }))} />
        </Section>
      )}

      {!Object.values(has).some(Boolean) && (resources.isFetched) && (
        <div className="card p-8 text-center text-sm text-gray-400">No history for this device yet. It builds up with each poll.</div>
      )}
    </div>
  );
}
