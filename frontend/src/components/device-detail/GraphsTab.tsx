import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { metricsApi, devicesApi } from '../../services/api';
import type { Interface, TrafficPoint, ResourcePoint } from '../../types';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { chartTooltip } from '../common/chartTooltip';

interface Props {
  deviceId: number;
}

function formatBps(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(2)} GB/s`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)} MB/s`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(val)} B/s`;
}

function formatTime(iso: string, compact: boolean): string {
  const d = new Date(iso);
  if (compact) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const TRAFFIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const;
const RESOURCE_RANGES = ['6h', '12h', '24h', '7d'] as const;

function RangeButtons({
  ranges,
  value,
  onChange,
}: {
  ranges: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
            value === r
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export default function GraphsTab({ deviceId }: Props) {
  const [trafficIface, setTrafficIface] = useState('');
  const [trafficRange, setTrafficRange] = useState<string>('1h');
  const [resourceRange, setResourceRange] = useState<string>('24h');

  const { data: interfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data as Interface[]),
  });

  const { data: rawTraffic = [] } = useQuery({
    queryKey: ['traffic', deviceId, trafficIface, trafficRange],
    queryFn: () =>
      metricsApi.interfaceTraffic(deviceId, trafficIface, trafficRange).then((r) => r.data),
    enabled: !!trafficIface,
    refetchInterval: 60_000,
  });

  const { data: rawResources = [] } = useQuery({
    queryKey: ['resources-history', deviceId, resourceRange],
    queryFn: () =>
      metricsApi.deviceResources(deviceId, resourceRange).then((r) => r.data as ResourcePoint[]),
    refetchInterval: 60_000,
  });

  const compact = trafficRange === '1h' || trafficRange === '3h';
  const resourceCompact = resourceRange === '6h' || resourceRange === '12h' || resourceRange === '24h';

  const trafficData = (rawTraffic as TrafficPoint[]).map((p) => ({
    time: formatTime(p.time, compact),
    rx: Math.round(p.rx),
    tx: Math.round(p.tx),
  }));

  const resourceData = (rawResources as ResourcePoint[]).map((p) => {
    const memPct =
      p.memory_total && p.memory_total > 0
        ? Math.round(((p.memory_used || 0) / p.memory_total) * 100)
        : 0;
    return {
      time: formatTime(p.time, resourceCompact),
      cpu: Math.round(p.cpu_load || 0),
      mem: memPct,
    };
  });

  return (
    <div className="space-y-6">
      {/* ── Interface Traffic ── */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white">Interface Traffic</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input py-1.5 text-sm"
              value={trafficIface}
              onChange={(e) => setTrafficIface(e.target.value)}
            >
              <option value="">Select interface...</option>
              {(interfaces as Interface[])
                .filter((i) => !i.disabled)
                .map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                    {i.speed ? ` (${i.speed})` : ''}
                  </option>
                ))}
            </select>
            <RangeButtons ranges={TRAFFIC_RANGES} value={trafficRange} onChange={setTrafficRange} />
          </div>
        </div>

        {!trafficIface ? (
          <div className="h-48 flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
            Select an interface to view traffic history
          </div>
        ) : trafficData.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
            No traffic data yet for this interface in the selected range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trafficData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-slate-600" opacity={0.5} />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatBps} tick={{ fontSize: 10 }} width={72} />
              <Tooltip {...chartTooltip} formatter={(v) => formatBps(v as number)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="rx" stroke="#3b82f6" name="RX (download)" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="tx" stroke="#10b981" name="TX (upload)" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── CPU & Memory ── */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white">CPU & Memory Usage</h3>
          <RangeButtons ranges={RESOURCE_RANGES} value={resourceRange} onChange={setResourceRange} />
        </div>

        {resourceData.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
            No resource history available yet — data accumulates over time
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={resourceData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-slate-600" opacity={0.5} />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} />
              <Tooltip {...chartTooltip} formatter={(v) => `${v}%`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="cpu" stroke="#f59e0b" name="CPU Load" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="mem" stroke="#8b5cf6" name="Memory Used" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
