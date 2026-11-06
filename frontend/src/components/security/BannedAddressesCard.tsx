import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban } from 'lucide-react';
import { firewallBansApi } from '../../services/api';

/**
 * What brute-force protection (#405) has banned across the fleet, from each
 * device's slow poll. Unbanning is on the device's Firewall tab. Hidden when
 * nothing is banned.
 */
export default function BannedAddressesCard() {
  const { data: bans = [] } = useQuery({
    queryKey: ['firewall-bans'],
    queryFn: () => firewallBansApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  if (bans.length === 0) return null;
  const devices = new Set(bans.map((b) => b.device_id)).size;
  return (
    <div className="card overflow-hidden flex flex-col max-h-[420px]">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2 flex-wrap">
        <Ban className="w-4 h-4 text-red-500" />
        <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Banned addresses</h2>
        <span className="text-xs text-gray-400 dark:text-slate-500">
          {bans.length} on {devices} {devices === 1 ? 'device' : 'devices'} · brute-force protection · as of the last slow poll
        </span>
      </div>
      <div className="overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-800/60 sticky top-0">
            <tr><th className="text-left font-medium px-5 py-2">Address</th><th className="text-left font-medium px-3 py-2">Device</th>
              <th className="text-left font-medium px-3 py-2">Time left</th><th className="text-left font-medium px-3 py-2">First seen</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700/50">
            {bans.map((b) => (
              <tr key={`${b.device_id}-${b.address}`}>
                <td className="px-5 py-1.5 font-mono text-gray-800 dark:text-slate-200">{b.address}</td>
                <td className="px-3 py-1.5">
                  <Link to={`/devices/${b.device_id}?tab=firewall`} className="text-blue-600 dark:text-blue-400 hover:underline">{b.device_name}</Link>
                </td>
                <td className="px-3 py-1.5 text-gray-500 dark:text-slate-400">{b.time_left ?? 'until removed'}</td>
                <td className="px-3 py-1.5 text-gray-500 dark:text-slate-400">{new Date(b.first_seen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
