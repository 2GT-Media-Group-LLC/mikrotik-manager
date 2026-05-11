import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Users, AlertTriangle, Wifi, MapPin, ArrowUpCircle, Cpu, X,
  RefreshCw, Terminal, HardDrive, GitBranch, Activity,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { metricsApi, eventsApi, devicesApi, clientsApi } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import type { Device, DeviceEvent } from '../types';
import clsx from 'clsx';

// ─── Primitives ───────────────────────────────────────────────────────────────

function StatusDot({ color = 'var(--good)', glow = false, size = 6 }: {
  color?: string; glow?: boolean; size?: number;
}) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: 999, display: 'inline-block',
        background: color, flexShrink: 0,
        boxShadow: glow ? `0 0 0 2px ${color}33, 0 0 8px ${color}88` : 'none',
      }}
    />
  );
}

function Sparkline({ data, w = 120, h = 24, color = 'var(--accent)', area = true }: {
  data: number[]; w?: number; h?: number; color?: string; area?: boolean;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - ((v - min) / range) * (h - 2) - 1,
  ]);
  const d = 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  const areaD = d + ` L ${w},${h} L 0,${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      {area && (
        <path d={areaD} fill={color} fillOpacity="0.12" stroke="none" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

function TypePill({ type }: { type: string }) {
  const map: Record<string, { label: string; color: string }> = {
    wireless_ap: { label: 'AP',  color: 'var(--info)' },
    switch:      { label: 'SW',  color: 'var(--accent)' },
    router:      { label: 'RTR', color: 'var(--violet)' },
  };
  const { label, color } = map[type] ?? { label: type.slice(0, 3).toUpperCase(), color: 'var(--ink-3)' };
  return (
    <span
      className="mono text-[10.5px] font-medium px-[6px] py-[2px] rounded-full"
      style={{ color, border: '1px solid var(--line)' }}
    >
      {label}
    </span>
  );
}

// ─── Device Locations Map ─────────────────────────────────────────────────────

function DeviceLocationsMap({ devices }: { devices: Device[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapped = useMemo(() =>
    devices.filter(d => d.location_lat != null && d.location_lng != null &&
      !isNaN(Number(d.location_lat)) && !isNaN(Number(d.location_lng))),
    [devices]
  );

  useEffect(() => {
    if (!containerRef.current || mapped.length === 0) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const groups = new Map<string, Device[]>();
    for (const d of mapped) {
      const key = `${Number(d.location_lat).toFixed(6)},${Number(d.location_lng).toFixed(6)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }

    const markers: L.Layer[] = [];
    groups.forEach((groupDevices) => {
      const lat = Number(groupDevices[0].location_lat);
      const lng = Number(groupDevices[0].location_lng);
      const count = groupDevices.length;
      const hasOffline = groupDevices.some(d => d.status === 'offline');
      const color = hasOffline ? 'var(--bad)' : 'var(--accent)';
      const colorHex = hasOffline ? '#f08a8a' : '#c1f17e';

      const deviceRows = groupDevices.map(d => {
        const c = d.status === 'online' ? '#8de08a' : '#f08a8a';
        return `<b>${d.name}</b>&nbsp;<span style="color:${c};font-size:11px">● ${d.status}</span>`;
      }).join('<br/>');
      const address = groupDevices[0].location_address
        ? `<br/><span style="color:#8a877e;font-size:11px">${groupDevices[0].location_address}</span>`
        : '';
      const tooltipHtml = groupDevices.map(d =>
        `${d.status === 'online' ? '●' : '○'} ${d.name}`
      ).join('<br/>');

      let marker: L.Layer;
      if (count === 1) {
        marker = L.circleMarker([lat, lng], {
          radius: 9, color: '#fff', weight: 2, fillColor: colorHex, fillOpacity: 0.9,
        }).bindPopup(deviceRows + address).bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -10] });
      } else {
        const size = count > 9 ? 32 : 28, half = size / 2;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${colorHex};color:#0e0f12;border:2px solid #fff;border-radius:50%;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 0 0 4px ${colorHex}33,0 0 12px ${colorHex}88;cursor:pointer">${count}</div>`,
          iconSize: [size, size], iconAnchor: [half, half], popupAnchor: [0, -half],
        });
        marker = L.marker([lat, lng], { icon })
          .bindPopup(deviceRows + address).bindTooltip(tooltipHtml, { direction: 'top' });
      }
      marker.addTo(map);
      markers.push(marker);
    });

    if (markers.length === 1) {
      map.setView([Number(mapped[0].location_lat), Number(mapped[0].location_lng)], 13);
    } else {
      map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [40, 40] });
    }
    return () => { map.remove(); };
  }, [mapped]);

  if (mapped.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm" style={{ height: 220, color: 'var(--ink-4)' }}>
        No device locations configured — add addresses via Device › Overview › Physical Details
      </div>
    );
  }
  return <div ref={containerRef} style={{ height: 220, width: '100%', borderRadius: 8 }} />;
}

// ─── Health Bar ───────────────────────────────────────────────────────────────

function HealthBar({
  summary, devices, wirelessCount, clientSparkline,
}: {
  summary: { devices: { total: number; online: number; offline: number }; clients: { active: number; total: number }; alerts: { critical: number; warning: number } } | undefined;
  devices: Device[];
  wirelessCount: number;
  clientSparkline: number[];
}) {
  const allOnline = (summary?.devices.offline ?? 0) === 0 && (summary?.devices.total ?? 0) > 0;
  const reachFraction = summary?.devices.total
    ? (summary.devices.online / summary.devices.total)
    : 1;

  return (
    <div className="card" style={{ padding: '18px 22px' }}>
      <div className="flex flex-wrap items-center gap-7">
        {/* Status block */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div
            className="w-9 h-9 rounded-[8px] flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-soft)' }}
          >
            <StatusDot
              color={allOnline ? 'var(--accent)' : 'var(--warn)'}
              glow size={10}
            />
          </div>
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
              {allOnline ? 'All systems nominal' : `${summary?.devices.offline ?? 0} device(s) unreachable`}
            </div>
            <div className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
              {summary?.devices.online ?? 0} of {summary?.devices.total ?? 0} reachable
              {(summary?.alerts.critical ?? 0) > 0 && ` · ${summary!.alerts.critical} critical alert`}
            </div>
          </div>
        </div>

        {/* Reachability bar */}
        <div className="flex-1 min-w-[120px]" style={{ paddingLeft: 20, borderLeft: '1px solid var(--line)' }}>
          <div className="flex justify-between text-[11px] mb-[6px]" style={{ color: 'var(--ink-3)' }}>
            <span>Reachability</span>
            <span className="mono">{summary?.devices.online ?? 0}/{summary?.devices.total ?? 0} online</span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 8, background: 'var(--surface-3)' }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${reachFraction * 100}%`,
                background: reachFraction === 1 ? 'var(--accent)' : reachFraction > 0.5 ? 'var(--warn)' : 'var(--bad)',
              }}
            />
          </div>
        </div>

        {/* Mini-stats */}
        {[
          {
            label: 'Active clients',
            value: String(summary?.clients.active ?? '—'),
            spark: clientSparkline,
            color: 'var(--accent)',
          },
          {
            label: 'Wireless',
            value: String(wirelessCount ?? '—'),
            spark: [] as number[],
            color: 'var(--info)',
          },
          {
            label: 'Alerts 24h',
            value: (summary?.alerts.critical ?? 0) > 0
              ? `${summary!.alerts.critical} critical`
              : (summary?.alerts.warning ?? 0) > 0
              ? `${summary!.alerts.warning} warn`
              : 'none',
            spark: [] as number[],
            color: (summary?.alerts.critical ?? 0) > 0 ? 'var(--bad)' : 'var(--ink-3)',
          },
        ].map(({ label, value, spark, color }) => (
          <div key={label} style={{ minWidth: 110, paddingLeft: 20, borderLeft: '1px solid var(--line)' }}>
            <div className="text-[11px] mb-[2px]" style={{ color: 'var(--ink-3)' }}>{label}</div>
            <div className="text-[18px] font-semibold num-tab mb-[4px]" style={{ color: 'var(--ink)' }}>{value}</div>
            {spark.length >= 2 && <Sparkline data={spark} w={100} h={18} color={color} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Summary View ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SummaryView(props: Record<string, any>) {
  const { summary, devices, wirelessCount, clientSparkline, clientsOverTime,
    chartRange, setChartRange, topClients, recentEvents, severities, toggleSeverity, navigate } = props;
  const formatBytes = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const deviceTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of devices as Device[]) {
      const t = d.device_type || 'other';
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }, [devices]);

  const typeConfig: Record<string, { label: string; color: string }> = {
    switch:      { label: 'Switches',    color: 'var(--accent)' },
    wireless_ap: { label: 'Wireless APs', color: 'var(--info)' },
    router:      { label: 'Routers',     color: 'var(--violet)' },
  };

  const chartDomain: [number, number] = (() => {
    const ranges: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
    const hrs = ranges[chartRange] ?? 24;
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    return [now - hrs * 60 * 60 * 1000, now];
  })();

  return (
    <div className="space-y-4">
      <HealthBar
        summary={summary}
        devices={devices}
        wirelessCount={wirelessCount}
        clientSparkline={clientSparkline}
      />

      {/* Main grid: clients chart + devices list */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        {/* Clients chart */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Connected clients</div>
              <div className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>last {chartRange} · 5min buckets</div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[22px] font-semibold num-tab" style={{ color: 'var(--ink)' }}>
                {summary?.clients.active ?? '—'}
              </span>
              <div className="flex gap-1">
                {(['1h', '6h', '24h', '7d'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      setChartRange(r);
                      localStorage.setItem('dashboard:chart-range', r);
                    }}
                    className="mono text-[11px] px-[8px] py-[3px] rounded-[5px] transition-colors"
                    style={{
                      background: chartRange === r ? 'var(--surface-3)' : 'transparent',
                      color: chartRange === r ? 'var(--ink)' : 'var(--ink-3)',
                      border: '1px solid var(--line)',
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {clientsOverTime.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={clientsOverTime} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line-soft)" />
                <XAxis
                  dataKey="ts" type="number" scale="time" domain={chartDomain}
                  tick={{ fontSize: 10, fill: 'var(--ink-4)', fontFamily: 'Geist Mono' }}
                  tickCount={7}
                  tickFormatter={(t) => format(new Date(t), 'HH:mm')}
                />
                <YAxis tick={{ fontSize: 10, fill: 'var(--ink-4)' }} allowDecimals={false} />
                <Tooltip
                  formatter={(v: number) => [v, 'Clients']}
                  labelFormatter={(t) => format(new Date(t as number), 'MMM d, HH:mm')}
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--ink)',
                  }}
                />
                <Line
                  type="monotone" dataKey="value"
                  stroke="var(--accent)" strokeWidth={1.8}
                  dot={false} activeDot={{ r: 4, fill: 'var(--accent)' }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center text-[13px]" style={{ height: 180, color: 'var(--ink-4)' }}>
              No data yet — metrics appear after devices are polled
            </div>
          )}
        </div>

        {/* Compact devices list */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Devices</div>
            <button
              onClick={() => navigate('/devices')}
              className="text-[11px] transition-colors"
              style={{ color: 'var(--ink-3)' }}
            >
              Manage →
            </button>
          </div>
          <div className="space-y-[1px]">
            {(devices as Device[]).map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-[10px] px-[6px] py-[7px] rounded-[5px] cursor-pointer transition-colors"
                style={{ color: 'var(--ink)' }}
                onClick={() => navigate(`/devices/${d.id}`)}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <StatusDot
                  color={d.status === 'online' ? 'var(--good)' : d.status === 'offline' ? 'var(--bad)' : 'var(--ink-4)'}
                  glow={d.status === 'online'}
                  size={6}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">{d.name}</div>
                  <div className="mono text-[10.5px] truncate" style={{ color: 'var(--ink-3)' }}>{d.model}</div>
                </div>
                <div className="mono text-[11px] flex items-center gap-1" style={{ color: d.firmware_update_available ? 'var(--warn)' : 'var(--ink-3)' }}>
                  {d.firmware_update_available && <span>↑</span>}
                  {d.ros_version}
                </div>
                <TypePill type={d.device_type} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Second row: Mix + Top talkers + Activity */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1.2fr 1fr' }}>
        {/* Device mix */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>Mix</div>
          <div className="space-y-[10px]">
            {Object.entries(typeConfig).map(([type, { label, color }]) => {
              const count = deviceTypeCounts[type] ?? 0;
              const frac = (devices as Device[]).length ? count / (devices as Device[]).length : 0;
              return (
                <div key={type}>
                  <div className="flex justify-between text-[12px] mb-[5px]">
                    <span style={{ color: 'var(--ink-2)' }}>{label}</span>
                    <span className="mono num-tab" style={{ color: 'var(--ink-3)' }}>{count}</span>
                  </div>
                  <div className="rounded-full overflow-hidden" style={{ height: 4, background: 'var(--surface-3)' }}>
                    <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top talkers */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Top talkers</div>
            <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>by bytes · 1h</span>
          </div>
          {(topClients as { mac_address: string; hostname?: string; total_bytes: number }[]).length > 0 ? (
            <div className="space-y-[1px]">
              {(topClients as { mac_address: string; hostname?: string; total_bytes: number }[]).slice(0, 5).map((c, i) => {
                const maxB = (topClients as { total_bytes: number }[])[0]?.total_bytes ?? 1;
                const label = c.hostname || c.mac_address;
                return (
                  <div key={c.mac_address} className="grid items-center gap-[10px]" style={{ gridTemplateColumns: '16px 1fr 70px', padding: '5px 0' }}>
                    <span className="mono text-[10px] num-tab text-right" style={{ color: 'var(--ink-4)' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div className="mono text-[11.5px] truncate mb-[3px]" style={{ color: 'var(--ink)' }}>
                        {label.length > 20 ? label.slice(0, 20) + '…' : label}
                      </div>
                      <div className="rounded-full overflow-hidden" style={{ height: 3, background: 'var(--surface-3)' }}>
                        <div className="h-full rounded-full" style={{ width: `${(c.total_bytes / maxB) * 100}%`, background: 'var(--accent)' }} />
                      </div>
                    </div>
                    <span className="mono num-tab text-right text-[11px]" style={{ color: 'var(--ink-2)' }}>
                      {formatBytes(c.total_bytes)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-center text-[12px]" style={{ height: 80, color: 'var(--ink-4)' }}>
              No active clients
            </div>
          )}
        </div>

        {/* Activity */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Activity</div>
            <div className="flex items-center gap-2">
              {(['error', 'warning', 'info'] as const).map((sev) => (
                <label key={sev} className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={severities.has(sev)}
                    onChange={() => toggleSeverity(sev)}
                    className="w-3 h-3 rounded cursor-pointer"
                  />
                  <span className="text-[10px]" style={{
                    color: sev === 'error' ? 'var(--bad)' : sev === 'warning' ? 'var(--warn)' : 'var(--info)',
                  }}>
                    {sev[0].toUpperCase()}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            {((recentEvents?.events ?? []) as DeviceEvent[]).length > 0 ? (
              ((recentEvents?.events ?? []) as DeviceEvent[]).map((ev, i) => (
                <div
                  key={ev.id}
                  className="grid gap-[10px] py-[5px]"
                  style={{
                    gridTemplateColumns: '60px 1fr',
                    fontSize: 11.5,
                    borderTop: i ? '1px solid var(--line-soft)' : 'none',
                  }}
                >
                  <div className="mono" style={{ color: 'var(--ink-4)' }}>
                    {format(new Date(ev.event_time), 'HH:mm:ss')}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-[6px] mb-[2px]">
                      <StatusDot
                        color={ev.severity === 'error' || ev.severity === 'critical' ? 'var(--bad)' : ev.severity === 'warning' ? 'var(--warn)' : 'var(--ink-3)'}
                        size={5}
                      />
                      <span className="mono text-[10.5px] truncate" style={{ color: 'var(--ink-2)' }}>
                        {ev.device_name}
                      </span>
                    </div>
                    <span className="truncate block" style={{ color: 'var(--ink-2)' }}>{ev.message}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-center text-[12px]" style={{ height: 80, color: 'var(--ink-4)' }}>
                No recent events
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Locations map */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          className="flex items-center justify-between px-[18px] py-[14px]"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Locations</span>
          </div>
          <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
            {(devices as Device[]).filter(d => d.location_lat != null).length} of {(devices as Device[]).length} mapped
          </span>
        </div>
        <div style={{ padding: '0 0' }}>
          <DeviceLocationsMap devices={devices as Device[]} />
        </div>
      </div>
    </div>
  );
}

// ─── Operations View ──────────────────────────────────────────────────────────

function OperationsView({
  summary, devices, navigate,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}) {
  const allOnline = (summary?.devices.offline ?? 0) === 0 && (summary?.devices.total ?? 0) > 0;
  const statusText = allOnline ? "Everything's running." : `${summary?.devices.offline} device${summary?.devices.offline !== 1 ? 's' : ''} unreachable.`;
  const statusColor = allOnline ? 'var(--accent)' : 'var(--warn)';

  const thingsToHandle = useMemo(() => {
    const items: { sev: 'error' | 'warn' | 'info'; title: string; body: string; action: string; path: string }[] = [];

    for (const d of devices as Device[]) {
      if (d.status === 'offline') {
        items.push({
          sev: 'error',
          title: `${d.name} is unreachable`,
          body: `Last seen ${d.last_seen ? formatDistanceToNow(new Date(d.last_seen), { addSuffix: true }) : 'never'}.`,
          action: 'View device',
          path: `/devices/${d.id}`,
        });
      }
    }
    for (const d of devices as Device[]) {
      if (d.firmware_update_available) {
        items.push({
          sev: 'warn',
          title: `RouterOS update available for ${d.name}`,
          body: `Running ${d.ros_version}${d.latest_ros_version ? `, ${d.latest_ros_version} available` : ''}.`,
          action: 'Review update',
          path: `/devices/${d.id}?tab=config`,
        });
      }
      if (d.routerboard_upgrade_available) {
        items.push({
          sev: 'info',
          title: `RouterBOOT upgrade available for ${d.name}`,
          body: `Firmware ${d.firmware_version}${d.upgrade_firmware_version ? ` → ${d.upgrade_firmware_version}` : ''}.`,
          action: 'Review upgrade',
          path: `/devices/${d.id}?tab=config`,
        });
      }
    }
    return items;
  }, [devices]);

  const quickActions = [
    { label: 'Run discovery',  sub: 'Scan ARP / CDP / MNDP', icon: Wifi,      path: '/devices', color: 'var(--accent)' },
    { label: 'Backup all',     sub: `${(devices as Device[]).length} devices`,  icon: HardDrive,  path: '/backups',  color: 'var(--info)' },
    { label: 'Open terminal',  sub: 'Pick a device',          icon: Terminal,   path: '/devices', color: 'var(--violet)' },
    { label: 'Sync config',    sub: 'Pull latest /export',    icon: RefreshCw,  path: '/devices', color: 'var(--ink-2)' },
    { label: 'Tail events',    sub: 'Live syslog stream',      icon: Activity,   path: '/events',  color: 'var(--ink-2)' },
    { label: 'Open topology',  sub: 'Visualize links',         icon: GitBranch,  path: '/topology',color: 'var(--ink-2)' },
  ];

  const sevColor = (s: string) => s === 'error' ? 'var(--bad)' : s === 'warn' ? 'var(--warn)' : 'var(--info)';

  return (
    <div className="space-y-4">
      {/* Hero status card */}
      <div className="card relative overflow-hidden" style={{ padding: '32px 36px' }}>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle at 95% 0%, rgba(193,241,126,0.06), transparent 60%)' }}
        />
        <div className="relative flex flex-wrap items-center gap-8">
          <div className="flex items-center gap-5">
            <div
              className="w-16 h-16 rounded-[14px] flex items-center justify-center flex-shrink-0"
              style={{ background: 'radial-gradient(circle, rgba(193,241,126,0.2), transparent)' }}
            >
              <StatusDot color={statusColor} glow size={20} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.1em] mb-[6px]" style={{ color: 'var(--ink-3)' }}>Network status</div>
              <div className="text-[32px] font-semibold leading-none" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
                {statusText}
              </div>
              <div className="text-[13px] mt-[6px]" style={{ color: 'var(--ink-3)' }}>
                {summary?.devices.online ?? 0} of {summary?.devices.total ?? 0} devices reachable
                {(summary?.alerts.warning ?? 0) > 0 && ` · ${summary!.alerts.warning} warning${summary!.alerts.warning !== 1 ? 's' : ''}`}
              </div>
            </div>
          </div>
          <div className="ml-auto flex gap-6">
            {[
              { label: 'CLIENTS', value: String(summary?.clients.active ?? '—'), color: 'var(--accent)' },
              { label: 'DEVICES', value: `${summary?.devices.online ?? '—'}/${summary?.devices.total ?? '—'}`, color: 'var(--info)' },
              { label: 'ALERTS', value: String((summary?.alerts.critical ?? 0) + (summary?.alerts.warning ?? 0)), color: (summary?.alerts.critical ?? 0) > 0 ? 'var(--bad)' : 'var(--ink-3)' },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div className="text-[10px] tracking-[0.1em] mb-1" style={{ color: 'var(--ink-4)' }}>{label}</div>
                <div className="text-[22px] font-semibold num-tab" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Things to handle + Quick actions */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
        {/* Things to handle */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div
            className="flex items-center gap-[10px] px-5 py-[14px]"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            <div
              className="w-[18px] h-[18px] rounded-[4px] flex items-center justify-center text-[12px] font-bold flex-shrink-0"
              style={{ background: 'var(--warn)', color: 'var(--accent-fg)' }}
            >!
            </div>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Things to handle</span>
            <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
              {thingsToHandle.length} item{thingsToHandle.length !== 1 ? 's' : ''}
            </span>
          </div>
          {thingsToHandle.length > 0 ? thingsToHandle.map((item, i) => (
            <div
              key={i}
              className="grid items-start gap-[14px] px-5 py-[14px]"
              style={{
                gridTemplateColumns: '3px 1fr auto',
                borderBottom: i < thingsToHandle.length - 1 ? '1px solid var(--line-soft)' : 'none',
              }}
            >
              <div className="self-stretch rounded-full" style={{ background: sevColor(item.sev), width: 3 }} />
              <div>
                <div className="text-[13.5px] font-medium mb-[3px]" style={{ color: 'var(--ink)' }}>{item.title}</div>
                <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>{item.body}</div>
              </div>
              <button
                onClick={() => navigate(item.path)}
                className="text-[11.5px] rounded-[5px] px-3 py-[6px] flex-shrink-0 transition-colors"
                style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--ink-2)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {item.action} →
              </button>
            </div>
          )) : (
            <div className="flex items-center justify-center gap-2 py-8" style={{ color: 'var(--ink-3)' }}>
              <StatusDot color="var(--good)" glow size={8} />
              <span className="text-[13px]">Nothing needs attention</span>
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="card" style={{ padding: '18px 20px' }}>
          <div className="text-[13px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>Quick actions</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {quickActions.map(({ label, sub, icon: Icon, path, color }) => (
              <button
                key={label}
                onClick={() => navigate(path)}
                className="text-left rounded-[6px] px-[14px] py-[12px] transition-colors"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
              >
                <div className="flex items-center gap-2 mb-[3px]">
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} />
                  <span className="text-[12.5px] font-semibold" style={{ color }}>{label}</span>
                </div>
                <div className="text-[11px]" style={{ color: 'var(--ink-3)' }}>{sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Fleet strip */}
      <div className="card" style={{ padding: '18px 20px' }}>
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Fleet</div>
          <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
            {(devices as Device[]).length} device{(devices as Device[]).length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min((devices as Device[]).length, 5)}, 1fr)` }}>
          {(devices as Device[]).map((d) => {
            const hasAlert = d.firmware_update_available || d.routerboard_upgrade_available;
            return (
              <button
                key={d.id}
                onClick={() => navigate(`/devices/${d.id}`)}
                className="text-left rounded-[8px] p-[14px] transition-colors"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
              >
                <div className="flex items-center gap-2 mb-[10px]">
                  <StatusDot
                    color={d.status === 'online' ? 'var(--good)' : d.status === 'offline' ? 'var(--bad)' : 'var(--warn)'}
                    glow size={6}
                  />
                  <span className="mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
                    {d.device_type === 'wireless_ap' ? 'AP' : d.device_type === 'router' ? 'RTR' : 'SW'}
                  </span>
                  {hasAlert && (
                    <span
                      className="ml-auto text-[10px] font-bold px-[5px] py-[1px] rounded-full"
                      style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}
                    >!</span>
                  )}
                </div>
                <div className="text-[13px] font-semibold truncate mb-[3px]" style={{ color: 'var(--ink)' }}>{d.name}</div>
                <div className="mono text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{d.ros_version}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const ALL_SEVERITIES = ['error', 'warning', 'info'] as const;
const SEVERITY_KEY = 'dashboard:severities';

function loadSeverities(): Set<string> {
  try {
    const saved = localStorage.getItem(SEVERITY_KEY);
    if (saved) return new Set(JSON.parse(saved));
  } catch { /* ignore */ }
  return new Set(ALL_SEVERITIES);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dashView, setDashView] = useState<'summary' | 'operations'>(() =>
    (localStorage.getItem('dashboard:view') as 'summary' | 'operations') ?? 'summary'
  );
  const [chartRange, setChartRange] = useState<string>(() =>
    localStorage.getItem('dashboard:chart-range') ?? '24h'
  );
  const [severities, setSeverities] = useState<Set<string>>(loadSeverities);
  const [dismissedFirmwareIds, setDismissedFirmwareIds] = useState<number[]>([]);

  const toggleSeverity = (s: string) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      localStorage.setItem(SEVERITY_KEY, JSON.stringify([...next]));
      return next;
    });

  const { data: summary } = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => metricsApi.summary().then(r => r.data),
    refetchInterval: 30_000,
  });

  const { data: clientsOverTimeRaw = [] } = useQuery({
    queryKey: ['clients-over-time', chartRange],
    queryFn: () => metricsApi.clientsOverTime(chartRange).then(r => r.data),
    refetchInterval: 60_000,
  });
  const clientsOverTime = clientsOverTimeRaw.map(p => ({ ...p, ts: new Date(p.time).getTime() }));

  const { data: topClients = [] } = useQuery({
    queryKey: ['top-clients'],
    queryFn: () => metricsApi.topClients(8).then(r => r.data),
    refetchInterval: 60_000,
  });

  const { data: wirelessClientsData } = useQuery({
    queryKey: ['wireless-clients-active'],
    queryFn: () => clientsApi.list({ active: true, client_type: 'wireless', limit: 1 }).then(r => r.data),
    refetchInterval: 30_000,
  });

  const severityParam =
    severities.size === 0 || severities.size === ALL_SEVERITIES.length
      ? undefined
      : [...severities].join(',');

  const { data: recentEvents } = useQuery({
    queryKey: ['events-recent', severityParam],
    queryFn: () => eventsApi.list({ limit: 5, severity: severityParam }).then(r => r.data),
    refetchInterval: 30_000,
  });

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    refetchInterval: 30_000,
  });

  useSocket({
    'device:updated': () => {
      queryClient.invalidateQueries({ queryKey: ['metrics-summary'] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    'clients:updated': () => {
      queryClient.invalidateQueries({ queryKey: ['top-clients'] });
      queryClient.invalidateQueries({ queryKey: ['metrics-summary'] });
      queryClient.invalidateQueries({ queryKey: ['wireless-clients-active'] });
    },
    'events:updated': () => queryClient.invalidateQueries({ queryKey: ['events-recent'] }),
    'device:status': () => queryClient.invalidateQueries({ queryKey: ['metrics-summary'] }),
  });

  const devicesWithRosUpdates = devices.filter(
    d => d.firmware_update_available && !dismissedFirmwareIds.includes(d.id)
  );
  const devicesWithRbUpgrades = devices.filter(
    d => d.routerboard_upgrade_available && !dismissedFirmwareIds.includes(d.id)
  );
  const showUpdateBanner = devicesWithRosUpdates.length > 0 || devicesWithRbUpgrades.length > 0;

  // Extract client count sparkline from time-series
  const clientSparkline = useMemo(() => {
    if (clientsOverTime.length < 2) return [];
    const recent = clientsOverTime.slice(-24);
    return recent.map(p => p.value);
  }, [clientsOverTime]);

  const wirelessCount = wirelessClientsData?.total ?? 0;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="text-[28px] font-semibold leading-none" style={{ color: 'var(--ink)', letterSpacing: '-0.01em' }}>
          Dashboard
        </h1>
        <span className="mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </span>
        <div className="ml-auto flex gap-1">
          {(['summary', 'operations'] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setDashView(v);
                localStorage.setItem('dashboard:view', v);
              }}
              className="text-[12px] font-medium px-3 py-[5px] rounded-[6px] transition-colors capitalize"
              style={{
                background: dashView === v ? 'var(--surface-3)' : 'transparent',
                color: dashView === v ? 'var(--ink)' : 'var(--ink-3)',
                border: '1px solid var(--line)',
              }}
            >
              {v === 'summary' ? 'Summary' : 'Operations'}
            </button>
          ))}
        </div>
      </div>

      {/* Update banner */}
      {showUpdateBanner && (
        <div
          className="rounded-[8px] px-4 py-3 flex items-start gap-3"
          style={{
            background: 'var(--warn-bg)',
            border: '1px solid var(--warn)',
          }}
        >
          <ArrowUpCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warn)' }} />
          <div className="flex-1 text-[13px] space-y-1" style={{ color: 'var(--ink-2)' }}>
            <span className="font-semibold" style={{ color: 'var(--warn)' }}>Updates available</span>
            {devicesWithRosUpdates.length > 0 && (
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="font-medium flex items-center gap-1">
                  <ArrowUpCircle className="w-3 h-3" />
                  RouterOS ({devicesWithRosUpdates.length}):
                </span>
                {devicesWithRosUpdates.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 && <span style={{ color: 'var(--ink-3)' }}> · </span>}
                    <button
                      onClick={() => navigate(`/devices/${d.id}?tab=config`)}
                      className="underline underline-offset-2"
                    >
                      {d.name}
                      {d.latest_ros_version && <span className="opacity-70"> ({d.latest_ros_version})</span>}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {devicesWithRbUpgrades.length > 0 && (
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="font-medium flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  RouterBOOT ({devicesWithRbUpgrades.length}):
                </span>
                {devicesWithRbUpgrades.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 && <span style={{ color: 'var(--ink-3)' }}> · </span>}
                    <button
                      onClick={() => navigate(`/devices/${d.id}?tab=config`)}
                      className="underline underline-offset-2"
                    >
                      {d.name}
                      {d.upgrade_firmware_version && <span className="opacity-70"> ({d.upgrade_firmware_version})</span>}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setDismissedFirmwareIds(ids => [
              ...ids,
              ...devicesWithRosUpdates.map(d => d.id),
              ...devicesWithRbUpgrades.map(d => d.id),
            ])}
            className="p-0.5 rounded flex-shrink-0"
            style={{ color: 'var(--warn)' }}
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* View content */}
      {dashView === 'summary' ? (
        <SummaryView
          summary={summary}
          devices={devices}
          wirelessCount={wirelessCount}
          clientSparkline={clientSparkline}
          clientsOverTime={clientsOverTime}
          chartRange={chartRange}
          setChartRange={setChartRange}
          topClients={topClients}
          recentEvents={recentEvents}
          severities={severities}
          toggleSeverity={toggleSeverity}
          navigate={navigate}
        />
      ) : (
        <OperationsView
          summary={summary}
          devices={devices}
          navigate={navigate}
        />
      )}
    </div>
  );
}

