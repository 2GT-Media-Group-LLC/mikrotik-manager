import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Route, AlertTriangle, ArrowRight, Wifi } from 'lucide-react';
import clsx from 'clsx';
import { clientsApi, type RoamSession } from '../../services/api';
import { rssiColor } from '../../utils/wifiChannels';

const RANGES = ['1h', '24h', '7d', '30d'] as const;

function duration(sec: number | null): string {
  if (sec == null) return 'ongoing';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  return `${h}h ${Math.round((sec % 3600) / 60)}m`;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

function Signal({ dbm }: { dbm: number | null }) {
  if (dbm == null) return <span className="text-gray-400">—</span>;
  return <span className="mono num-tab" style={{ color: rssiColor(dbm) }}>{dbm} dBm</span>;
}

function Session({ s }: { s: RoamSession }) {
  const [open, setOpen] = useState(false);
  // Roams per hour is only computed for sessions long enough to have a rate.
  const flapping = (s.roamsPerHour ?? 0) >= 6;

  return (
    <div className={clsx(
      'rounded-lg border p-3',
      flapping ? 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10'
               : 'border-gray-200 dark:border-slate-700'
    )}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-gray-400">{day(s.startedAt)}</span>
          <span className="mono text-gray-700 dark:text-slate-200">{time(s.startedAt)}</span>
          <span className="text-gray-400">→</span>
          <span className="mono text-gray-700 dark:text-slate-200">
            {s.endedAt ? time(s.endedAt) : 'now'}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">
            {duration(s.durationSec)}
          </span>
          {s.ssid && <span className="text-gray-500 dark:text-slate-400">{s.ssid}</span>}
          {s.hops.length > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
              {s.hops.length} roam{s.hops.length !== 1 ? 's' : ''}
            </span>
          )}
          {flapping && (
            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
              <AlertTriangle className="w-3 h-3" />
              {s.roamsPerHour}/hr
            </span>
          )}
          <span className="ml-auto text-gray-400">
            {s.disconnectReason ?? (s.endedAt ? '' : 'connected')}
          </span>
        </div>

        {/* The path is the answer to "where was this client?" */}
        <div className="flex items-center gap-1 flex-wrap mt-2 text-[11px]">
          {s.path.map((iface, i) => (
            <span key={`${iface}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ArrowRight className="w-3 h-3 text-gray-300 dark:text-slate-600" />}
              <span className="mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300">
                {iface}
              </span>
            </span>
          ))}
          {s.signalMin != null && (
            <span className="ml-2 text-gray-400">
              signal <Signal dbm={s.signalMax} /> … <Signal dbm={s.signalMin} />
            </span>
          )}
        </div>
      </button>

      {open && s.events.length > 0 && (
        <div className="mt-3 pt-2 border-t border-gray-100 dark:border-slate-700 space-y-1">
          {s.events.map((e, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className="mono text-gray-400 w-16 flex-shrink-0">{time(e.at)}</span>
              <span className={clsx('w-20 flex-shrink-0 font-medium',
                e.kind === 'disconnected' ? 'text-red-600 dark:text-red-400'
                  : e.kind === 'roamed' ? 'text-blue-600 dark:text-blue-400'
                    : e.kind === 'connected' ? 'text-green-600 dark:text-green-400'
                      : 'text-gray-500')}>
                {e.kind}
              </span>
              <span className="text-gray-600 dark:text-slate-300 flex-1 min-w-0 truncate">
                {e.kind === 'roamed'
                  ? `${e.interfaceName} → ${e.toInterface}`
                  : e.kind.startsWith('dhcp')
                    ? `${e.ip ?? ''}${e.hostname ? ` (${e.hostname})` : ''}`
                    : e.interfaceName ?? ''}
                {e.reason ? ` — ${e.reason}` : ''}
              </span>
              <Signal dbm={e.signal} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A client's wireless history, reconstructed from access point logs.
 *
 * Roaming happens between polls, so a poll-based view can never show it — the log
 * is the only record that a client moved, when, and at what signal. That makes this
 * the one place "why does this device keep dropping?" can actually be answered.
 */
export default function RoamingTimeline({ mac }: { mac: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const { data, isLoading } = useQuery({
    queryKey: ['roaming', mac, range],
    queryFn: () => clientsApi.getRoaming(mac, range).then(r => r.data),
  });

  const sessions = data?.sessions ?? [];

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Route className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Roaming &amp; sessions</h3>
        <div className="ml-auto flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={clsx('px-2 py-1 text-[11px] font-medium transition-colors',
                range === r ? 'bg-blue-600 text-white'
                            : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700')}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-xs text-gray-400">Reading access point logs…</div>
      ) : sessions.length === 0 ? (
        <div className="py-6 text-center text-xs text-gray-400">
          No wireless sessions logged in this window. Association logging must be enabled
          on the access point for this to populate.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4 flex-wrap text-[11px] text-gray-500 dark:text-slate-400">
            <span>{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
            <span>{data!.totalRoams} roam{data!.totalRoams !== 1 ? 's' : ''}</span>
            {data!.radios.length > 0 && (
              <span className="flex items-center gap-1">
                <Wifi className="w-3 h-3" />
                {data!.radios.slice(0, 4).map(r => r.name).join(', ')}
              </span>
            )}
          </div>

          {data!.flappingSessions > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {data!.flappingSessions} session{data!.flappingSessions !== 1 ? 's' : ''} where this
                client kept moving between radios rather than settling. That usually points at
                roaming thresholds rather than the client — overlapping cells at similar signal give
                it no reason to prefer one.
              </p>
            </div>
          )}

          <div className="space-y-2 max-h-[28rem] overflow-y-auto">
            {sessions.slice(0, 60).map((s, i) => <Session key={`${s.startedAt}-${i}`} s={s} />)}
          </div>
          {sessions.length > 60 && (
            <p className="text-[11px] text-gray-400">
              Showing the 60 most recent of {sessions.length} sessions.
            </p>
          )}
        </>
      )}
    </div>
  );
}
