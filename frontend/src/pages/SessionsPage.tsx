import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowRightLeft, RefreshCw, Search } from 'lucide-react';
import clsx from 'clsx';

import { devicesApi, sessionsApi } from '../services/api';
import type { NetflowSession, SessionEndReason } from '../services/api';
import DevicePicker from '../components/common/DevicePicker';
import { useDateTimeFormat } from '../hooks/useDateTimeFormat';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { formatBytes } from '../utils/firewallSummary';

const PAGE_SIZE = 100;

const RANGES: Record<string, { label: string; ms: number }> = {
  '1h': { label: 'Last hour', ms: 3_600_000 },
  '24h': { label: 'Last 24 hours', ms: 86_400_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 86_400_000 },
};

const PROTOCOL_NAMES: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6' };

export const REASONS: Record<SessionEndReason, { label: string; title: string; cls: string }> = {
  fin: { label: 'Closed', title: 'TCP FIN: the connection closed normally', cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  'reset-client': { label: 'Reset by client', title: 'TCP RST from the client', cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
  'reset-server': { label: 'Reset by server', title: 'TCP RST from the server', cls: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400' },
  'no-reply': { label: 'No reply', title: 'Traffic one way only: nothing came back (or it is broadcast)', cls: 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300' },
  'aged-out': { label: 'Aged out', title: 'Went quiet without a close: idle timeout, or a long connection still open', cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' },
};

/** TCP flags as letters, the way tcpdump and most firewalls write them. */
export function tcpFlags(f: number | null): string {
  if (f == null) return '';
  return [[0x02, 'S'], [0x10, 'A'], [0x08, 'P'], [0x01, 'F'], [0x04, 'R'], [0x20, 'U']]
    .filter(([bit]) => f & (bit as number)).map(([, l]) => l).join('') || '·';
}

function hostPort(addr: string, port: number | null, protocol: number): string {
  if (port == null || protocol === 1 || protocol === 58) return addr;
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export default function SessionsPage() {
  const { formatDateTime } = useDateTimeFormat();
  const [urlParams] = useSearchParams();
  const [address, setAddress] = useState(() => urlParams.get('address') ?? '');
  const [port, setPort] = useState(() => urlParams.get('port') ?? '');
  const [deviceId, setDeviceId] = useState(() => (/^\d+$/.test(urlParams.get('device') ?? '') ? urlParams.get('device')! : ''));
  const [protocol, setProtocol] = useState('');
  const [reason, setReason] = useState('');
  const [range, setRange] = useState('24h');
  const [page, setPage] = useState(0);
  const debouncedAddress = useDebouncedValue(address.trim());
  const debouncedPort = useDebouncedValue(port.trim());

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
  });

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['sessions', { debouncedAddress, debouncedPort, deviceId, protocol, reason, range, page }],
    queryFn: () => sessionsApi.list({
      since: new Date(Date.now() - RANGES[range].ms).toISOString(),
      address: debouncedAddress || undefined,
      port: debouncedPort || undefined,
      deviceId: deviceId ? Number(deviceId) : undefined,
      protocol: protocol || undefined,
      reason: reason || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalLabel = `${total.toLocaleString()}${data?.totalCapped ? '+' : ''}`;
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const errorText = (error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">
            Sessions
            {total > 0 && <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">({totalLabel})</span>}
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            One row per connection from NetFlow, both directions together. Turned on per device on the{' '}
            <Link to="/network-services/netflow" className="text-blue-600 dark:text-blue-400 hover:underline">NetFlow</Link> page.
          </p>
        </div>
        <button onClick={() => void refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 self-start sm:self-auto">
          <RefreshCw className={clsx('w-4 h-4', isFetching && 'animate-spin')} />Refresh
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full sm:flex-1 sm:min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" className="input pl-9" placeholder="Address (client, server, or NAT)"
            value={address} onChange={(e) => reset(setAddress)(e.target.value)} aria-label="Address" />
        </div>
        <input type="text" inputMode="numeric" className="input w-full sm:w-28" placeholder="Port"
          value={port} onChange={(e) => reset(setPort)(e.target.value.replace(/\D/g, '').slice(0, 5))} aria-label="Port" />
        <select className="input w-full sm:w-36" value={protocol} onChange={(e) => reset(setProtocol)(e.target.value)} aria-label="Protocol">
          <option value="">All protocols</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="icmp">ICMP</option>
          <option value="icmpv6">ICMPv6</option>
          <option value="gre">GRE</option>
          <option value="esp">ESP</option>
        </select>
        <select className="input w-full sm:w-40" value={reason} onChange={(e) => reset(setReason)(e.target.value)} aria-label="How it ended">
          <option value="">Any ending</option>
          {(Object.keys(REASONS) as SessionEndReason[]).map((r) => <option key={r} value={r}>{REASONS[r].label}</option>)}
        </select>
        <select className="input w-full sm:w-40" value={range} onChange={(e) => reset(setRange)(e.target.value)} aria-label="Time range">
          {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <DevicePicker className="w-full sm:w-56" emptyLabel="All devices" devices={devices} aria-label="Device"
          value={deviceId ? Number(deviceId) : null}
          onChange={(id) => reset(setDeviceId)(id == null ? '' : String(id))} />
      </div>

      {errorText && <div className="text-sm text-red-600 dark:text-red-400">{errorText}</div>}

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading...</div>
      ) : sessions.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <ArrowRightLeft className="w-12 h-12 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">No sessions found</p>
          <p className="text-xs text-gray-400 dark:text-slate-500 max-w-md">
            Sessions are recorded for devices that export NetFlow with the session log turned on, under{' '}
            <Link to="/network-services/netflow" className="text-blue-600 dark:text-blue-400 hover:underline">Network Services → NetFlow</Link>.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">Ended</th>
                  <th className="table-header px-4 py-2.5 text-left">Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Client</th>
                  <th className="table-header px-4 py-2.5 text-left">Server</th>
                  <th className="table-header px-4 py-2.5 text-left">Proto</th>
                  <th className="table-header px-4 py-2.5 text-left">App</th>
                  <th className="table-header px-4 py-2.5 text-right">Duration</th>
                  <th className="table-header px-4 py-2.5 text-right" title="Client to server">Sent</th>
                  <th className="table-header px-4 py-2.5 text-right" title="Server to client">Received</th>
                  <th className="table-header px-4 py-2.5 text-left">Ended how</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {sessions.map((s) => <SessionRow key={s.id} s={s} formatDateTime={formatDateTime}
                  onAddress={(a) => { setAddress(a); setPage(0); }} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-slate-400">
            Showing {(page * PAGE_SIZE + 1).toLocaleString()}–{(page * PAGE_SIZE + sessions.length).toLocaleString()} of {totalLabel}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="btn-secondary py-1 text-xs">← Previous</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total && !data?.totalCapped}
              className="btn-secondary py-1 text-xs">Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, formatDateTime, onAddress }: {
  s: NetflowSession;
  formatDateTime: ReturnType<typeof useDateTimeFormat>['formatDateTime'];
  onAddress: (a: string) => void;
}) {
  const reason = REASONS[s.end_reason] ?? REASONS['aged-out'];
  const tcp = s.protocol === 6;
  const addr = (a: string, p: number | null) => (
    <button onClick={() => onAddress(a)} title="Show this address's sessions" className="hover:text-blue-600 dark:hover:text-blue-400">
      {hostPort(a, p, s.protocol)}
    </button>
  );
  return (
    <tr>
      <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap"
        title={`Started ${formatDateTime(s.started_at)}`}>{formatDateTime(s.ended_at)}</td>
      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
        {s.device_name ?? (s.exporter ? <span title="Router not identified">{s.exporter}</span> : '—')}
      </td>
      <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
        {addr(s.client_addr, s.client_port)}
        {s.client_name && s.client_mac && (
          <Link to={`/clients/${encodeURIComponent(s.client_mac)}`} className="block font-sans text-[11px] text-blue-600 dark:text-blue-400 hover:underline">{s.client_name}</Link>
        )}
        {s.client_nat_addr && (
          <div className="text-[11px] text-gray-400 dark:text-slate-500" title="The client's address after NAT, as the server saw it">
            NAT {hostPort(s.client_nat_addr, s.client_nat_port, s.protocol)}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">
        {addr(s.server_addr, s.server_port)}
        {s.server_nat_addr && (
          <div className="text-[11px] text-gray-400 dark:text-slate-500" title="The address the client connected to, before a port forward">
            via {hostPort(s.server_nat_addr, s.server_nat_port, s.protocol)}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">{PROTOCOL_NAMES[s.protocol] ?? s.protocol}</td>
      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{s.app ?? '—'}</td>
      <td className="px-4 py-2.5 text-xs text-right text-gray-500 dark:text-slate-400 whitespace-nowrap">
        {duration(new Date(s.ended_at).getTime() - new Date(s.started_at).getTime())}
      </td>
      <td className="px-4 py-2.5 text-xs text-right text-gray-700 dark:text-slate-300 whitespace-nowrap" title={`${s.packets_out.toLocaleString()} packets`}>
        {formatBytes(s.bytes_out)}
      </td>
      <td className="px-4 py-2.5 text-xs text-right text-gray-700 dark:text-slate-300 whitespace-nowrap" title={`${s.packets_in.toLocaleString()} packets`}>
        {formatBytes(s.bytes_in)}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className={clsx('px-1.5 py-0.5 rounded text-[11px] font-medium', reason.cls)}
          title={tcp ? `${reason.title}. Flags: client ${tcpFlags(s.flags_out)}, server ${tcpFlags(s.flags_in) || 'none'}` : reason.title}>
          {reason.label}
        </span>
      </td>
    </tr>
  );
}
