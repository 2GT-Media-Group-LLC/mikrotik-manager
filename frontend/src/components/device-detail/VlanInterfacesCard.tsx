import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, RefreshCw, Pencil, Trash2, Plus, Info } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type VlanInterface, type VlanInterfaceInput } from '../../services/api';
import type { Interface } from '../../types';
import { useCanWrite } from '../../hooks/useCanWrite';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { vlanParentChoices, vlanInterfaceChanges, vlanNameError, vlanMtuError, vlanAddressError, type VlanInterfaceForm } from '../../utils/vlanInterfaceForm';

const PARENT: Record<VlanInterface['parentKind'], { label: string; help: string }> = {
  'bridge-filtering': { label: 'bridge, filtering', help: 'On a bridge with VLAN filtering: this is how the device itself joins the VLAN' },
  bridge: { label: 'bridge, no filtering', help: 'On a bridge without VLAN filtering: the tag is only seen by the device itself, not enforced on bridge ports' },
  bond: { label: 'bond', help: 'On a bonded link' },
  vlan: { label: 'Q-in-Q', help: 'Stacked on another VLAN interface' },
  port: { label: 'port', help: 'On a physical port (router-on-a-stick)' },
  unknown: { label: 'unknown', help: 'The parent interface was not found' },
};

const EMPTY: VlanInterfaceForm = { vlanId: '', name: '', parent: '', mtu: '', comment: '', enabled: true, address: '' };

function errText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error)?.message || 'That didn’t work';
}

/**
 * VLAN interfaces (#309): /interface/vlan entries, the router-on-a-stick VLANs
 * a CCR, CHR or RB uses, which the bridge VLAN table doesn't show. Read live.
 * Adding, editing and removing them runs under Change Guard: a new VLAN ID or
 * parent on the interface management rides is a predicted lockout.
 */
export default function VlanInterfacesCard({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const guard = useGuardedWrite();
  const [form, setForm] = useState<VlanInterfaceForm | null>(null);
  const [editing, setEditing] = useState<VlanInterface | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: rows = [], isFetching, error } = useQuery({
    queryKey: ['vlan-interfaces', deviceId],
    queryFn: () => devicesApi.getVlanInterfaces(deviceId).then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: form ? false : 60_000,
    retry: false,
  });
  const { data: interfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data as Interface[]),
    enabled: canWrite && !!form,
    staleTime: 60_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vlan-interfaces', deviceId] });
    void qc.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
    void qc.invalidateQueries({ queryKey: ['interfaces', deviceId] });
  };
  const close = () => { setForm(null); setEditing(null); };

  // The request a Save sends, and the one Review changes previews.
  const saveRequest = (confirm: boolean) => {
    if (!form) return Promise.reject(new Error('Nothing to save'));
    const lock = confirm ? { confirm_lockout: true } : {};
    if (editing) {
      return devicesApi.updateVlanInterface(deviceId, editing.id,
        { ...vlanInterfaceChanges(editing, form), current_name: editing.name, ...lock });
    }
    const input: VlanInterfaceInput & { address?: string } = {
      vlan_id: Number(form.vlanId), interface: form.parent, name: form.name.trim() || `vlan${form.vlanId}`,
      ...(form.mtu ? { mtu: Number(form.mtu) } : {}),
      ...(form.comment.trim() ? { comment: form.comment.trim() } : {}),
      ...(form.enabled ? {} : { disabled: true }),
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
    };
    return devicesApi.addVlanInterface(deviceId, { ...input, ...lock });
  };

  const save = useMutation({
    mutationFn: (confirm: boolean) => saveRequest(confirm),
    onSuccess: (r) => {
      guard.onSuccess(r);
      const data = (r as { data?: { message?: string; address_error?: boolean } }).data;
      setNote({ ok: !data?.address_error, text: data?.message || 'Saved' });
      close();
      refresh();
    },
    onError: guard.onError(() => save.mutate(true), (e) => setNote({ ok: false, text: errText(e) })),
  });
  const remove = useMutation({
    mutationFn: ({ v, confirm }: { v: VlanInterface; confirm: boolean }) =>
      devicesApi.removeVlanInterface(deviceId, v.id, v.name, confirm),
    onSuccess: (r) => { guard.onSuccess(r); setNote({ ok: true, text: r.data?.message || 'Removed' }); refresh(); },
    onError: (e, vars) => guard.onError(() => remove.mutate({ v: vars.v, confirm: true }),
      (err) => setNote({ ok: false, text: errText(err) }))(e),
  });
  const busy = save.isPending || remove.isPending;

  if (error || (rows.length === 0 && !canWrite)) return null;

  const parents = vlanParentChoices(interfaces, editing?.name ?? null, form?.parent ?? '');
  const parentIsBridge = !!form && interfaces.some((i) => i.name === form.parent && i.type === 'bridge');
  const changes = form && editing ? vlanInterfaceChanges(editing, form) : null;
  const nameError = form ? vlanNameError(form.name) : null;
  const mtuError = form ? vlanMtuError(form.mtu) : null;
  const addressError = form && !editing ? vlanAddressError(form.address) : null;
  const valid = !!form && !nameError && !mtuError && !addressError && /^\d+$/.test(form.vlanId) && Number(form.vlanId) >= 1 && Number(form.vlanId) <= 4094
    && !!form.parent && (!editing || Object.keys(changes ?? {}).length > 0);
  const set = (patch: Partial<VlanInterfaceForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">VLAN interfaces</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">{rows.length}</span>
        {(isFetching || busy) && <RefreshCw className="w-3.5 h-3.5 animate-spin text-gray-400 ml-auto" />}
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        VLAN interfaces on this device (Interfaces, VLAN in WinBox), with the parent they&apos;re tagged on and their
        addresses.{canWrite && ' Changes run under Change Guard: changing the VLAN ID or parent of the interface the manager reaches the device through is refused unless you confirm it.'}
      </p>

      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={busy} />
      {note && (
        <div className={clsx('flex gap-2 p-2.5 rounded-lg border text-xs',
          note.ok ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
          <p className="flex-1">{note.text}</p>
          <button type="button" onClick={() => setNote(null)} className="opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-slate-500">This device has no VLAN interfaces.</p>
      ) : (
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
                <th className="py-1.5 pr-3 font-medium">Comment</th>
                {canWrite && <th className="py-1.5 w-14" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id || v.name} className={clsx('border-b border-gray-100 dark:border-slate-800', v.disabled && 'opacity-60',
                  editing?.id === v.id && 'bg-blue-50/50 dark:bg-slate-700/40')}>
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
                  <td className="py-2 pr-3 text-gray-400 dark:text-slate-500">{v.comment}</td>
                  {canWrite && (
                    <td className="py-2">
                      <div className="flex gap-1">
                        <button type="button" title={`Edit ${v.name}`} disabled={busy || !v.id}
                          onClick={() => {
                            setNote(null);
                            setEditing(v);
                            setForm({ vlanId: String(v.vlanId ?? ''), name: v.name, parent: v.parent, mtu: v.mtu, comment: v.comment, enabled: !v.disabled, address: '' });
                          }}
                          className="p-1 text-gray-400 hover:text-blue-500 disabled:opacity-40"><Pencil className="w-3.5 h-3.5" /></button>
                        <button type="button" title={`Remove ${v.name}`} disabled={busy || !v.id}
                          onClick={() => {
                            const addr = v.addresses.length ? ` Its addresses (${v.addresses.join(', ')}) are removed with it.` : '';
                            if (confirm(`Remove VLAN interface ${v.name} (VLAN ${v.vlanId ?? '?'} on ${v.parent})?${addr}`)) {
                              setNote(null);
                              remove.mutate({ v, confirm: false });
                            }
                          }}
                          className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && !form && (
        <button type="button" disabled={busy}
          onClick={() => { setNote(null); setEditing(null); setForm({ ...EMPTY }); }}
          className="btn-secondary text-xs py-1 flex items-center gap-1.5"><Plus className="w-3 h-3" /> Add VLAN interface</button>
      )}

      {canWrite && form && (
        <div className="p-3 rounded-lg border border-blue-200 dark:border-slate-600 bg-blue-50/40 dark:bg-slate-800/60 space-y-3">
          <h4 className="text-xs font-semibold text-gray-700 dark:text-slate-200">
            {editing ? `Edit ${editing.name}` : 'Add VLAN interface'}
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="label" htmlFor="vif-vlan">VLAN ID *</label>
              <input id="vif-vlan" className="input font-mono" value={form.vlanId} placeholder="20" inputMode="numeric"
                onChange={(e) => set({ vlanId: e.target.value.replace(/[^0-9]/g, '') })} />
            </div>
            <div>
              <label className="label" htmlFor="vif-parent">Parent *</label>
              <select id="vif-parent" className="input font-mono" value={form.parent} onChange={(e) => set({ parent: e.target.value })}>
                <option value="">Choose…</option>
                {parents.map((p) => <option key={p.name} value={p.name}>{p.name}{p.type ? ` (${p.type})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="vif-name">Name</label>
              <input id="vif-name" className={clsx('input font-mono', nameError && 'border-red-400 dark:border-red-500')} value={form.name}
                aria-invalid={!!nameError} aria-describedby={nameError ? 'vif-name-error' : undefined}
                placeholder={form.vlanId ? `vlan${form.vlanId}` : 'vlan20'} onChange={(e) => set({ name: e.target.value })} />
              {nameError && <p id="vif-name-error" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{nameError}</p>}
            </div>
            <div>
              <label className="label" htmlFor="vif-mtu">MTU</label>
              <input id="vif-mtu" className={clsx('input', mtuError && 'border-red-400 dark:border-red-500')} value={form.mtu}
                placeholder="1500" inputMode="numeric" aria-invalid={!!mtuError}
                onChange={(e) => set({ mtu: e.target.value.replace(/[^0-9]/g, '') })} />
              {mtuError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{mtuError}</p>}
            </div>
            {!editing && (
              <div className="col-span-2">
                <label className="label" htmlFor="vif-address">IP address</label>
                <input id="vif-address" className={clsx('input font-mono', addressError && 'border-red-400 dark:border-red-500')}
                  value={form.address} placeholder="10.0.20.1/24 (optional)" aria-invalid={!!addressError}
                  onChange={(e) => set({ address: e.target.value })} />
                {addressError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{addressError}</p>}
              </div>
            )}
            <div className={editing ? 'col-span-3' : 'col-span-2'}>
              <label className="label" htmlFor="vif-comment">Comment</label>
              <input id="vif-comment" className="input" value={form.comment} onChange={(e) => set({ comment: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-slate-300 self-end pb-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
            </label>
          </div>
          {parentIsBridge && form.vlanId && (
            <p className="flex gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              If VLAN filtering is on for {form.parent}, the bridge itself must also be a tagged member of VLAN {form.vlanId} in
              the bridge VLAN table above, or this interface gets no traffic.
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-primary text-sm flex items-center gap-2" disabled={!valid || busy}
              onClick={() => { setNote(null); save.mutate(false); }}>
              {save.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {editing ? 'Save changes' : 'Add VLAN interface'}
            </button>
            <ReviewChangesButton request={() => saveRequest(false)} onApply={() => save.mutate(false)}
              applyLabel={editing ? 'Save changes' : 'Add VLAN interface'} deviceName={deviceName} disabled={!valid || busy} />
            <button type="button" className="btn-secondary text-sm" onClick={close}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
