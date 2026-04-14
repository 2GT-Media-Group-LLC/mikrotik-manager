import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Wifi } from 'lucide-react';
import { clientsApi } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import type { Client } from '../types';
import clsx from 'clsx';

function signalLabel(dbm: number | null): string {
  if (dbm === null) return '—';
  if (dbm >= -55) return 'Excellent';
  if (dbm >= -65) return 'Good';
  if (dbm >= -75) return 'Fair';
  return 'Poor';
}

function signalColor(dbm: number | null): string {
  if (dbm === null) return 'text-gray-400 dark:text-slate-500';
  if (dbm >= -55) return 'text-green-600 dark:text-green-400';
  if (dbm >= -65) return 'text-lime-600 dark:text-lime-400';
  if (dbm >= -75) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

export default function WirelessClientsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['wireless-clients-page'],
    queryFn: () =>
      clientsApi.list({ active: true, client_type: 'wireless', limit: 200 }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  useSocket({
    'clients:updated': () => qc.invalidateQueries({ queryKey: ['wireless-clients-page'] }),
  });

  const clients: Client[] = data?.clients ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Wireless Clients</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            Active wireless clients across all access points
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={clsx('w-4 h-4', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin inline mr-2" />Loading…
          </div>
        ) : clients.length === 0 ? (
          <div className="p-8 text-center text-gray-400 dark:text-slate-500 text-sm">
            <Wifi className="w-6 h-6 mx-auto mb-2 opacity-40" />
            No active wireless clients
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">IP Address</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">MAC Address</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">SSID</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Signal</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-slate-400">Access Point</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {clients.map((client) => {
                  const c = client as Client & { device_name?: string; ssid?: string };
                  const name = c.custom_name || c.hostname || c.mac_address;
                  const dbm = c.signal_strength ?? null;
                  return (
                    <tr
                      key={c.mac_address}
                      className="hover:bg-gray-50 dark:hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium">
                        <button
                          onClick={() => navigate(`/clients/${encodeURIComponent(c.mac_address)}`)}
                          className="text-blue-600 dark:text-blue-400 hover:underline text-left"
                        >
                          {name}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-slate-400">
                        {c.ip_address || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-slate-400">
                        {c.mac_address}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-slate-400">
                        {c.ssid || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {dbm !== null ? (
                          <span className={clsx('font-medium', signalColor(dbm))}>
                            {dbm} dBm
                            <span className="ml-1.5 font-normal text-xs opacity-75">
                              ({signalLabel(dbm)})
                            </span>
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-slate-400">
                        {c.device_name || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-slate-500 text-right">
        {clients.length} client{clients.length !== 1 ? 's' : ''} · refreshes every 30 s
      </p>
    </div>
  );
}
