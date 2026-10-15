import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Pencil, Trash2, Check, X, RefreshCw, AlertCircle, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type BridgeView } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { LockoutVerdictDialog, lockoutVerdictOf, guardOutcomeMessage, type LockoutVerdict, type GuardResult } from '../ChangeGuardDialog';

const MODES = [
  { value: 'rstp', label: 'RSTP' },
  { value: 'stp', label: 'STP' },
  { value: 'mstp', label: 'MSTP' },
  { value: 'none', label: 'None (no spanning tree)' },
];

function errText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'That didn’t work';
}

interface EditForm { name: string; protocol_mode: string; priority: string; comment: string; enabled: boolean }

/**
 * Every bridge on the device (#284): its settings, ports (hardware-switched or
 * on the CPU), VLAN entries and addresses. Create, rename, change spanning
 * tree, turn VLAN filtering on or off, disable and delete, all through Change
 * Guard. Ports join or leave bridges on the Ports tab.
 */
export default function BridgesTab({ deviceId, deviceName, onGoToPorts }: {
  deviceId: number; deviceName?: string; onGoToPorts?: (bridgeName: string) => void;
}) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const { data: bridges = [], isLoading, refetch, isFetching, error: loadError } = useQuery({
    queryKey: ['bridges', deviceId],
    queryFn: () => devicesApi.getBridgesDetail(deviceId).then((r) => r.data),
  });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);
  const [adding, setAdding] = useState<{ name: string; protocol_mode: string; vlan_filtering: boolean; comment: string } | null>(null);
  const [editing, setEditing] = useState<{ bridge: BridgeView; form: EditForm } | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bridges', deviceId] });
    void qc.invalidateQueries({ queryKey: ['ports', deviceId] });
    void qc.invalidateQueries({ queryKey: ['vlans', deviceId] });
  };
  const done = (r: { data?: { message?: string; guard?: GuardResult } }) => {
    const g = guardOutcomeMessage(r.data?.guard);
    setNote(g ? { ok: g.tone === 'ok', text: g.text } : { ok: true, text: r.data?.message || 'Saved' });
    setLockout(null);
    refresh();
  };
  const failed = (retry: () => void) => (e: unknown) => {
    const verdict = lockoutVerdictOf(e);
    if (verdict) { setLockout({ verdict, retry }); return; }
    setNote({ ok: false, text: errText(e) });
  };

  const add = useMutation({
    mutationFn: (a: NonNullable<typeof adding>) => devicesApi.addBridge(deviceId, {
      name: a.name.trim(), protocol_mode: a.protocol_mode, vlan_filtering: a.vlan_filtering, ...(a.comment ? { comment: a.comment } : {}),
    }),
    onSuccess: (r) => { setAdding(null); done(r); },
    onError: (e) => setNote({ ok: false, text: errText(e) }),
  });

  const changesOf = (b: BridgeView, f: EditForm) => {
    const d: { name?: string; protocol_mode?: string; priority?: string; comment?: string; disabled?: boolean } = {};
    if (f.name.trim() !== b.name) d.name = f.name.trim();
    if (f.protocol_mode !== b.protocolMode) d.protocol_mode = f.protocol_mode;
    if (f.priority.trim() && f.priority.trim().toLowerCase() !== (b.priority ?? '').toLowerCase()) d.priority = f.priority.trim();
    if (f.comment !== (b.comment ?? '')) d.comment = f.comment;
    if (f.enabled !== !b.disabled) d.disabled = !f.enabled;
    return d;
  };
  const update = useMutation({
    mutationFn: ({ b, d, confirm = false }: { b: BridgeView; d: ReturnType<typeof changesOf>; confirm?: boolean }) =>
      devicesApi.updateBridge(deviceId, b.name, d, confirm),
    onSuccess: (r) => { setEditing(null); done(r); },
    onError: (e, v) => failed(() => update.mutate({ ...v, confirm: true }))(e),
  });
  const filtering = useMutation({
    mutationFn: ({ b, on, confirm = false }: { b: BridgeView; on: boolean; confirm?: boolean }) =>
      devicesApi.setBridgeVlanFiltering(deviceId, b.name, on, confirm),
    onSuccess: done,
    onError: (e, v) => failed(() => filtering.mutate({ ...v, confirm: true }))(e),
  });
  const remove = useMutation({
    mutationFn: ({ b, confirm = false }: { b: BridgeView; confirm?: boolean }) => devicesApi.deleteBridge(deviceId, b.name, confirm),
    onSuccess: done,
    onError: (e, v) => failed(() => remove.mutate({ ...v, confirm: true }))(e),
  });
  const busy = add.isPending || update.isPending || filtering.isPending || remove.isPending;

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;
  if (loadError) return <div className="card p-6 text-sm text-red-500">{errText(loadError)}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Bridges on this device. Ports join or leave a bridge on the{' '}
          {onGoToPorts ? <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => onGoToPorts('')}>Ports</button> : 'Ports'} tab.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
          {canWrite && !adding && (
            <button onClick={() => { setNote(null); setEditing(null); setAdding({ name: '', protocol_mode: 'rstp', vlan_filtering: false, comment: '' }); }}
              className="btn-primary flex items-center gap-2 text-sm"><Plus className="w-4 h-4" /> New bridge</button>
          )}
        </div>
      </div>

      {note && (
        <div className={clsx('flex gap-2 p-3 rounded-lg border text-sm',
          note.ok ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
          {!note.ok && <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
          <p className="flex-1">{note.text}</p>
          <button type="button" onClick={() => setNote(null)} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {adding && (
        <div className="card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">New bridge</h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div><label className="label">Name</label>
              <input className="input font-mono" value={adding.name} placeholder="bridge-guest" autoFocus
                onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
            <div><label className="label">Spanning tree</label>
              <select className="input" value={adding.protocol_mode} onChange={(e) => setAdding({ ...adding, protocol_mode: e.target.value })}>
                {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select></div>
            <div><label className="label">Comment</label>
              <input className="input" value={adding.comment} placeholder="Optional" onChange={(e) => setAdding({ ...adding, comment: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 mt-6">
              <input type="checkbox" checked={adding.vlan_filtering} onChange={(e) => setAdding({ ...adding, vlan_filtering: e.target.checked })} />
              VLAN filtering
            </label>
          </div>
          <p className="text-xs text-gray-400">An empty bridge changes nothing that&apos;s forwarding. Add ports to it on the Ports tab afterwards.</p>
          <div className="flex gap-2">
            <button onClick={() => add.mutate(adding)} disabled={busy || !adding.name.trim()} className="btn-primary flex items-center gap-2 text-sm">
              {add.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Create
            </button>
            <button onClick={() => setAdding(null)} className="btn-secondary text-sm"><X className="w-3.5 h-3.5 inline mr-1" />Cancel</button>
          </div>
        </div>
      )}

      {bridges.length === 0 && !adding && (
        <div className="card p-8 text-center text-gray-400 dark:text-slate-500 flex flex-col items-center gap-2">
          <Network className="w-6 h-6" /> No bridges on this device.
        </div>
      )}

      {bridges.map((b) => {
        const e = editing?.bridge.id === b.id ? editing : null;
        const hw = b.ports.filter((p) => p.hw).length;
        const cpu = b.ports.length - hw;
        const pending = e ? Object.keys(changesOf(b, e.form)).length : 0;
        const emptyBridge = b.ports.length === 0 && b.addresses.length === 0 && b.vlans.length === 0;
        return (
          <div key={b.id || b.name} className={clsx('card p-4 space-y-3', b.disabled && 'opacity-70')}>
            <div className="flex items-center gap-2 flex-wrap">
              <Network className="w-4 h-4 text-blue-500" />
              <h3 className="font-mono font-semibold text-gray-900 dark:text-white">{b.name}</h3>
              <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium',
                b.disabled ? 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400'
                  : b.running ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400')}>
                {b.disabled ? 'disabled' : b.running ? 'running' : 'not running'}
              </span>
              <span className="text-xs text-gray-500 dark:text-slate-400 font-mono">{b.protocolMode.toUpperCase()}{b.priority ? ` · priority ${b.priority}` : ''}</span>
              {b.comment && <span className="text-xs text-gray-400">· {b.comment}</span>}
              {canWrite && !e && !b.dynamic && (
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" title="Edit" disabled={busy}
                    onClick={() => { setNote(null); setAdding(null); setEditing({ bridge: b, form: { name: b.name, protocol_mode: b.protocolMode, priority: b.priority ?? '', comment: b.comment ?? '', enabled: !b.disabled } }); }}
                    className="btn-secondary text-xs py-1 flex items-center gap-1.5"><Pencil className="w-3 h-3" /> Edit</button>
                  <button type="button" disabled={busy || !emptyBridge}
                    title={emptyBridge ? 'Delete this bridge' : 'Only a bridge with no ports, addresses or VLANs can be deleted'}
                    onClick={() => { if (confirm(`Delete bridge ${b.name}?`)) { setNote(null); remove.mutate({ b }); } }}
                    className="p-1.5 rounded text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>

            {e && (
              <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div><label className="label">Name</label>
                    <input className="input font-mono" value={e.form.name} onChange={(ev) => setEditing({ ...e, form: { ...e.form, name: ev.target.value } })} /></div>
                  <div><label className="label">Spanning tree</label>
                    <select className="input" value={e.form.protocol_mode} onChange={(ev) => setEditing({ ...e, form: { ...e.form, protocol_mode: ev.target.value } })}>
                      {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select></div>
                  <div><label className="label">Priority</label>
                    <input className="input font-mono" value={e.form.priority} placeholder="0x8000" title="0 to 61440 in steps of 4096; lower wins the root election"
                      onChange={(ev) => setEditing({ ...e, form: { ...e.form, priority: ev.target.value } })} /></div>
                  <div><label className="label">Comment</label>
                    <input className="input" value={e.form.comment} onChange={(ev) => setEditing({ ...e, form: { ...e.form, comment: ev.target.value } })} /></div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                  <input type="checkbox" checked={e.form.enabled} onChange={(ev) => setEditing({ ...e, form: { ...e.form, enabled: ev.target.checked } })} />
                  Enabled
                </label>
                <p className="text-xs text-gray-400">
                  Renaming keeps the bridge&apos;s ports, VLANs and addresses. Changing spanning tree reconverges the bridge;
                  on the bridge the manager connects through, both run with auto-revert. Disabling that bridge is predicted
                  as a lockout and asks first.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => update.mutate({ b, d: changesOf(b, e.form) })} disabled={busy || pending === 0 || !e.form.name.trim()}
                    className="btn-primary flex items-center gap-2 text-sm">
                    {update.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                  </button>
                  <button onClick={() => setEditing(null)} disabled={update.isPending} className="btn-secondary text-sm"><X className="w-3.5 h-3.5 inline mr-1" />Cancel</button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mb-1 flex items-center gap-1.5">
                  Ports ({b.ports.length}){b.ports.length > 0 && <span className="text-gray-400">· {hw} hardware{cpu ? `, ${cpu} CPU` : ''}</span>}
                </div>
                {b.ports.length === 0 ? <span className="text-gray-400">none</span> : (
                  <div className="flex flex-wrap gap-1">
                    {b.ports.map((p) => (
                      <span key={p.name}
                        title={[p.hw ? 'Switched by the switch chip' : 'Switched by the CPU', p.pvid ? `PVID ${p.pvid}` : '', p.role ?? '', p.inactive ? 'inactive' : '', p.disabled ? 'disabled' : ''].filter(Boolean).join(' · ')}
                        className={clsx('px-1.5 py-0.5 rounded font-mono text-xs border',
                          p.disabled || p.inactive ? 'border-gray-200 text-gray-400 dark:border-slate-700' : 'border-gray-300 text-gray-700 dark:border-slate-600 dark:text-slate-200')}>
                        {p.name}{!p.hw && <Cpu className="w-3 h-3 inline ml-0.5 -mt-0.5 text-amber-500" />}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mb-1 flex items-center gap-2">
                  VLAN filtering
                  {canWrite && !b.dynamic && (
                    <button type="button" disabled={busy}
                      onClick={() => { setNote(null); filtering.mutate({ b, on: !b.vlanFiltering }); }}
                      className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40">
                      turn {b.vlanFiltering ? 'off' : 'on'}
                    </button>
                  )}
                </div>
                <span className={b.vlanFiltering ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-slate-400'}>{b.vlanFiltering ? 'On' : 'Off'}</span>
                {b.vlans.length > 0 && <span className="text-xs text-gray-400"> · VLANs {b.vlans.join(', ')}</span>}
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mb-1">Addresses</div>
                {b.addresses.length ? <span className="font-mono text-xs text-gray-700 dark:text-slate-300">{b.addresses.join(', ')}</span> : <span className="text-gray-400">none</span>}
                {b.mtu && <div className="text-xs text-gray-400 mt-1">MTU {b.mtu}{b.macAddress ? ` · ${b.macAddress}` : ''}</div>}
              </div>
            </div>
          </div>
        );
      })}

      {lockout && (
        <LockoutVerdictDialog
          deviceId={deviceId}
          verdict={lockout.verdict}
          confirmPhrase={deviceName || 'confirm'}
          pending={busy}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}
