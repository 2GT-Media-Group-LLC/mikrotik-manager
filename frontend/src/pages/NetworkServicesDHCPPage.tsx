import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, RefreshCw, AlertTriangle, Power, Plus, Pencil, Trash2,
  ChevronDown, ChevronRight, X, Check,
} from 'lucide-react';
import clsx from 'clsx';
import { networkServicesApi, devicesApi } from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';

type NS = Record<string, string>;

// ─── helpers ─────────────────────────────────────────────────────────────────

function leaseLabel(secs: string): string {
  const n = parseInt(secs);
  if (!n || isNaN(n)) return secs || '—';
  if (n < 3600)  return `${Math.round(n / 60)} min`;
  if (n < 86400) return `${Math.round(n / 3600)} hr`;
  return `${Math.round(n / 86400)} d`;
}

function StatusBadge({ disabled }: { disabled: boolean }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
      disabled
        ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
        : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
    )}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', disabled ? 'bg-gray-400' : 'bg-green-500')} />
      {disabled ? 'Disabled' : 'Enabled'}
    </span>
  );
}

// ─── Server form modal ────────────────────────────────────────────────────────

interface ServerFormProps {
  protocol: 'ipv4' | 'ipv6';
  existing?: NS;
  pools: NS[];
  interfaces: NS[];
  deviceId: number;
  onClose: () => void;
  conflictDevices?: { name: string }[];
}

function ServerForm({ protocol, existing, pools, interfaces, deviceId, onClose, conflictDevices }: ServerFormProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.['name'] || '');
  const [iface, setIface] = useState(existing?.['interface'] || '');
  const [pool, setPool] = useState(existing?.['address-pool'] || '');
  const [leaseTime, setLeaseTime] = useState(existing?.['lease-time'] || '00:10:00');

  // Group interfaces for the dropdown
  const vlanIfaces  = interfaces.filter(i => i['type'] === 'vlan');
  const bridgeIfaces = interfaces.filter(i => i['type'] === 'bridge');
  const otherIfaces  = interfaces.filter(i => i['type'] !== 'vlan' && i['type'] !== 'bridge');

  function ifaceLabel(i: NS): string {
    const base = i['name'];
    if (i['type'] === 'vlan') {
      const vid = i['vlan-id'];
      const parent = i['interface'];
      return vid ? `${base}  —  VLAN ${vid}${parent ? ` on ${parent}` : ''}` : base;
    }
    return i['comment'] ? `${base}  —  ${i['comment']}` : base;
  }

  const save = useMutation({
    mutationFn: () => {
      const body: NS & { protocol: 'ipv4' | 'ipv6' } = {
        protocol, name, interface: iface, 'address-pool': pool, 'lease-time': leaseTime,
      };
      return existing?.['.id']
        ? networkServicesApi.updateDhcpServer(deviceId, existing['.id'], body)
        : networkServicesApi.addDhcpServer(deviceId, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-dhcp', deviceId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {existing ? 'Edit' : 'Add'} {protocol === 'ipv4' ? 'IPv4' : 'IPv6'} DHCP Server
          </h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Name *</label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="dhcp1" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Interface *</label>
            {interfaces.length > 0 ? (
              <select className="input w-full" value={iface} onChange={e => setIface(e.target.value)}>
                <option value="">— select interface —</option>
                {vlanIfaces.length > 0 && (
                  <optgroup label="VLAN Interfaces">
                    {vlanIfaces.map(i => (
                      <option key={i['name']} value={i['name']}>{ifaceLabel(i)}</option>
                    ))}
                  </optgroup>
                )}
                {bridgeIfaces.length > 0 && (
                  <optgroup label="Bridge Interfaces">
                    {bridgeIfaces.map(i => (
                      <option key={i['name']} value={i['name']}>{ifaceLabel(i)}</option>
                    ))}
                  </optgroup>
                )}
                {otherIfaces.length > 0 && (
                  <optgroup label="Physical / Other">
                    {otherIfaces.map(i => (
                      <option key={i['name']} value={i['name']}>{ifaceLabel(i)}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            ) : (
              <input className="input w-full" value={iface} onChange={e => setIface(e.target.value)} placeholder="bridge1, vlan10, ether1" />
            )}
            <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
              VLAN interfaces scope the DHCP server to that VLAN. Bridge interfaces serve all untagged clients.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Address Pool</label>
            {pools.length > 0 ? (
              <select className="input w-full" value={pool} onChange={e => setPool(e.target.value)}>
                <option value="">— none —</option>
                {pools.map(p => <option key={p['.id']} value={p['name']}>{p['name']} ({p['ranges'] || p['prefix'] || ''})</option>)}
              </select>
            ) : (
              <input className="input w-full" value={pool} onChange={e => setPool(e.target.value)} placeholder="pool-name" />
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Lease Time</label>
            <input className="input w-full" value={leaseTime} onChange={e => setLeaseTime(e.target.value)} placeholder="00:10:00" />
            <p className="mt-0.5 text-xs text-gray-400">Format: HH:MM:SS or e.g. 10m, 1h, 1d</p>
          </div>
        </div>
        {!existing && conflictDevices && conflictDevices.length > 0 && (
          <div className="px-5 pb-3">
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>Active {protocol.toUpperCase()} DHCP server(s) already running on: <strong>{conflictDevices.map(d => d.name).join(', ')}</strong>. Multiple DHCP servers on the same network may cause IP address conflicts.</span>
            </div>
          </div>
        )}
        <div className="px-5 pb-4 flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!name || !iface || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{(save.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Pool form modal ──────────────────────────────────────────────────────────

interface PoolFormProps {
  protocol: 'ipv4' | 'ipv6';
  deviceId: number;
  onClose: () => void;
}

function PoolForm({ protocol, deviceId, onClose }: PoolFormProps) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [ranges, setRanges] = useState('');
  const [prefix, setPrefix] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const params: NS & { protocol: 'ipv4' | 'ipv6' } = { protocol, name };
      if (protocol === 'ipv4') params['ranges'] = ranges;
      else params['prefix'] = prefix;
      return networkServicesApi.addDhcpPool(deviceId, params);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-dhcp', deviceId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Add {protocol === 'ipv4' ? 'IPv4' : 'IPv6'} Address Pool
          </h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Name *</label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="pool1" />
          </div>
          {protocol === 'ipv4' ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Ranges *</label>
              <input className="input w-full" value={ranges} onChange={e => setRanges(e.target.value)} placeholder="192.168.1.10-192.168.1.100" />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Prefix *</label>
              <input className="input w-full" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="2001:db8::/64" />
            </div>
          )}
        </div>
        <div className="px-5 pb-4 flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!name || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            {save.isPending ? 'Adding…' : 'Add Pool'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{(save.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Static Lease form modal ──────────────────────────────────────────────────

interface StaticLeaseFormProps {
  protocol: 'ipv4' | 'ipv6';
  servers: NS[];
  deviceId: number;
  onClose: () => void;
}

function StaticLeaseForm({ protocol, servers, deviceId, onClose }: StaticLeaseFormProps) {
  const qc = useQueryClient();
  const [mac, setMac] = useState('');
  const [address, setAddress] = useState('');
  const [server, setServer] = useState(servers[0]?.['name'] || '');
  const [comment, setComment] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body: NS & { protocol: 'ipv4' | 'ipv6' } = {
        protocol, 'mac-address': mac, address, comment,
        ...(protocol === 'ipv4' ? { server } : { server }),
      };
      return networkServicesApi.addStaticLease(deviceId, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ns-leases', deviceId, protocol] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Add Static Lease</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">MAC Address *</label>
            <input className="input w-full font-mono" value={mac} onChange={e => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">IP Address *</label>
            <input className="input w-full font-mono" value={address} onChange={e => setAddress(e.target.value)} placeholder={protocol === 'ipv4' ? '192.168.1.50' : '2001:db8::50'} />
          </div>
          {servers.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">DHCP Server</label>
              <select className="input w-full" value={server} onChange={e => setServer(e.target.value)}>
                {servers.map(s => <option key={s['.id']} value={s['name']}>{s['name']}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Comment</label>
            <input className="input w-full" value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="px-5 pb-4 flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!mac || !address || save.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            {save.isPending ? 'Adding…' : 'Add Lease'}
          </button>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          {save.isError && <span className="text-xs text-red-500">{(save.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Section component ────────────────────────────────────────────────────────

interface SectionProps {
  color: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ color, title, count, open, onToggle, action, children }: SectionProps) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center border-b border-gray-200 dark:border-slate-700">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 flex-1 px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors text-left"
        >
          {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          <Server className={clsx('w-4 h-4', color)} />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">{title}</h2>
          <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">{count}</span>
        </button>
        {action && <div className="px-3">{action}</div>}
      </div>
      {open && children}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function NetworkServicesDHCPPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | ''>('');
  const [v4Open, setV4Open] = useState(true);
  const [v6Open, setV6Open] = useState(true);
  const [poolsV4Open, setPoolsV4Open] = useState(false);
  const [poolsV6Open, setPoolsV6Open] = useState(false);
  const [leasesOpen, setLeasesOpen] = useState(false);
  const [leasesV6Open, setLeasesV6Open] = useState(false);

  // Modals
  const [serverForm, setServerForm] = useState<{ protocol: 'ipv4' | 'ipv6'; existing?: NS } | null>(null);
  const [poolForm, setPoolForm] = useState<'ipv4' | 'ipv6' | null>(null);
  const [leaseForm, setLeaseForm] = useState<'ipv4' | 'ipv6' | null>(null);

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const deviceId = typeof selectedDeviceId === 'number' ? selectedDeviceId : 0;
  const selectedDevice = devices.find(d => d.id === deviceId);

  const { data: dhcp, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ['ns-dhcp', deviceId],
    queryFn: () => networkServicesApi.getDhcp(deviceId).then(r => r.data),
    enabled: deviceId > 0,
  });

  const { data: leasesV4 = [] } = useQuery({
    queryKey: ['ns-leases', deviceId, 'ipv4'],
    queryFn: () => networkServicesApi.getLeases(deviceId, 'ipv4').then(r => r.data),
    enabled: deviceId > 0 && leasesOpen,
  });

  const { data: leasesV6 = [] } = useQuery({
    queryKey: ['ns-leases', deviceId, 'ipv6'],
    queryFn: () => networkServicesApi.getLeases(deviceId, 'ipv6').then(r => r.data),
    enabled: deviceId > 0 && leasesV6Open,
  });

  const deleteServer = useMutation({
    mutationFn: ({ id, protocol }: { id: string; protocol: 'ipv4' | 'ipv6' }) =>
      networkServicesApi.deleteDhcpServer(deviceId, id, protocol),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ns-dhcp', deviceId] }),
  });

  const toggleServer = useMutation({
    mutationFn: ({ id, disabled, protocol }: { id: string; disabled: boolean; protocol: 'ipv4' | 'ipv6' }) =>
      networkServicesApi.toggleDhcpServer(deviceId, id, disabled, protocol),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ns-dhcp', deviceId] }),
  });

  const deletePool = useMutation({
    mutationFn: ({ id, protocol }: { id: string; protocol: 'ipv4' | 'ipv6' }) =>
      networkServicesApi.deleteDhcpPool(deviceId, id, protocol),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ns-dhcp', deviceId] }),
  });

  const deleteLease = useMutation({
    mutationFn: ({ id, protocol }: { id: string; protocol: 'ipv4' | 'ipv6' }) =>
      networkServicesApi.deleteStaticLease(deviceId, id, protocol),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['ns-leases', deviceId, vars.protocol] }),
  });

  // Cross-device conflict detection
  const { data: overview = [] } = useQuery({
    queryKey: ['network-services-overview'],
    queryFn: () => networkServicesApi.overview().then(r => r.data as Record<string, unknown>[]),
    staleTime: 60_000,
  });
  const conflictDevicesV4 = overview.filter(d => {
    if ((d.id as number) === deviceId) return false;
    const v4 = d.dhcp_v4 as { total: number; enabled: number } | null;
    return (v4?.enabled ?? 0) > 0;
  });
  const conflictDevicesV6 = overview.filter(d => {
    if ((d.id as number) === deviceId) return false;
    const v6 = d.dhcp_v6 as { total: number; enabled: number } | null;
    return (v6?.enabled ?? 0) > 0;
  });

  function ServerTable({ servers, protocol }: { servers: NS[]; protocol: 'ipv4' | 'ipv6' }) {
    if (servers.length === 0) {
      return <div className="px-5 py-6 text-sm text-gray-400 dark:text-slate-500 text-center">No servers configured.</div>;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Interface</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Pool</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Lease Time</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
              {canWrite && <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {servers.map((s, i) => {
              const disabled = s['disabled'] === 'true';
              return (
                <tr key={s['.id'] || i} className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40', i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s['name'] || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-slate-300">{s['interface'] || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-slate-300">{s['address-pool'] || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-slate-300">{leaseLabel(s['lease-time'] || '')}</td>
                  <td className="px-4 py-3"><StatusBadge disabled={disabled} /></td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => {
                          if (disabled) {
                            const conflicts = protocol === 'ipv4' ? conflictDevicesV4 : conflictDevicesV6;
                            if (conflicts.length > 0) {
                              const names = conflicts.map(d => d.name as string).join(', ');
                              if (!confirm(`Active ${protocol.toUpperCase()} DHCP server(s) already running on: ${names}.\n\nEnabling another DHCP server on the same network may cause IP address conflicts. Continue?`)) return;
                            }
                          }
                          toggleServer.mutate({ id: s['.id'], disabled: !disabled, protocol });
                        }} title={disabled ? 'Enable' : 'Disable'}
                          className={clsx('p-1.5 rounded-lg transition-colors', disabled ? 'text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20' : 'text-green-600 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20')}>
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setServerForm({ protocol, existing: s })} title="Edit"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => { if (confirm(`Delete DHCP server "${s['name']}"?`)) deleteServer.mutate({ id: s['.id'], protocol }); }} title="Delete"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function PoolTable({ pools, protocol }: { pools: NS[]; protocol: 'ipv4' | 'ipv6' }) {
    if (pools.length === 0) return <div className="px-5 py-6 text-sm text-gray-400 dark:text-slate-500 text-center">No pools configured.</div>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">{protocol === 'ipv4' ? 'Ranges' : 'Prefix'}</th>
              {canWrite && <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pools.map((p, i) => (
              <tr key={p['.id'] || i} className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40', i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{p['name']}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-slate-300">{p['ranges'] || p['prefix'] || '—'}</td>
                {canWrite && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { if (confirm(`Delete pool "${p['name']}"?`)) deletePool.mutate({ id: p['.id'], protocol }); }}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function LeaseTable({ leases, protocol }: { leases: NS[]; protocol: 'ipv4' | 'ipv6' }) {
    if (leases.length === 0) return <div className="px-5 py-6 text-sm text-gray-400 dark:text-slate-500 text-center">No leases.</div>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">MAC / DUID</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Address</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Hostname</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Type</th>
              {canWrite && <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {leases.map((l, i) => {
              const isStatic = l['dynamic'] !== 'true';
              return (
                <tr key={l['.id'] || i} className={clsx('border-b border-gray-100 dark:border-slate-800 transition-colors hover:bg-blue-50 dark:hover:bg-slate-700/40', i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-gray-50 dark:bg-slate-800/40')}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-slate-300">{l['mac-address'] || l['duid'] || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-slate-300">{l['address'] || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-slate-300">{l['host-name'] || l['comment'] || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium', isStatic ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-500')}>
                      {isStatic ? 'Static' : 'Dynamic'}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3 text-right">
                      {isStatic && (
                        <button onClick={() => deleteLease.mutate({ id: l['.id'], protocol })}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Modals */}
      {serverForm && (
        <ServerForm
          protocol={serverForm.protocol}
          existing={serverForm.existing}
          pools={serverForm.protocol === 'ipv4' ? (dhcp?.pools_v4 || []) : (dhcp?.pools_v6 || [])}
          interfaces={dhcp?.interfaces || []}
          deviceId={deviceId}
          onClose={() => setServerForm(null)}
          conflictDevices={serverForm.protocol === 'ipv4' ? conflictDevicesV4 as { name: string }[] : conflictDevicesV6 as { name: string }[]}
        />
      )}
      {poolForm && <PoolForm protocol={poolForm} deviceId={deviceId} onClose={() => setPoolForm(null)} />}
      {leaseForm && (
        <StaticLeaseForm
          protocol={leaseForm}
          servers={leaseForm === 'ipv4' ? (dhcp?.ipv4 || []) : (dhcp?.ipv6 || [])}
          deviceId={deviceId}
          onClose={() => setLeaseForm(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">DHCP Server</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Manage DHCP servers, address pools, and leases</p>
        </div>
        {deviceId > 0 && (
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} />
            Refresh
          </button>
        )}
      </div>

      {/* Device selector */}
      <div className="card p-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-2">Select Device</label>
        <select className="input w-full max-w-xs" value={selectedDeviceId}
          onChange={e => setSelectedDeviceId(e.target.value === '' ? '' : parseInt(e.target.value))}>
          <option value="">— Choose a device —</option>
          {devices.map(d => (
            <option key={d.id} value={d.id}>{d.name} ({d.ip_address}){d.status !== 'online' ? ' — offline' : ''}</option>
          ))}
        </select>
        {selectedDevice && selectedDevice.status !== 'online' && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />This device is currently offline. Connection may fail.
          </div>
        )}
      </div>

      {/* Cross-device conflict warnings */}
      {conflictDevicesV4.length > 0 && deviceId > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Active IPv4 DHCP server(s) already running on: <strong>{conflictDevicesV4.map(d => d.name as string).join(', ')}</strong>. Adding another DHCP server on the same network may cause IP address conflicts.</span>
        </div>
      )}
      {conflictDevicesV6.length > 0 && deviceId > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Active IPv6 DHCP server(s) already running on: <strong>{conflictDevicesV6.map(d => d.name as string).join(', ')}</strong>. Adding another DHCP server on the same network may cause IP address conflicts.</span>
        </div>
      )}

      {deviceId === 0 && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Select a device above.</div>}
      {deviceId > 0 && isLoading && <div className="card p-8 text-center text-sm text-gray-400 dark:text-slate-500">Loading…</div>}
      {deviceId > 0 && error && (
        <div className="card p-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />Failed: {(error as Error).message}
        </div>
      )}

      {dhcp && (
        <>
          {/* IPv4 Servers */}
          <Section color="text-blue-500" title="IPv4 DHCP Servers" count={dhcp.ipv4.length}
            open={v4Open} onToggle={() => setV4Open(o => !o)}
            action={canWrite ? <button onClick={() => setServerForm({ protocol: 'ipv4' })} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Add</button> : undefined}>
            <ServerTable servers={dhcp.ipv4} protocol="ipv4" />
          </Section>

          {/* IPv4 Pools */}
          <Section color="text-cyan-500" title="IPv4 Address Pools" count={dhcp.pools_v4.length}
            open={poolsV4Open} onToggle={() => setPoolsV4Open(o => !o)}
            action={canWrite ? <button onClick={() => setPoolForm('ipv4')} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Add</button> : undefined}>
            <PoolTable pools={dhcp.pools_v4} protocol="ipv4" />
          </Section>

          {/* IPv4 Leases */}
          <Section color="text-sky-500" title="IPv4 Leases" count={leasesV4.length}
            open={leasesOpen} onToggle={() => setLeasesOpen(o => !o)}
            action={canWrite ? <button onClick={() => setLeaseForm('ipv4')} className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Static</button> : undefined}>
            <LeaseTable leases={leasesV4} protocol="ipv4" />
          </Section>

          {/* IPv6 Servers */}
          <Section color="text-indigo-500" title="IPv6 DHCP Servers" count={dhcp.ipv6.length}
            open={v6Open} onToggle={() => setV6Open(o => !o)}
            action={canWrite ? <button onClick={() => setServerForm({ protocol: 'ipv6' })} className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Add</button> : undefined}>
            <ServerTable servers={dhcp.ipv6} protocol="ipv6" />
          </Section>

          {/* IPv6 Pools */}
          <Section color="text-violet-500" title="IPv6 Address Pools" count={dhcp.pools_v6.length}
            open={poolsV6Open} onToggle={() => setPoolsV6Open(o => !o)}
            action={canWrite ? <button onClick={() => setPoolForm('ipv6')} className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Add</button> : undefined}>
            <PoolTable pools={dhcp.pools_v6} protocol="ipv6" />
          </Section>

          {/* IPv6 Leases */}
          <Section color="text-purple-500" title="IPv6 Bindings" count={leasesV6.length}
            open={leasesV6Open} onToggle={() => setLeasesV6Open(o => !o)}
            action={canWrite ? <button onClick={() => setLeaseForm('ipv6')} className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"><Plus className="w-3 h-3" />Static</button> : undefined}>
            <LeaseTable leases={leasesV6} protocol="ipv6" />
          </Section>
        </>
      )}
    </div>
  );
}
