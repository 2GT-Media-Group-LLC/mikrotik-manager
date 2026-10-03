import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search } from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import DeviceTypePill from '../components/devices/DeviceTypePill';
import TagChips from '../components/devices/TagChips';
import SortableHeader, { type SortDir } from '../components/common/SortableHeader';

interface DeviceServiceRow {
  id: number;
  name: string;
  ip_address: string;
  dhcp_v4: { total: number; enabled: number } | null;
  dhcp_v6: { total: number; enabled: number } | null;
  dns: { allow_remote: boolean; servers: string } | null;
  ntp: { server_enabled: boolean; client_enabled: boolean } | null;
  wireguard: { total: number; running: number } | null;
  syslog: { remote_count: number } | null;
  error?: string;
}

type ServiceKey = 'dhcp_v4' | 'dhcp_v6' | 'dns' | 'ntp' | 'wireguard' | 'syslog';
type SortKey = 'name' | ServiceKey;

const SERVICES: { key: ServiceKey; label: string }[] = [
  { key: 'dhcp_v4', label: 'DHCP v4' },
  { key: 'dhcp_v6', label: 'DHCP v6' },
  { key: 'dns', label: 'DNS' },
  { key: 'ntp', label: 'NTP' },
  { key: 'wireguard', label: 'WireGuard' },
  { key: 'syslog', label: 'Logging' },
];

/** on / off / not configured / unknown, with the text shown beside it. */
interface Cell { state: 'on' | 'partial' | 'off' | 'none' | 'unknown'; label: string }

function cellFor(row: DeviceServiceRow, key: ServiceKey): Cell {
  const svc = row[key];
  if (row.error || !svc) return { state: 'unknown', label: '—' };
  switch (key) {
    case 'dhcp_v4':
    case 'dhcp_v6': {
      const s = svc as { total: number; enabled: number };
      if (s.total === 0) return { state: 'none', label: 'None' };
      return { state: partOf(s.enabled, s.total), label: `${s.enabled}/${s.total} on` };
    }
    case 'dns': {
      const s = svc as { allow_remote: boolean };
      return s.allow_remote ? { state: 'on', label: 'Remote on' } : { state: 'off', label: 'Local only' };
    }
    case 'ntp': {
      const s = svc as { server_enabled: boolean; client_enabled: boolean };
      if (s.server_enabled) return { state: 'on', label: 'Server on' };
      if (s.client_enabled) return { state: 'on', label: 'Client' };
      return { state: 'off', label: 'Off' };
    }
    case 'wireguard': {
      const s = svc as { total: number; running: number };
      if (s.total === 0) return { state: 'none', label: 'None' };
      return { state: partOf(s.running, s.total), label: `${s.running}/${s.total} up` };
    }
    case 'syslog': {
      const s = svc as { remote_count: number };
      return s.remote_count > 0 ? { state: 'on', label: `${s.remote_count} remote` } : { state: 'off', label: 'Local only' };
    }
  }
}

/** All on, some on (easy to miss among the greens, so it gets its own colour; #212), or none. */
function partOf(up: number, total: number): Cell['state'] {
  if (up <= 0) return 'off';
  return up < total ? 'partial' : 'on';
}

const STATE_RANK: Record<Cell['state'], number> = { on: 4, partial: 3, off: 2, none: 1, unknown: 0 };

/** The same on/off dot as the WireGuard and DHCP panels (#212). */
function ServiceState({ cell }: { cell: Cell }) {
  if (cell.state === 'unknown') return <span className="text-xs text-gray-400 dark:text-slate-500">—</span>;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-xs',
      cell.state === 'on' ? 'text-green-700 dark:text-green-400 font-medium'
        : cell.state === 'partial' ? 'text-amber-700 dark:text-amber-400 font-medium'
        : 'text-gray-500 dark:text-slate-400')}>
      <span className={clsx('w-1.5 h-1.5 rounded-full',
        cell.state === 'on' ? 'bg-green-500' : cell.state === 'partial' ? 'bg-amber-500'
          : cell.state === 'off' ? 'bg-gray-400' : 'border border-gray-300 dark:border-slate-600')} />
      {cell.label}
    </span>
  );
}

/**
 * Which network services each device runs (#212): the whole page is the table,
 * searchable and sortable, each row opening its device.
 */
export default function NetworkServicesOverviewPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' });

  const { data = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as unknown as DeviceServiceRow[]),
    refetchInterval: 60_000,
  });
  // Type and tags come from the device list.
  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = data.filter((r) => {
      if (!q) return true;
      const d = deviceById.get(r.id);
      return [r.name, r.ip_address, d?.model, ...(d?.tags ?? []).map((t) => t.name)]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'name') return dir * a.name.localeCompare(b.name);
      const diff = STATE_RANK[cellFor(a, sort.key).state] - STATE_RANK[cellFor(b, sort.key).state];
      return diff !== 0 ? dir * diff : a.name.localeCompare(b.name);
    });
  }, [data, search, sort, deviceById]);

  const flip = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Network Services</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Which services each device runs</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-8 w-56" placeholder="Search devices or tags" value={search}
              onChange={(e) => setSearch(e.target.value)} aria-label="Search devices" />
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading service status…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">
            {data.length === 0 ? 'No online devices found.' : 'No devices match your search.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  <th className="table-header px-4 py-[10px]">
                    <SortableHeader label="DEVICE" active={sort.key === 'name'} dir={sort.dir} onClick={() => flip('name')} />
                  </th>
                  {SERVICES.map((s) => (
                    <th key={s.key} className="table-header px-4 py-[10px]">
                      <SortableHeader label={s.label.toUpperCase()} active={sort.key === s.key} dir={sort.dir} onClick={() => flip(s.key)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="table-zebra">
                {rows.map((row) => {
                  const d = deviceById.get(row.id);
                  return (
                    <tr key={row.id} onClick={() => navigate(`/devices/${row.id}`)}
                      className="cursor-pointer transition-colors hover:bg-[var(--surface-3)]"
                      style={{ borderBottom: '1px solid var(--line-soft)' }}>
                      <td className="px-4 py-[12px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <DeviceTypePill type={d?.device_type} />
                          <span className="cell-primary">{row.name}</span>
                          <TagChips tags={d?.tags} />
                          {row.error && <span className="text-xs text-red-500">couldn&apos;t connect</span>}
                        </div>
                      </td>
                      {SERVICES.map((s) => (
                        <td key={s.key} className="px-4 py-[12px]"><ServiceState cell={cellFor(row, s.key)} /></td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
