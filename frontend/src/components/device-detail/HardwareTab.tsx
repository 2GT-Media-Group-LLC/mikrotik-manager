import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { useState } from 'react';
import { useRememberedRange } from '../../hooks/useRememberedRange';
import { useQuery } from '@tanstack/react-query';
import { Thermometer, Zap, Wind, Power, Activity, HelpCircle, RefreshCw, HardDrive } from 'lucide-react';
import { devicesApi, metricsApi } from '../../services/api';
import type { ResourcePoint } from '../../types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import clsx from 'clsx';

interface HealthMetric {
  name: string;
  value: string;
  unit: string;
}

// RouterOS health comes in two formats depending on version:
//   New (v7+): [{name:'temperature', value:'42', type:'C'}, ...]
//   Old (v6):  [{'cpu-temperature':'42', voltage:'23.9', ...}]
function normalize(raw: Record<string, string>[]): HealthMetric[] {
  if (!raw.length) return [];

  if ('name' in raw[0]) {
    return raw.map((r) => ({
      name: r['name'] || '',
      value: r['value'] || '',
      unit: r['type'] || '',
    }));
  }

  const obj = raw[0];
  return Object.entries(obj)
    .filter(([k]) => !k.startsWith('.'))
    .map(([name, value]) => ({ name, value, unit: inferUnit(name, value) }));
}

function inferUnit(name: string, value: string): string {
  const n = name.toLowerCase();
  if (n.includes('temperature')) return 'C';
  if (n.includes('voltage')) return 'V';
  if (n.includes('current')) return 'A';
  if (n.includes('power') && /^\d/.test(value)) return 'W';
  if (n.includes('fan') && /^\d+$/.test(value)) return 'RPM';
  return '';
}

function formatName(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bPsu\b/g, 'PSU')
    .replace(/\bNtp\b/g, 'NTP');
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

// Parse sizes in either raw-bytes ("134217728") or human-readable ("7.5GiB", "128MiB") form
function parseBytes(val: string): number {
  if (!val) return 0;
  const n = parseFloat(val);
  if (isNaN(n)) return 0;
  const unit = val.replace(/[\d.\s]/g, '').toUpperCase();
  const map: Record<string, number> = {
    '': 1, B: 1,
    KB: 1e3, KIB: 1024,
    MB: 1e6, MIB: 1024 ** 2,
    GB: 1e9, GIB: 1024 ** 3,
    TB: 1e12, TIB: 1024 ** 4,
  };
  return n * (map[unit] ?? 1);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function diskUsageColor(pct: number): string {
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}

// ─── Category helpers ─────────────────────────────────────────────────────────

function isTemperature(m: HealthMetric) {
  return m.unit === 'C' || m.name.toLowerCase().includes('temperature');
}
function isVoltage(m: HealthMetric) {
  return m.unit === 'V' || m.name.toLowerCase().includes('voltage');
}
function isFan(m: HealthMetric) {
  return m.unit === 'RPM' || m.name.toLowerCase().includes('fan');
}
function isPsu(m: HealthMetric) {
  const n = m.name.toLowerCase();
  return n.includes('psu') || n.includes('power-supply');
}
function isPower(m: HealthMetric) {
  return m.unit === 'W' || (m.name.toLowerCase().includes('power') && !isPsu(m));
}
function isCurrent(m: HealthMetric) {
  return m.unit === 'A' || m.name.toLowerCase().includes('current');
}

// ─── Color helpers ─────────────────────────────────────────────────────────────

function tempColor(celsius: number): string {
  if (celsius >= 70) return 'text-red-500 dark:text-red-400';
  if (celsius >= 50) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-green-500 dark:text-green-400';
}

function fanColor(rpm: number): string {
  return rpm === 0 ? 'text-red-500 dark:text-red-400' : 'text-green-500 dark:text-green-400';
}

function psuColor(state: string): string {
  const s = state.toLowerCase();
  if (s === 'ok' || s === 'good') return 'text-green-500 dark:text-green-400';
  return 'text-red-500 dark:text-red-400';
}

// ─── Card components ──────────────────────────────────────────────────────────

function Section({ title, icon, children, grid = true }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  grid?: boolean;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-blue-500">{icon}</span>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      </div>
      {grid ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{children}</div>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </div>
  );
}

function MetricCard({ label, value, unit, valueClass }: {
  label: string;
  value: string;
  unit?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
      <div className="text-xs text-gray-500 dark:text-slate-400 mb-1">{label}</div>
      <div className={clsx('text-lg font-bold', valueClass || 'text-gray-900 dark:text-white')}>
        {value}
        {unit && <span className="text-xs font-normal text-gray-500 dark:text-slate-400 ml-1">{unit}</span>}
      </div>
    </div>
  );
}

function DiskCard({ disk }: { disk: Record<string, string> }) {
  const totalBytes = parseBytes(disk['total'] || '0');
  const freeBytes = parseBytes(disk['free'] || '0');
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const pct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const label = disk['label'] || formatName(disk['name'] || 'Disk');
  const type = disk['type'] || '';
  const model = disk['model'] || '';
  const serial = disk['serial'] || '';
  const fs = disk['filesystem'] || disk['fs'] || '';
  const slot = disk['slot'] || '';

  return (
    <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-medium text-sm text-gray-900 dark:text-white">{label}</div>
          <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 space-x-2">
            {type && <span className="uppercase">{type}</span>}
            {slot && <span>· {slot}</span>}
            {fs && <span>· {fs}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold text-gray-900 dark:text-white">{pct}%</div>
          <div className="text-xs text-gray-500 dark:text-slate-400">used</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-gray-200 dark:bg-slate-600 rounded-full mb-2">
        <div
          className={clsx('h-full rounded-full transition-all', diskUsageColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-gray-500 dark:text-slate-400">
        <span>{formatBytes(usedBytes)} used</span>
        <span>{formatBytes(freeBytes)} free / {formatBytes(totalBytes)}</span>
      </div>

      {(model || serial) && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-slate-600 text-xs text-gray-400 dark:text-slate-500 space-y-0.5">
          {model && <div>Model: {model}</div>}
          {serial && <div>S/N: {serial}</div>}
        </div>
      )}
    </div>
  );
}

function toDisplayTemp(celsius: number, unit: 'C' | 'F'): string {
  if (unit === 'F') return String(Math.round(celsius * 9 / 5 + 32));
  return String(celsius % 1 === 0 ? celsius : celsius.toFixed(1));
}

// ─── Main Component ───────────────────────────────────────────────────────────

const RESOURCE_RANGES = ['6h', '12h', '24h', '7d'] as const;

function ResourceChart({ deviceId }: { deviceId: number }) {
  const { formatTime } = useDateTimeFormat();
  const [range, setRange] = useRememberedRange<string>('hardware', '24h');

  const { data: rawResources = [] } = useQuery({
    queryKey: ['resources-history', deviceId, range],
    queryFn: () => metricsApi.deviceResources(deviceId, range).then((r) => r.data as ResourcePoint[]),
    refetchInterval: 60_000,
  });

  const compact = range === '6h' || range === '12h' || range === '24h';
  const resourceData = rawResources.map((p) => {
    const memPct =
      p.memory_total && p.memory_total > 0
        ? Math.round(((p.memory_used || 0) / p.memory_total) * 100)
        : 0;
    return {
      time: formatTime(new Date(p.time), {
        hour: '2-digit', minute: '2-digit',
        ...(compact ? {} : { month: 'short', day: 'numeric' }),
      }),
      cpu: Math.round(p.cpu_load || 0),
      mem: memPct,
    };
  });

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">CPU & Memory Usage</h3>
        </div>
        <div className="flex gap-1">
          {RESOURCE_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={clsx(
                'px-2 py-1 text-xs rounded font-medium transition-colors',
                range === r
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {resourceData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
          No resource history available yet — data accumulates over time
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={resourceData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} />
            <Tooltip
              formatter={(v) => `${v}%`}
              contentStyle={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="cpu" stroke="#f59e0b" name="CPU Load" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="mem" stroke="#8b5cf6" name="Memory Used" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export default function HardwareTab({ deviceId }: { deviceId: number }) {
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>(() =>
    (localStorage.getItem('hw-temp-unit') as 'C' | 'F') || 'C'
  );

  const setAndPersistUnit = (unit: 'C' | 'F') => {
    setTempUnit(unit);
    localStorage.setItem('hw-temp-unit', unit);
  };

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['device-hardware', deviceId],
    queryFn: () => devicesApi.getHardware(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: poeData } = useQuery({
    queryKey: ['device-poe', deviceId],
    queryFn: () => metricsApi.devicePoe(deviceId).then((r) => r.data),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card p-8 text-center text-gray-500 dark:text-slate-400">
        Failed to load hardware data.
      </div>
    );
  }

  const metrics = normalize(data?.health || []);
  const disks = data?.disks || [];

  const temperatures = metrics.filter(isTemperature);
  const voltages = metrics.filter(isVoltage);
  const fans = metrics.filter(isFan);
  const psus = metrics.filter(isPsu);
  const power = metrics.filter(isPower);
  const current = metrics.filter(isCurrent);
  const other = metrics.filter(
    (m) => !isTemperature(m) && !isVoltage(m) && !isFan(m) && !isPsu(m) && !isPower(m) && !isCurrent(m)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-3">
        {/* Temperature unit toggle */}
        <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-slate-600 text-xs font-medium">
          {(['C', 'F'] as const).map((unit) => (
            <button
              key={unit}
              onClick={() => setAndPersistUnit(unit)}
              className={clsx(
                'px-2.5 py-1 transition-colors',
                tempUnit === unit
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700'
              )}
            >
              °{unit}
            </button>
          ))}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* CPU & Memory chart — full width at top */}
      <ResourceChart deviceId={deviceId} />

      {/* Sensor & disk sections in a 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {disks.length > 0 && (
          <div className="lg:col-span-2">
            <Section title="Storage" icon={<HardDrive className="w-4 h-4" />} grid={false}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {disks.map((d, i) => <DiskCard key={d['name'] || i} disk={d} />)}
              </div>
            </Section>
          </div>
        )}

        {temperatures.length > 0 && (
          <Section title="Temperature" icon={<Thermometer className="w-4 h-4" />}>
            {temperatures.map((m) => {
              const c = parseFloat(m.value);
              return (
                <MetricCard
                  key={m.name}
                  label={formatName(m.name)}
                  value={isNaN(c) ? m.value : toDisplayTemp(c, tempUnit)}
                  unit={`°${tempUnit}`}
                  valueClass={isNaN(c) ? undefined : tempColor(c)}
                />
              );
            })}
          </Section>
        )}

        {fans.length > 0 && (
          <Section title="Fans" icon={<Wind className="w-4 h-4" />}>
            {fans.map((m) => {
              const rpm = parseInt(m.value, 10);
              return (
                <MetricCard
                  key={m.name}
                  label={formatName(m.name)}
                  value={isNaN(rpm) ? m.value : rpm.toLocaleString()}
                  unit={isNaN(rpm) ? undefined : 'RPM'}
                  valueClass={isNaN(rpm) ? undefined : fanColor(rpm)}
                />
              );
            })}
          </Section>
        )}

        {psus.length > 0 && (
          <Section title="Power Supply" icon={<Power className="w-4 h-4" />}>
            {psus.map((m) => (
              <MetricCard
                key={m.name}
                label={formatName(m.name)}
                value={m.value.toUpperCase()}
                valueClass={psuColor(m.value)}
              />
            ))}
          </Section>
        )}

        {voltages.length > 0 && (
          <Section title="Voltage" icon={<Zap className="w-4 h-4" />}>
            {voltages.map((m) => (
              <MetricCard key={m.name} label={formatName(m.name)} value={m.value} unit="V" />
            ))}
          </Section>
        )}

        {(power.length > 0 || current.length > 0) && (
          <Section title="Power Consumption" icon={<Activity className="w-4 h-4" />}>
            {power.map((m) => (
              <MetricCard key={m.name} label={formatName(m.name)} value={m.value} unit="W" />
            ))}
            {current.map((m) => (
              <MetricCard key={m.name} label={formatName(m.name)} value={m.value} unit="A" />
            ))}
          </Section>
        )}

        {other.length > 0 && (
          <Section title="Other" icon={<HelpCircle className="w-4 h-4" />}>
            {other.map((m) => (
              <MetricCard
                key={m.name}
                label={formatName(m.name)}
                value={m.value}
                unit={m.unit || undefined}
              />
            ))}
          </Section>
        )}

        {poeData && poeData.ports.length > 0 && (
          <div className="lg:col-span-2">
            <Section title={`PoE Budget — ${poeData.totalWatts.toFixed(1)} W total`} icon={<Zap className="w-4 h-4" />} grid={false}>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {poeData.ports.filter(p => p.watts > 0).map((p) => (
                  <div key={p.port} className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                    <div className="text-xs font-mono text-gray-500 dark:text-slate-400 mb-1">{p.port}</div>
                    <div className="text-lg font-bold text-yellow-500">{p.watts.toFixed(1)} W</div>
                    <div className="text-xs text-gray-400 dark:text-slate-500">
                      {p.voltage_v.toFixed(1)} V · {p.current_ma.toFixed(0)} mA
                    </div>
                  </div>
                ))}
                {poeData.ports.filter(p => p.watts === 0).length > 0 && (
                  <div className="rounded-lg p-3 opacity-40" style={{ background: 'var(--surface-2)' }}>
                    <div className="text-xs text-gray-500 dark:text-slate-400">
                      {poeData.ports.filter(p => p.watts === 0).length} port(s) inactive
                    </div>
                  </div>
                )}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
