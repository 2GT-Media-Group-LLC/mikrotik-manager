import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Radio, Signal, Activity, ShieldCheck, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { wirelessApi } from '../../services/api';
import type {
  RfChannelRow, RfSignalRow, RfTxQualityRow, RfConnectivity,
  RfOverlapKind, RfBandRange,
} from '../../types';
import {
  BAND_LABEL, RfBand,
  RSSI_ZONES, rssiColor, RETRY_BUCKETS, retryBucketIndex, retryColor,
} from '../../utils/wifiChannels';

const ALL_BANDS: RfBand[] = ['2.4', '5', '6'];

// ─── Channel Map ──────────────────────────────────────────────────────────────
//
// Drawn as real spectrum rather than a row of channel cells. Channel centres in
// 2.4 GHz are 5 MHz apart while a channel is 20 MHz wide, so a cell-per-channel
// model shows overlapping channels as free — bad advice for anyone planning a
// deployment. Occupancy and interference are computed and tested server-side
// (backend/src/utils/rfSpectrum.ts); this only positions the result.

const OVERLAP_STYLE: Record<RfOverlapKind, { fill: string; label: string }> = {
  clear:         { fill: 'var(--ok, #22c55e)',   label: 'Clear' },
  'co-channel':  { fill: 'var(--warn, #f59e0b)', label: 'Shares a channel' },
  partial:       { fill: 'var(--bad, #ef4444)',  label: 'Overlapping carriers' },
};

function SpectrumBandRow({ band, radios }: { band: RfBandRange; radios: RfChannelRow[] }) {
  const span = band.endMhz - band.startMhz;
  const pct = (mhz: number) => ((mhz - band.startMhz) / span) * 100;

  // Stack radios so overlapping blocks stay individually visible.
  const lanes: RfChannelRow[][] = [];
  for (const r of [...radios].sort((a, b) => a.low_mhz - b.low_mhz)) {
    const lane = lanes.find((l) => l[l.length - 1].high_mhz <= r.low_mhz);
    if (lane) lane.push(r); else lanes.push([r]);
  }

  // Ticks every 20 MHz in 2.4 GHz, every 100 elsewhere — enough to orient without clutter.
  const step = band.band === '2.4' ? 20 : 100;
  const ticks: number[] = [];
  for (let f = Math.ceil(band.startMhz / step) * step; f < band.endMhz; f += step) ticks.push(f);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-xs font-medium text-gray-500 dark:text-slate-400">{band.label}</div>
        <div className="text-[10px] text-gray-400">
          {radios.length === 0 ? 'no radios' : `${radios.length} radio${radios.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      <div className="relative rounded" style={{ background: 'var(--surface-3, #e5e7eb)', minHeight: lanes.length ? lanes.length * 16 + 4 : 12 }}>
        {lanes.map((lane, li) => lane.map((r) => (
          <div
            key={`${r.device_id}:${r.name}`}
            title={[
              `${r.device_name} · ${r.name}${r.ssid ? ` (${r.ssid})` : ''}`,
              `ch ${r.channel ?? '?'} — ${r.low_mhz}–${r.high_mhz} MHz, ${r.width_mhz} MHz wide`,
              `${r.registered_clients ?? 0} clients`,
              OVERLAP_STYLE[r.overlap].label,
              ...r.clashes.map((c) => `  ${c.kind === 'partial' ? 'overlaps' : 'shares with'} ${c.device_name} ch ${c.channel} (${c.overlap_mhz} MHz)`),
            ].join('\n')}
            className="absolute rounded-sm border border-black/10 dark:border-white/10"
            style={{
              left: `${pct(r.low_mhz)}%`,
              width: `${Math.max(0.6, ((r.high_mhz - r.low_mhz) / span) * 100)}%`,
              top: li * 16 + 2,
              height: 12,
              background: OVERLAP_STYLE[r.overlap].fill,
              opacity: 0.85,
            }}
          />
        )))}
      </div>

      <div className="relative h-3 mt-0.5">
        {ticks.map((f) => (
          <span key={f} className="absolute text-[9px] leading-none text-gray-400 dark:text-slate-500"
                style={{ left: `${pct(f)}%`, transform: 'translateX(-50%)' }}>
            {band.band === '2.4' ? (channelOf(f) ?? f) : f}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 2.4 GHz tick labels read better as channel numbers than as megahertz. */
function channelOf(freq: number): number | null {
  const n = Math.round((freq - 2407) / 5);
  return n >= 1 && n <= 14 ? n : null;
}

export function ChannelMap({ deviceId }: { deviceId?: number }) {
  const { data } = useQuery({
    queryKey: ['rf-channels', deviceId],
    queryFn: () => wirelessApi.getChannelUsage(deviceId).then(r => r.data),
    refetchInterval: 60_000,
  });

  const locations = data?.locations ?? [];
  const [location, setLocation] = useState<string>('all');

  const radios = (data?.radios ?? []).filter(
    r => location === 'all' || (r.controller_device_id != null ? `c:${r.controller_device_id}` : 'standalone') === location
  );
  const bands = (data?.bands ?? []).filter(b => b.band !== '6' || radios.some(r => r.low_mhz >= 5925));

  const partial = radios.filter(r => r.overlap === 'partial').length;
  const coChannel = radios.filter(r => r.overlap === 'co-channel').length;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Channel Usage</h2>
        </div>
        {/* Channel planning is per physical location — two APs on channel 6 in
            different buildings are not a conflict (issue #97). */}
        {locations.length > 1 && (
          <select value={location} onChange={(e) => setLocation(e.target.value)}
                  className="input text-xs py-1 max-w-[220px]">
            <option value="all">All locations</option>
            {locations.map(l => (
              <option key={l.key} value={l.key}>{l.name} ({l.radios})</option>
            ))}
          </select>
        )}
      </div>

      {radios.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-400">No active radios reporting a channel.</div>
      ) : (
        <>
          <div className="space-y-3">
            {bands.map(b => (
              <SpectrumBandRow key={b.band} band={b}
                radios={radios.filter(r => r.low_mhz < b.endMhz && r.high_mhz > b.startMhz)} />
            ))}
          </div>

          <div className="mt-3 flex items-center gap-4 flex-wrap text-[11px] text-gray-500 dark:text-slate-400">
            {(['clear', 'co-channel', 'partial'] as RfOverlapKind[]).map(k => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: OVERLAP_STYLE[k].fill }} />
                {OVERLAP_STYLE[k].label}
              </span>
            ))}
          </div>

          <p className="mt-2 text-[11px] text-gray-500 dark:text-slate-400">
            {partial > 0
              ? `${partial} radio${partial !== 1 ? 's' : ''} overlap the edge of a neighbour's channel — the carriers collide rather than taking turns, which costs more than sharing a channel outright.`
              : coChannel > 0
                ? `${coChannel} radio${coChannel !== 1 ? 's' : ''} share a channel exactly. They hear each other and take turns, so this is airtime cost rather than interference.`
                : 'No overlapping carriers. Radios either sit clear of each other or share a channel cleanly.'}
          </p>
        </>
      )}
    </div>
  );
}

// ─── RSSI Density ──────────────────────────────────────────────────────────────

const RSSI_MIN = -90;
const RSSI_MAX = -30;
const RSSI_TICKS = [-90, -80, -70, -60, -50, -40, -30];

export function RssiDensity({ deviceId }: { deviceId?: number }) {
  const { data: signals = [] } = useQuery({
    queryKey: ['rf-signals', deviceId],
    queryFn: () => wirelessApi.getClientSignals(deviceId).then(r => r.data),
    refetchInterval: 30_000,
  });

  const clamped = (dbm: number) => Math.max(RSSI_MIN, Math.min(RSSI_MAX, dbm));
  const pos = (dbm: number) => ((clamped(dbm) - RSSI_MIN) / (RSSI_MAX - RSSI_MIN)) * 100;

  // Bin clients into 2 dB bins so co-located clients form a sized bubble.
  const bins = new Map<number, RfSignalRow[]>();
  for (const s of signals) {
    const bin = Math.round(clamped(s.signal_strength) / 2) * 2;
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin)!.push(s);
  }

  const weak = signals.filter(s => s.signal_strength < -75).length;
  const weakRatio = signals.length ? weak / signals.length : 0;
  const needsImprovement = signals.length >= 3 && weakRatio > 0.3;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Signal className="w-4 h-4 text-emerald-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">AP Deployment Density</h2>
        <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">
          {signals.length} client{signals.length !== 1 ? 's' : ''} by signal (dBm)
        </span>
      </div>

      {signals.length === 0 ? (
        <div className="py-6 text-center text-sm text-gray-400 dark:text-slate-500">
          No connected wireless clients to plot.
        </div>
      ) : (
        <>
          {needsImprovement && (
            <div className="flex items-start gap-2 mb-3 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>AP deployment density may need improvement — {weak} of {signals.length} clients are connecting below −75 dBm, which suggests coverage gaps.</span>
            </div>
          )}

          {/* Density track */}
          <div className="relative h-16">
            {/* gradient zone background */}
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full overflow-hidden flex">
              {RSSI_ZONES.map(z => (
                <div key={z.label} style={{
                  width: `${((Math.min(z.max, RSSI_MAX) - Math.max(z.min, RSSI_MIN)) / (RSSI_MAX - RSSI_MIN)) * 100}%`,
                  backgroundColor: z.color, opacity: 0.25,
                }} />
              ))}
            </div>
            {/* client bubbles */}
            {Array.from(bins.entries()).map(([bin, rows]) => {
              const size = Math.min(34, 12 + (rows.length - 1) * 4);
              return (
                <div key={bin}
                  title={rows.map(r => `${r.custom_name || r.hostname || r.mac_address} (${r.signal_strength} dBm, ${r.device_name})`).join('\n')}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center text-[10px] font-semibold text-white shadow ring-2 ring-white dark:ring-slate-800"
                  style={{ left: `${pos(bin)}%`, width: size, height: size, backgroundColor: rssiColor(bin) }}>
                  {rows.length > 1 ? rows.length : ''}
                </div>
              );
            })}
          </div>
          {/* axis */}
          <div className="relative h-4 mt-1">
            {RSSI_TICKS.map(t => (
              <span key={t} className="absolute -translate-x-1/2 text-[10px] text-gray-400 dark:text-slate-500"
                style={{ left: `${pos(t)}%` }}>{t}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── TX Retries histogram ───────────────────────────────────────────────────────

export function TxRetries({ deviceId }: { deviceId?: number }) {
  const [band, setBand] = useState<RfBand>('5');
  const { data: radios = [] } = useQuery({
    queryKey: ['rf-tx-quality', deviceId],
    queryFn: () => wirelessApi.getTxQuality(deviceId, '6h').then(r => r.data),
    refetchInterval: 60_000,
  });

  const inBand = radios.filter((r: RfTxQualityRow) => r.band === band);
  const counts = RETRY_BUCKETS.map(() => 0);
  for (const r of inBand) counts[retryBucketIndex(r.tx_retry_pct)]++;
  // UniFi orders worst → best (35%+ … 0%)
  const ordered = RETRY_BUCKETS.map((b, i) => ({ ...b, count: counts[i] })).reverse();

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-4 h-4 text-violet-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">AP Radio TX Retries</h2>
        <div className="ml-auto flex gap-1">
          {ALL_BANDS.map(b => (
            <button key={b} onClick={() => setBand(b)}
              className={clsx('px-2 py-0.5 rounded-md text-xs font-medium transition-colors',
                band === b ? 'bg-blue-600 text-white' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700')}>
              {BAND_LABEL[b]}
            </button>
          ))}
        </div>
      </div>

      {radios.length === 0 ? (
        <div className="py-6 text-center text-sm text-gray-400 dark:text-slate-500">
          No TX-retry data. This is derived from per-client CCQ, which the legacy
          <span className="font-mono"> wireless</span> driver reports; Wi-Fi 6/7 (<span className="font-mono">wifi</span>) radios don&apos;t expose it.
        </div>
      ) : (
        <>
          <div className="flex gap-1">
            {ordered.map(b => (
              <div key={b.label} className="flex-1 text-center">
                <div className="h-9 rounded-md flex items-center justify-center text-sm font-bold text-white"
                  style={{ backgroundColor: b.count > 0 ? retryColor((b.min + Math.min(b.max, 40)) / 2) : 'var(--color-border, #e5e7eb)' }}>
                  <span className={clsx(b.count === 0 && 'text-gray-400 dark:text-slate-600')}>{b.count || ''}</span>
                </div>
                <div className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">{b.label}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-3">
            Radios bucketed by transmit-retry rate over the last 6h ({inBand.length} on {BAND_LABEL[band]}). Lower is better.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Connectivity Success funnel ────────────────────────────────────────────────

const STAGE_META: { key: keyof RfConnectivity['stages']; label: string }[] = [
  { key: 'association', label: 'Association' },
  { key: 'authentication', label: 'Authentication' },
  { key: 'dhcp', label: 'DHCP' },
];

export function ConnectivitySuccess({ deviceId }: { deviceId?: number }) {
  const [range, setRange] = useState('24h');
  const { data } = useQuery({
    queryKey: ['rf-connectivity', deviceId, range],
    queryFn: () => wirelessApi.getConnectivity(deviceId, range).then(r => r.data),
    refetchInterval: 60_000,
  });

  const stages = data?.stages;
  const totalEvents = stages
    ? STAGE_META.reduce((s, m) => s + stages[m.key].success + stages[m.key].failure, 0)
    : 0;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="w-4 h-4 text-green-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">WiFi Connectivity Success</h2>
        <div className="ml-auto flex gap-1">
          {['1h', '24h', '7d'].map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={clsx('px-2 py-0.5 rounded-md text-xs font-medium transition-colors',
                range === r ? 'bg-blue-600 text-white' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700')}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {!stages || totalEvents === 0 ? (
        <div className="py-6 text-center text-sm text-gray-400 dark:text-slate-500">
          No connectivity events in this window. This funnel is derived from device
          logs — enable wireless &amp; DHCP logging on the APs to populate it.
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {STAGE_META.map(({ key, label }) => {
              const s = stages[key];
              const pct = s.pct;
              const color = pct == null ? '#94a3b8' : pct >= 98 ? '#22c55e' : pct >= 90 ? '#84cc16' : pct >= 75 ? '#f59e0b' : '#ef4444';
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-gray-600 dark:text-slate-300">{label}</span>
                    <span className="text-gray-400 dark:text-slate-500">
                      {pct == null ? '—' : `${pct}%`}
                      <span className="ml-2 text-[10px]">({s.success} ok / {s.failure} fail)</span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct ?? 0}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-3">
            Approximate, derived from device logs. DNS success isn&apos;t observable on RouterOS and is omitted.
          </p>
        </>
      )}
    </div>
  );
}

// ─── Combined section ─────────────────────────────────────────────────────────

export default function RfHealth({ deviceId }: { deviceId?: number }) {
  // TX retries come from CCQ, which only the legacy `wireless` driver reports. On
  // an all-RouterOS-7 fleet the panel can never fill, so it is dropped and the
  // density chart takes the full width rather than sitting beside an empty box
  // (issue #96).
  const { data: caps } = useQuery({
    queryKey: ['rf-capabilities'],
    queryFn: () => wirelessApi.getRfCapabilities().then(r => r.data),
    staleTime: 300_000,
  });
  const showRetries = caps?.txRetriesAvailable ?? true;

  return (
    <div className="space-y-6">
      <ChannelMap deviceId={deviceId} />
      {showRetries ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <RssiDensity deviceId={deviceId} />
          <TxRetries deviceId={deviceId} />
        </div>
      ) : (
        <RssiDensity deviceId={deviceId} />
      )}
      <ConnectivitySuccess deviceId={deviceId} />
    </div>
  );
}
