import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Plus, Trash2, AlertCircle, Pencil, Check, X } from 'lucide-react';
import clsx from 'clsx';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { hostAddressProblem } from '../../utils/ipPrefix';
import { devicesApi } from '../../services/api';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import type { IpAddress, Interface } from '../../types';
import { useCanWrite } from '../../hooks/useCanWrite';

/**
 * A device's IPv4 addresses: list, add, edit in place (#285) and remove, each
 * through Change Guard with a predicted lockout stopping for confirmation.
 * On the Config tab it lists every address; given `iface` (a bridge's row,
 * #466) it lists that interface's and adds to it.
 */
export default function IpAddressesCard({ deviceId, deviceName, iface, onChanged }: {
  deviceId: number;
  deviceName: string;
  iface?: string;
  /** After an address is added, changed or removed (the Bridges tab reads them again). */
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
    onChanged?.();
  };

  const { data: ipAddresses = [], isLoading: ipLoading, refetch: refetchIp } = useQuery({
    queryKey: ['ip-addresses', deviceId],
    queryFn: () => devicesApi.getIpAddresses(deviceId).then((r) => r.data as IpAddress[]),
  });

  const { data: interfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data as Interface[]),
  });

  const [newIp, setNewIp] = useState({ address: '', interface: iface ?? '' });
  const [ipError, setIpError] = useState('');
  // Predicted lockout (409 + verdict) plus the retry that confirms it.
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const addIpRequest = (confirm: boolean) =>
    devicesApi.addIpAddress(deviceId, confirm ? { ...newIp, confirm_lockout: true } : newIp);
  const addIpMutation = useMutation({
    mutationFn: addIpRequest,
    onSuccess: () => {
      changed();
      setNewIp({ address: '', interface: iface ?? '' });
      setIpError('');
      setLockout(null);
    },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => addIpMutation.mutate(true) }); return; }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to add IP address');
    },
  });

  const removeIpMutation = useMutation({
    mutationFn: ({ id, confirm = false }: { id: string; confirm?: boolean }) =>
      devicesApi.removeIpAddress(deviceId, id, confirm),
    onSuccess: () => {
      changed();
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => removeIpMutation.mutate({ id: vars.id, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to remove IP address');
    },
  });

  // Editing an address in place (#285). Only changed fields are sent, so a
  // comment edit can't also rewrite the address.
  const [editingIp, setEditingIp] = useState<{ id: string; orig: IpAddress; address: string; interface: string; comment: string; enabled: boolean } | null>(null);
  const ipEdits = (e: NonNullable<typeof editingIp>) => {
    const d: { address?: string; interface?: string; comment?: string; disabled?: boolean } = {};
    if (e.address.trim() !== e.orig.address) d.address = e.address.trim();
    if (e.interface !== e.orig.interface) d.interface = e.interface;
    if (e.comment !== (e.orig.comment ?? '')) d.comment = e.comment;
    if (e.enabled !== (e.orig.disabled !== 'true')) d.disabled = !e.enabled;
    return d;
  };
  const updateIpMutation = useMutation({
    mutationFn: ({ e, confirm = false }: { e: NonNullable<typeof editingIp>; confirm?: boolean }) =>
      devicesApi.updateIpAddress(deviceId, e.id, ipEdits(e), confirm),
    onSuccess: () => {
      changed();
      setEditingIp(null);
      setIpError('');
      setLockout(null);
    },
    onError: (err: unknown, vars) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) {
        setLockout({ verdict, retry: () => updateIpMutation.mutate({ e: vars.e, confirm: true }) });
        return;
      }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to update IP address');
    },
  });

  // On a bridge's row (#466), only that interface's addresses.
  const shownIps = iface ? (ipAddresses as IpAddress[]).filter((ip) => ip.interface === iface) : (ipAddresses as IpAddress[]);

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">{iface ? <>Addresses on <span className="font-mono">{iface}</span></> : 'IP Addresses'}</h3>
          <button
            onClick={() => refetchIp()}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', ipLoading && 'animate-spin')} />
          </button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-700">
              <th className="table-header px-4 py-2 text-left">Address / Prefix</th>
              <th className="table-header px-4 py-2 text-left">Network</th>
              <th className="table-header px-4 py-2 text-left">Interface</th>
              <th className="table-header px-4 py-2 text-left">Comment</th>
              <th className="table-header px-4 py-2 text-left">Status</th>
              <th className="table-header px-4 py-2 w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
            {ipLoading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading...</td></tr>
            ) : shownIps.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">{iface ? `No addresses on ${iface}` : 'No IP addresses'}</td></tr>
            ) : (
              shownIps.map((ip) => editingIp?.id === ip['.id'] ? (
                <tr key={ip['.id']} className="bg-blue-50/50 dark:bg-slate-700/40">
                  <td className="px-4 py-2" colSpan={2}>
                    <input className="input font-mono py-1 text-sm" value={editingIp.address} aria-label="Address / prefix"
                      onChange={(e) => setEditingIp((x) => x && { ...x, address: e.target.value })} />
                    {hostAddressProblem(editingIp.address) && (
                      <p className="mt-1 text-xs text-red-500">{hostAddressProblem(editingIp.address)}</p>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <select className="input py-1 text-sm" value={editingIp.interface} aria-label="Interface"
                      onChange={(e) => setEditingIp((x) => x && { ...x, interface: e.target.value })}>
                      {!(interfaces as Interface[]).some((i) => i.name === editingIp.interface) && <option value={editingIp.interface}>{editingIp.interface}</option>}
                      {(interfaces as Interface[]).map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input className="input py-1 text-sm" value={editingIp.comment} placeholder="Comment" aria-label="Comment"
                      onChange={(e) => setEditingIp((x) => x && { ...x, comment: e.target.value })} />
                  </td>
                  <td className="px-4 py-2">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300">
                      <input type="checkbox" checked={editingIp.enabled}
                        onChange={(e) => setEditingIp((x) => x && { ...x, enabled: e.target.checked })} /> enabled
                    </label>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => updateIpMutation.mutate({ e: editingIp })}
                        disabled={updateIpMutation.isPending || Object.keys(ipEdits(editingIp)).length === 0 || !!hostAddressProblem(editingIp.address)}
                        className="p-1 rounded text-green-600 hover:text-green-700 disabled:opacity-40" title="Save">
                        {updateIpMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      </button>
                      <ReviewChangesButton className="py-1 px-2 text-xs whitespace-nowrap"
                        request={() => devicesApi.updateIpAddress(deviceId, editingIp.id, ipEdits(editingIp), false)}
                        onApply={() => updateIpMutation.mutate({ e: editingIp })} applyLabel="Save" deviceName={deviceName}
                        disabled={updateIpMutation.isPending || Object.keys(ipEdits(editingIp)).length === 0 || !!hostAddressProblem(editingIp.address)} />
                      <button onClick={() => { setEditingIp(null); setIpError(''); }} className="p-1 rounded text-gray-400 hover:text-gray-600" title="Cancel">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={ip['.id']} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-white">{ip.address}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{ip.network || '—'}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-slate-300">{ip.interface}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-slate-400">{ip.comment || ''}</td>
                  <td className="px-4 py-2">
                    <span className={clsx(
                      'text-xs font-medium',
                      ip.disabled === 'true' ? 'text-gray-400' : 'text-green-600 dark:text-green-400'
                    )}>
                      {ip.dynamic === 'true' ? 'dynamic' : ip.disabled === 'true' ? 'disabled' : 'active'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {canWrite && ip.dynamic !== 'true' && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            setIpError('');
                            setEditingIp({ id: ip['.id'], orig: ip, address: ip.address, interface: ip.interface, comment: ip.comment ?? '', enabled: ip.disabled !== 'true' });
                          }}
                          className="p-1 rounded text-gray-400 hover:text-blue-500 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Remove ${ip.address} from ${ip.interface}?`)) {
                              removeIpMutation.mutate({ id: ip['.id'] });
                            }
                          }}
                          className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {canWrite && <div className="p-4 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="label">Address / Prefix (e.g. 192.168.1.1/24)</label>
              <input
                className="input font-mono"
                value={newIp.address}
                onChange={(e) => setNewIp((f) => ({ ...f, address: e.target.value }))}
                placeholder="192.168.1.1/24"
              />
            </div>
            {!iface && (
              <div className="w-44">
                <label className="label">Interface</label>
                <select
                  className="input"
                  value={newIp.interface}
                  onChange={(e) => setNewIp((f) => ({ ...f, interface: e.target.value }))}
                >
                  <option value="">Select...</option>
                  {(interfaces as Interface[]).map((i) => (
                    <option key={i.name} value={i.name}>{i.name}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              onClick={() => addIpMutation.mutate(false)}
              disabled={!newIp.address || !newIp.interface || addIpMutation.isPending || !!hostAddressProblem(newIp.address)}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
            <ReviewChangesButton request={() => addIpRequest(false)} onApply={() => addIpMutation.mutate(false)} applyLabel="Add"
              deviceName={deviceName} disabled={!newIp.address || !newIp.interface || addIpMutation.isPending || !!hostAddressProblem(newIp.address)} />
          </div>
          {(hostAddressProblem(newIp.address) || ipError) && (
            <div className="flex items-center gap-2 mt-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {hostAddressProblem(newIp.address) || ipError}
            </div>
          )}
        </div>}
      </div>

      {lockout && (
        <LockoutVerdictDialog
          deviceId={deviceId}
          verdict={lockout.verdict}
          confirmPhrase={deviceName}
          pending={addIpMutation.isPending || removeIpMutation.isPending || updateIpMutation.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </>
  );
}
