import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { proxyApi } from '../services/api';

type By = 'client' | 'user' | 'destination' | 'denied';

const TABS: { id: By; label: string; peers: string }[] = [
  { id: 'client', label: 'Clients', peers: 'sites' },
  { id: 'user', label: 'Users', peers: 'clients' },
  { id: 'destination', label: 'Destinations', peers: 'clients' },
  { id: 'denied', label: 'Denied', peers: 'ports' },
];
const RANGES = ['1h', '24h', '7d', '30d'] as const;

const formatBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB`
    : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} B`;

export default function ProxyUsageCard() {
  const navigate = useNavigate();
  const [by, setBy] = useState<By>('client');
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const [instance, setInstance] = useState('');

  const { data: sources = [] } = useQuery({
    queryKey: ['proxy-sources'],
    queryFn: () => proxyApi.sources().then(r => r.data),
    refetchInterval: 300_000,
  });

  const [source, port] = instance ? instance.split('|') : ['', ''];
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['proxy-top', by, range, instance],
    queryFn: () => proxyApi.top({
      by, range, limit: 10,
      source: source || undefined, port: port ? Number(port) : undefined,
    }).then(r => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled: sources.length > 0,
  });

  if (sources.length === 0) return null;

  const isDenied = by === 'denied';
  const max = rows[0]?.requests ?? 1;
  const peersLabel = TABS.find(t => t.id === by)!.peers;
  const instances = Array.from(new Map(
    sources.map(s => [`${s.source}|${s.proxy_port ?? ''}`, s]),
  ).values());

  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Proxy usage</div>
        <div className="flex flex-wrap items-center gap-3">
          {instances.length > 1 && (
            <select
              value={instance}
              onChange={e => setInstance(e.target.value)}
              className="mono text-[11px] rounded"
              style={{ background: 'var(--surface-3)', color: 'var(--ink-2)', border: 'none', padding: '2px 6px' }}
            >
              <option value="">All proxies</option>
              {instances.map(s => (
                <option key={`${s.source}|${s.proxy_port}`} value={`${s.source}|${s.proxy_port ?? ''}`}>
                  {s.source}{s.proxy_port ? `:${s.proxy_port}` : ''} ({s.proxy_type})
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-1">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setBy(t.id)}
                className="text-[11px] rounded px-2 py-[2px]"
                style={{
                  background: by === t.id ? (t.id === 'denied' ? 'var(--warn)' : 'var(--accent)') : 'var(--surface-3)',
                  color: by === t.id ? '#fff' : 'var(--ink-3)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className="mono text-[11px] rounded px-2 py-[2px]"
                style={{
                  background: range === r ? 'var(--surface-3)' : 'transparent',
                  color: range === r ? 'var(--ink)' : 'var(--ink-4)',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="space-y-[1px]">
          {rows.map((r, i) => (
            <div
              key={r.key}
              className="grid items-center gap-[10px]"
              style={{ gridTemplateColumns: '16px 1fr 70px 80px 90px', padding: '5px 0', cursor: 'pointer' }}
              onClick={() => navigate(`/events?search=${encodeURIComponent(r.key)}`)}
              title={`Search events for ${r.key}`}
            >
              <span className="mono text-[10px] num-tab text-right" style={{ color: 'var(--ink-4)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                <div className="mono text-[11.5px] truncate mb-[3px]" style={{ color: 'var(--ink)' }}>{r.key}</div>
                <div className="rounded-full overflow-hidden" style={{ height: 3, background: 'var(--surface-3)' }}>
                  <div className="h-full rounded-full" style={{
                    width: `${(r.requests / max) * 100}%`,
                    background: isDenied ? 'var(--warn)' : 'var(--accent)',
                  }} />
                </div>
              </div>
              <span className="mono num-tab text-right text-[11px]" style={{ color: 'var(--ink-2)' }}>
                {r.requests.toLocaleString()} req
              </span>
              <span className="mono num-tab text-right text-[11px]" style={{ color: 'var(--ink-3)' }}>
                {isDenied ? '' : formatBytes(r.bytes_in + r.bytes_out)}
              </span>
              <span className="text-right text-[10.5px]" style={{ color: 'var(--ink-4)' }}
                title={`${r.distinct_peers} ${peersLabel}`}>
                {formatDistanceToNow(new Date(r.last_seen), { addSuffix: true })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center text-[12px]" style={{ height: 80, color: 'var(--ink-4)' }}>
          {isLoading ? 'Loading…' : 'No proxy activity in this range'}
        </div>
      )}
    </div>
  );
}
