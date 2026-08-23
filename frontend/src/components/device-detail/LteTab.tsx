import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Signal, RadioTower, ArrowLeftRight, RotateCcw, Radio, ArrowUpFromLine } from 'lucide-react';
import { lteApi, type LteInterface, type LteHistoryEvent } from '../../services/api';

interface Props {
  deviceId: number;
}

const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;

type Quality = NonNullable<LteInterface['quality']>;

const QUALITY_STYLE: Record<Quality, string> = {
  excellent: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  good:      'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  fair:      'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  poor:      'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  unknown:   'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-slate-300',
};

/**
 * What the grade means, in words.
 *
 * A raw figure like −97 dBm tells most people nothing, and taken alone it
 * actively misleads: the field capture this was built against showed −97 dBm on
 * a link running 256QAM at maximum reported channel quality. SINR drives the
 * grade for that reason, with RSRP able to pull it down but not define it.
 */
const QUALITY_TEXT: Record<Quality, string> = {
  excellent: 'The modem is operating near its ceiling.',
  good: 'Full throughput expected under normal load.',
  fair: 'Usable, but expect degradation at peak hours.',
  poor: 'Throughput and stability are likely affected.',
  unknown: 'The modem does not report enough detail to judge quality.',
};

function formatUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(iso: string, compact: boolean): string {
  const d = new Date(iso);
  return compact
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Metric({ label, value, unit, hint }: {
  label: string; value: number | string | null; unit?: string; hint?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
      <div className="text-xs text-gray-500 dark:text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-gray-900 dark:text-white tabular-nums">
        {value == null || value === '' ? '—' : value}
        {value != null && value !== '' && unit
          ? <span className="text-xs font-normal text-gray-500 dark:text-slate-400 ml-1">{unit}</span>
          : null}
      </div>
      {hint && <div className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

/** Primary carrier plus every aggregated one, which is the shape of the link. */
function BandChips({ iface }: { iface: LteInterface }) {
  const carriers = [
    ...(iface.primary_band ? [{ ...iface.primary_band, primary: true }] : []),
    ...iface.ca_bands.map(b => ({ ...b, primary: false })),
  ];

  if (carriers.length === 0) {
    return <span className="text-sm text-gray-500 dark:text-slate-400">No band reported</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {carriers.map((c, i) => (
        <div
          key={`${c.band}-${c.earfcn ?? i}`}
          className={`rounded-lg border px-3 py-1.5 ${
            c.primary
              ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/30'
              : 'border-gray-200 bg-gray-50 dark:border-slate-700 dark:bg-slate-800'
          }`}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">B{c.band}</span>
            {c.bandwidthMhz != null && (
              <span className="text-xs text-gray-600 dark:text-slate-300">{c.bandwidthMhz} MHz</span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 dark:text-slate-400">
            {c.primary ? 'Primary' : 'Aggregated'}
            {c.earfcn != null && ` · EARFCN ${c.earfcn}`}
          </div>
        </div>
      ))}
    </div>
  );
}

const EVENT_ICON = {
  'handover': ArrowLeftRight,
  'session-reset': RotateCcw,
  'band-change': Radio,
} as const;

const EVENT_LABEL = {
  'handover': 'Handover',
  'session-reset': 'Session restarted',
  'band-change': 'Bands changed',
} as const;

function HistoryList({ events }: { events: LteHistoryEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-slate-400">
        No tower or band changes recorded in this window — a stable link looks exactly like this.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {events.map((e, i) => {
        const Icon = EVENT_ICON[e.kind] ?? Radio;
        return (
          <li key={i} className="flex gap-3 text-sm">
            <Icon className="w-4 h-4 mt-0.5 shrink-0 text-gray-400 dark:text-slate-500" />
            <div className="min-w-0">
              <span className="font-medium text-gray-900 dark:text-white">
                {EVENT_LABEL[e.kind] ?? e.kind}
              </span>
              <span className="text-gray-500 dark:text-slate-400"> · {formatTime(e.at, false)}</span>
              {e.detail && (
                <div className="text-gray-600 dark:text-slate-300 break-words">{e.detail}</div>
              )}
              {(e.rsrp != null || e.sinr != null) && (
                <div className="text-[11px] text-gray-400 dark:text-slate-500">
                  {e.rsrp != null && `RSRP ${e.rsrp} dBm`}
                  {e.rsrp != null && e.sinr != null && ' · '}
                  {e.sinr != null && `SINR ${e.sinr} dB`}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function LteTab({ deviceId }: Props) {
  const [range, setRange] = useState<string>('6h');

  const { data: state, isLoading } = useQuery({
    queryKey: ['lte', deviceId],
    queryFn: () => lteApi.state(deviceId).then(r => r.data),
    refetchInterval: 30_000,
  });

  const { data: metrics } = useQuery({
    queryKey: ['lte-metrics', deviceId, range],
    queryFn: () => lteApi.metrics(deviceId, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const { data: history } = useQuery({
    queryKey: ['lte-history', deviceId, range],
    queryFn: () => lteApi.history(deviceId, range === '1h' || range === '6h' ? '24h' : range)
      .then(r => r.data),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <div className="text-sm text-gray-500 dark:text-slate-400">Loading cellular state…</div>;
  }

  const interfaces = state?.interfaces ?? [];
  if (interfaces.length === 0) {
    return (
      <div className="text-sm text-gray-500 dark:text-slate-400">
        No cellular data yet. It appears after the next poll of an LTE interface.
      </div>
    );
  }

  const compact = range === '1h' || range === '6h';
  const chartData = (metrics?.metrics ?? []).map(p => ({
    time: formatTime(p.time, compact),
    rsrp: p.rsrp, sinr: p.sinr, rsrq: p.rsrq, rssi: p.rssi,
  }));

  return (
    <div className="space-y-6">
      {interfaces.map(iface => {
        const quality = (iface.quality ?? 'unknown') as Quality;
        const connected = iface.status === 'running' || iface.status === 'connected';
        const carriers = iface.ca_bands.length + (iface.primary_band ? 1 : 0);
        const uptime = iface.session_uptime_s == null ? null : Number(iface.session_uptime_s);

        return (
          <div
            key={iface.interface_name}
            className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4 space-y-4"
          >
            {/* Header: what the link is doing, in words before numbers */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <Signal className="w-5 h-5 mt-1 text-gray-400 dark:text-slate-500" />
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-gray-900 dark:text-white">
                      {iface.interface_name}
                    </h3>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${QUALITY_STYLE[quality]}`}>
                      {connected ? quality : 'not connected'}
                    </span>
                    {carriers > 1 && (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                        {carriers}× carrier aggregation
                        {iface.total_bandwidth_mhz > 0 && ` · ${iface.total_bandwidth_mhz} MHz`}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-slate-300 mt-0.5">
                    {connected ? QUALITY_TEXT[quality] : 'The modem is not attached to a network.'}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    {[iface.operator, iface.data_class, iface.modem_model]
                      .filter(Boolean).join(' · ') || 'Modem details not reported'}
                  </p>
                </div>
              </div>
              <div className="text-right text-xs text-gray-500 dark:text-slate-400">
                <div>Session up {formatUptime(uptime)}</div>
                <div>Updated {formatTime(iface.updated_at, true)}</div>
              </div>
            </div>

            {/* Signal figures. Each shows only what the modem actually reported. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Metric label="RSRP" value={iface.rsrp} unit="dBm" hint="Signal power" />
              <Metric label="SINR" value={iface.sinr} unit="dB" hint="Signal vs noise" />
              <Metric label="RSRQ" value={iface.rsrq} unit="dB" hint="Signal quality" />
              <Metric label="RSSI" value={iface.rssi} unit="dBm" hint="Wideband power" />
              <Metric label="CQI" value={iface.cqi} hint="Reported 0–15" />
              <Metric
                label="Streams"
                value={iface.rank_indicator}
                hint={iface.dl_modulation ? `${iface.dl_modulation.toUpperCase()} downlink` : 'MIMO rank'}
              />
            </div>

            {/* Bands */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <RadioTower className="w-4 h-4 text-gray-400 dark:text-slate-500" />
                <h4 className="text-sm font-medium text-gray-900 dark:text-white">Carriers in use</h4>
              </div>
              <BandChips iface={iface} />

              {iface.uplink_anchor && (
                <div className="mt-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700/60 dark:bg-amber-900/20">
                  <ArrowUpFromLine className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="text-xs">
                    <div className="font-medium text-amber-900 dark:text-amber-200">
                      Upload is limited by the primary carrier
                    </div>
                    <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                      The uplink runs on B{iface.uplink_anchor.primaryBand} alone at{' '}
                      {iface.uplink_anchor.primaryMhz} MHz, while B{iface.uplink_anchor.widestBand} is
                      being aggregated at {iface.uplink_anchor.widestMhz} MHz for download. Left on
                      automatic, a modem anchors to whichever band it hears loudest rather than the
                      widest one — excluding the narrow bands moves the anchor and raises upload.
                    </p>
                  </div>
                </div>
              )}

              <div className="mt-3 grid sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-gray-500 dark:text-slate-400">Allowed by configuration: </span>
                  <span className="text-gray-900 dark:text-white font-medium">
                    {iface.allowed_bands.length > 0
                      ? iface.allowed_bands.map(b => `B${b}`).join(', ')
                      : 'Any (modem chooses)'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-slate-400">Seen serving this device: </span>
                  <span className="text-gray-900 dark:text-white font-medium">
                    {iface.observed_bands.length > 0
                      ? iface.observed_bands.map(o => `B${o.band}`).join(', ')
                      : 'Nothing recorded yet'}
                  </span>
                </div>
              </div>
              {iface.observed_bands.length > 0 && (
                <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                  Observed bands accumulate from polling. They are the evidence a future band
                  lock will be checked against — scanning costs service to run and comes back
                  empty where a site has only one base station, so history is the safer source.
                </p>
              )}
            </div>

            {/* Cell */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Metric label="Cell ID" value={iface.cell_id} />
              <Metric label="eNB" value={iface.enb_id} />
              <Metric label="Sector" value={iface.sector_id} />
              <Metric label="PCI" value={iface.phy_cell_id} />
            </div>
          </div>
        );
      })}

      {/* Signal over time */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h3 className="font-semibold text-gray-900 dark:text-white">Signal over time</h3>
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                  range === r
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {chartData.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">
            No samples in this window yet.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-slate-700" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={24} />
              {/* dBm and dB share a chart but not a scale. */}
              <YAxis yAxisId="dbm" tick={{ fontSize: 11 }} width={44}
                     label={{ value: 'dBm', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <YAxis yAxisId="db" orientation="right" tick={{ fontSize: 11 }} width={40}
                     label={{ value: 'dB', angle: 90, position: 'insideRight', fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line yAxisId="dbm" type="monotone" dataKey="rsrp" name="RSRP (dBm)"
                    stroke="#3b82f6" dot={false} strokeWidth={2} connectNulls />
              <Line yAxisId="dbm" type="monotone" dataKey="rssi" name="RSSI (dBm)"
                    stroke="#94a3b8" dot={false} strokeWidth={1} connectNulls />
              <Line yAxisId="db" type="monotone" dataKey="sinr" name="SINR (dB)"
                    stroke="#10b981" dot={false} strokeWidth={2} connectNulls />
              <Line yAxisId="db" type="monotone" dataKey="rsrq" name="RSRQ (dB)"
                    stroke="#f59e0b" dot={false} strokeWidth={1} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Movement */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Tower and band changes</h3>
        <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
          Reconstructed by comparing consecutive polls — a session uptime that runs backwards
          means the modem re-registered, and a changed cell means it handed over.
        </p>
        <HistoryList events={history?.events ?? []} />
      </div>
    </div>
  );
}
