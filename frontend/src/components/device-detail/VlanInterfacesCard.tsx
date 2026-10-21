import { useQuery } from '@tanstack/react-query';
import { Layers, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type VlanInterface } from '../../services/api';

const PARENT: Record<VlanInterface['parentKind'], { label: string; help: string }> = {
  'bridge-filtering': { label: 'bridge, filtering', help: 'On a bridge with VLAN filtering: this is how the device itself joins the VLAN' },
  bridge: { label: 'bridge, no filtering', help: 'On a bridge without VLAN filtering: the tag is only seen by the device itself, not enforced on bridge ports' },
  bond: { label: 'bond', help: 'On a bonded link' },
  vlan: { label: 'Q-in-Q', help: 'Stacked on another VLAN interface' },
  port: { label: 'port', help: 'On a physical port (router-on-a-stick)' },
  unknown: { label: 'unknown', help: 'The parent interface was not found' },
};

/**
 * VLAN interfaces (#309): /interface/vlan entries, the router-on-a-stick VLANs
 * a CCR, CHR or RB uses, which the bridge VLAN table doesn't show. Read live,
 * read-only. Hidden when the device has none.
 */
export default function VlanInterfacesCard({ deviceId }: { deviceId: number }) {
  const { data: rows = [], isFetching, error } = useQuery({
    queryKey: ['vlan-interfaces', deviceId],
    queryFn: () => devicesApi.getVlanInterfaces(deviceId).then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });

  if (error || rows.length === 0) return null;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">VLAN interfaces</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">{rows.length}</span>
        {isFetching && <RefreshCw className="w-3.5 h-3.5 animate-spin text-gray-400 ml-auto" />}
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        VLAN interfaces on this device (Interfaces, VLAN in WinBox), with the parent they&apos;re tagged on and their
        addresses. Read-only.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="py-1.5 pr-3 font-medium w-16">VLAN</th>
              <th className="py-1.5 pr-3 font-medium">Name</th>
              <th className="py-1.5 pr-3 font-medium">Parent</th>
              <th className="py-1.5 pr-3 font-medium">Addresses</th>
              <th className="py-1.5 pr-3 font-medium w-16">MTU</th>
              <th className="py-1.5 pr-3 font-medium w-24">State</th>
              <th className="py-1.5 font-medium">Comment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id || v.name} className={clsx('border-b border-gray-100 dark:border-slate-800', v.disabled && 'opacity-60')}>
                <td className="py-2 pr-3 font-mono text-gray-900 dark:text-white">{v.vlanId ?? '—'}</td>
                <td className="py-2 pr-3 font-mono text-gray-900 dark:text-white">{v.name}</td>
                <td className="py-2 pr-3">
                  <span className="font-mono text-gray-700 dark:text-slate-300">{v.parent || '—'}</span>
                  <span className={clsx('ml-1.5 px-1.5 py-0.5 rounded text-[11px]',
                    v.parentKind === 'bridge' || v.parentKind === 'unknown'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300')}
                    title={PARENT[v.parentKind].help}>
                    {PARENT[v.parentKind].label}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-gray-600 dark:text-slate-400">
                  {v.addresses.length ? v.addresses.map((a) => <div key={a}>{a}</div>) : '—'}
                </td>
                <td className="py-2 pr-3 text-gray-600 dark:text-slate-400">{v.mtu || '—'}</td>
                <td className="py-2 pr-3">
                  {v.disabled
                    ? <span className="text-gray-400 dark:text-slate-500">Disabled</span>
                    : v.running
                      ? <span className="text-green-600 dark:text-green-400">Running</span>
                      : <span className="text-amber-600 dark:text-amber-400" title="Enabled, but its parent has no link">Not running</span>}
                </td>
                <td className="py-2 text-gray-400 dark:text-slate-500">{v.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
