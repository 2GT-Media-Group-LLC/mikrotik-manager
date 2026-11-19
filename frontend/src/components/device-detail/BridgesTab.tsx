import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Pencil, Trash2, Check, X, RefreshCw, AlertCircle, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi, type BridgeView, type BridgePortView, type BridgePortUpdate } from '../../services/api';
import { portPriorityValue, portPriorityError, pathCostError, bpduGuardWarning } from '../../utils/portStp';
import { useCanWrite } from '../../hooks/useCanWrite';
import { bridgeMtuCeiling, bridgeMtuError } from '../../utils/mtu';
import IpAddressesCard from './IpAddressesCard';
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

interface EditForm { name: string; protocol_mode: string; priority: string; comment: string; enabled: boolean; mtu: string; ether_type: string; mvrp: boolean }

/** The tag a bridge reads as a VLAN (#449). */
const ETHER_TYPES = [
  { value: '0x8100', label: '0x8100 (802.1Q)' },
  { value: '0x88a8', label: '0x88a8 (802.1ad service tag, Q-in-Q)' },
  { value: '0x9100', label: '0x9100 (older Q-in-Q)' },
];

interface PortForm {
  tag_stacking: boolean; mvrp_applicant_state: string; mvrp_registrar_state: string;
  stp_priority: string; path_cost: string; edge: string; point_to_point: string;
  bpdu_guard: boolean; restricted_role: boolean; restricted_tcn: boolean;
}
const portFormOf = (p: BridgePortView): PortForm => ({
  tag_stacking: !!p.tagStacking,
  mvrp_applicant_state: p.mvrpApplicant ?? 'normal-participant',
  mvrp_registrar_state: p.mvrpRegistrar ?? 'normal',
  stp_priority: p.stpPriority ?? '',
  path_cost: p.pathCost ?? '',
  edge: p.edge ?? 'auto',
  point_to_point: p.pointToPoint ?? 'auto',
  bpdu_guard: !!p.bpduGuard,
  restricted_role: !!p.restrictedRole,
  restricted_tcn: !!p.restrictedTcn,
});
const portChanges = (p: BridgePortView, f: PortForm) => {
  const d: BridgePortUpdate = {};
  if (f.tag_stacking !== !!p.tagStacking) d.tag_stacking = f.tag_stacking;
  if (p.mvrpApplicant != null && f.mvrp_applicant_state !== p.mvrpApplicant) d.mvrp_applicant_state = f.mvrp_applicant_state;
  if (p.mvrpRegistrar != null && f.mvrp_registrar_state !== p.mvrpRegistrar) d.mvrp_registrar_state = f.mvrp_registrar_state;
  // Spanning tree: only what changed, and only settings the device reported.
  if (f.stp_priority.trim() && portPriorityValue(f.stp_priority) !== portPriorityValue(p.stpPriority ?? '')) d.stp_priority = f.stp_priority.trim();
  if (f.path_cost.trim() && f.path_cost.trim() !== (p.pathCost ?? '')) d.path_cost = f.path_cost.trim();
  // Emptied: back to RouterOS's own (it doesn't print the default).
  else if (!f.path_cost.trim() && p.pathCost) d.path_cost = 'default';
  if (p.edge != null && f.edge !== p.edge) d.edge = f.edge;
  if (p.pointToPoint != null && f.point_to_point !== p.pointToPoint) d.point_to_point = f.point_to_point;
  if (p.bpduGuard != null && f.bpdu_guard !== p.bpduGuard) d.bpdu_guard = f.bpdu_guard;
  if (p.restrictedRole != null && f.restricted_role !== p.restrictedRole) d.restricted_role = f.restricted_role;
  if (p.restrictedTcn != null && f.restricted_tcn !== p.restrictedTcn) d.restricted_tcn = f.restricted_tcn;
  return d;
};

/**
 * Layer 2 interfaces that aren't on the Ports tab's faceplate, so they're added
 * to a bridge here (#466): EoIP, VXLAN, VPLS, veth, VLAN and wireless.
 */
const OTHER_L2 = /^(eoip|vxlan|vpls|veth|vlan|wifi|wlan|l2tp-ether)/;
const ON_FACEPLATE = /^(ether|sfp|combo|bridge|bond)/i;

const EDGE_CHOICES = [
  { value: 'auto', label: 'Auto (edge until a BPDU arrives)' },
  { value: 'yes', label: 'Yes (end device: forward at once)' },
  { value: 'no', label: 'No (always a link to a switch)' },
  { value: 'yes-discover', label: 'Yes, but become non-edge on a BPDU' },
  { value: 'no-discover', label: 'No, but become edge without BPDUs' },
];

/**
 * Every bridge on the device (#284): its settings, ports (hardware-switched or
 * on the CPU), VLAN entries and addresses. Create, rename, change spanning
 * tree, turn VLAN filtering on or off, disable and delete, all through Change
 * Guard. Ethernet and SFP ports join or leave bridges on the Ports tab; other
 * layer 2 interfaces (EoIP, wireless...) are added here (#466).
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
  const [portEdit, setPortEdit] = useState<{ bridgeId: string; port: BridgePortView; form: PortForm } | null>(null);
  // The bridge whose addresses are open for editing (#466).
  const [addrFor, setAddrFor] = useState<string | null>(null);
  // A move refused because the interface has an address, awaiting a yes (#466).
  const [addrConfirm, setAddrConfirm] = useState<{ port: string; bridge: string; text: string } | null>(null);
  const { data: allIfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data),
    enabled: canWrite,
  });
  const otherL2 = allIfaces
    .filter((i) => OTHER_L2.test(i.type ?? '') && !ON_FACEPLATE.test(i.type ?? ''))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

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
    const d: { name?: string; protocol_mode?: string; priority?: string; comment?: string; disabled?: boolean; mtu?: string; ether_type?: string; mvrp?: boolean } = {};
    if (f.name.trim() !== b.name) d.name = f.name.trim();
    if (f.protocol_mode !== b.protocolMode) d.protocol_mode = f.protocol_mode;
    if (f.priority.trim() && f.priority.trim().toLowerCase() !== (b.priority ?? '').toLowerCase()) d.priority = f.priority.trim();
    if (f.comment !== (b.comment ?? '')) d.comment = f.comment;
    if (f.enabled !== !b.disabled) d.disabled = !f.enabled;
    const mtu = f.mtu.trim().toLowerCase() || 'auto';
    if (mtu !== (b.mtuSetting ?? 'auto')) d.mtu = mtu;
    if (b.etherType != null && f.ether_type !== b.etherType) d.ether_type = f.ether_type;
    if (b.mvrp != null && f.mvrp !== b.mvrp) d.mvrp = f.mvrp;
    return d;
  };
  const update = useMutation({
    mutationFn: ({ b, d, confirm = false }: { b: BridgeView; d: ReturnType<typeof changesOf>; confirm?: boolean }) =>
      devicesApi.updateBridge(deviceId, b.name, d, confirm),
    onSuccess: (r) => { setEditing(null); done(r); },
    onError: (e, v) => failed(() => update.mutate({ ...v, confirm: true }))(e),
  });
  const portUpdate = useMutation({
    mutationFn: ({ iface, d, confirm = false }: { iface: string; d: BridgePortUpdate; confirm?: boolean }) =>
      devicesApi.updateBridgePort(deviceId, iface, d, confirm),
    onSuccess: (r) => { setPortEdit(null); done(r); },
    onError: (e, v) => failed(() => portUpdate.mutate({ ...v, confirm: true }))(e),
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
  const move = useMutation({
    mutationFn: (v: { port: string; bridge: string | null; confirm_addresses?: boolean; confirm_lockout?: boolean }) =>
      devicesApi.moveBridgePorts(deviceId, { ports: [v.port], bridge: v.bridge, confirm_addresses: v.confirm_addresses, confirm_lockout: v.confirm_lockout }),
    onSuccess: (r) => {
      setAddrConfirm(null); setPortEdit(null);
      done({ data: { message: r.data.message, guard: r.data.guard as GuardResult | undefined } });
      void qc.invalidateQueries({ queryKey: ['interfaces', deviceId] });
    },
    onError: (e, v) => {
      const data = (e as { response?: { status?: number; data?: { code?: string; error?: string } } })?.response;
      if (data?.status === 409 && data.data?.code === 'ports_have_addresses' && v.bridge) {
        setAddrConfirm({ port: v.port, bridge: v.bridge, text: data.data.error ?? '' });
        return;
      }
      failed(() => move.mutate({ ...v, confirm_lockout: true }))(e);
    },
  });
  const busy = move.isPending || add.isPending || update.isPending || filtering.isPending || remove.isPending || portUpdate.isPending;

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
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">New Bridge</h3>
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
        const mtuErr = e ? bridgeMtuError(e.form.mtu, b) : null;
        const ceiling = bridgeMtuCeiling(b);
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
              <span className="text-xs text-gray-500 dark:text-slate-400 font-mono">{b.protocolMode.toUpperCase()}{b.priority ? ` · priority ${b.priority}` : ''}{b.mtu ? ` · MTU ${b.mtu}${b.mtuSetting && b.mtuSetting !== 'auto' ? '' : ' (auto)'}` : ''}</span>
              {b.etherType && b.etherType !== '0x8100' && (
                <span title={`The bridge reads ${b.etherType} as the VLAN tag`}
                  className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                  Q-in-Q {b.etherType}
                </span>
              )}
              {b.mvrp && (
                <span title="MVRP registers VLANs with its neighbours"
                  className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                  MVRP
                </span>
              )}
              {b.comment && <span className="text-xs text-gray-400">· {b.comment}</span>}
              {canWrite && !e && !b.dynamic && (
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" title="Edit" disabled={busy}
                    onClick={() => { setNote(null); setAdding(null); setPortEdit(null); setEditing({ bridge: b, form: { name: b.name, protocol_mode: b.protocolMode, priority: b.priority ?? '', comment: b.comment ?? '', enabled: !b.disabled, mtu: b.mtuSetting ?? 'auto', ether_type: b.etherType ?? '0x8100', mvrp: !!b.mvrp } }); }}
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
                <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
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
                  <div><label className="label">MTU</label>
                    <input className={clsx('input font-mono', mtuErr && 'border-red-400')} value={e.form.mtu} placeholder="auto"
                      title="auto follows the lowest MTU of the bridge's ports"
                      onChange={(ev) => setEditing({ ...e, form: { ...e.form, mtu: ev.target.value } })} />
                    <p className={clsx('text-[11px] mt-1', mtuErr ? 'text-red-600 dark:text-red-400' : 'text-gray-400')}>
                      {mtuErr ?? `auto, or up to ${ceiling ?? 'the ports\u2019 L2 MTU'}${b.mtu ? ` · now ${b.mtu}` : ''}. Only the router\u2019s own traffic on the bridge; ports switch jumbo frames on their own MTUs.`}
                    </p></div>
                </div>
                {b.etherType == null && (
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    Q-in-Q (the VLAN tag type) and MVRP are VLAN filtering settings: RouterOS only shows them with VLAN
                    filtering on. Turn it on to see and change them.
                  </p>
                )}
                {b.etherType != null && <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2"><label className="label">VLAN tag (EtherType)</label>
                    <select className="input" value={e.form.ether_type} onChange={(ev) => setEditing({ ...e, form: { ...e.form, ether_type: ev.target.value } })}>
                      {ETHER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <p className="text-[11px] mt-1 text-gray-400">
                      Which tag the bridge reads as the VLAN, in effect with VLAN filtering on. With 0x88a8 a customer&apos;s
                      802.1Q tags pass through inside the service VLAN; a VLAN interface on the bridge then needs
                      &ldquo;Service tag&rdquo; ticked. Some switch chips only do 0x8100 in hardware and switch the rest on the CPU.
                    </p></div>
                  {b.mvrp != null && (
                    <div><label className="label">MVRP</label>
                      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 mt-2">
                        <input type="checkbox" checked={e.form.mvrp} onChange={(ev) => setEditing({ ...e, form: { ...e.form, mvrp: ev.target.checked } })} />
                        Register VLANs with neighbours
                      </label>
                      <p className="text-[11px] mt-1 text-gray-400">
                        A VLAN a neighbour registers makes that port a tagged member of it, dynamically.
                      </p></div>
                  )}
                </div>}
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                  <input type="checkbox" checked={e.form.enabled} onChange={(ev) => setEditing({ ...e, form: { ...e.form, enabled: ev.target.checked } })} />
                  Enabled
                </label>
                <p className="text-xs text-gray-400">
                  Renaming keeps the bridge&apos;s ports, VLANs and addresses. Changing spanning tree reconverges the bridge;
                  on the bridge the manager connects through, both run with auto-revert. Disabling that bridge is predicted
                  as a lockout and asks first. An MTU change on that bridge also runs with auto-revert. The bridge&apos;s MTU is
                  for the router&apos;s own address, routing and VLAN interfaces on it; jumbo frames switched between ports
                  only need those ports&apos; MTU raised on the Ports tab. Changing the VLAN tag or MVRP on that bridge
                  runs with auto-revert too.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => update.mutate({ b, d: changesOf(b, e.form) })} disabled={busy || pending === 0 || !e.form.name.trim() || !!mtuErr}
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
                    {b.ports.map((p) => {
                      const editable = canWrite && !p.dynamic && !b.dynamic;
                      const open = portEdit?.bridgeId === b.id && portEdit.port.name === p.name;
                      return (
                        <button type="button" key={p.name} disabled={!editable || busy}
                          onClick={() => { setNote(null); setEditing(null); setPortEdit(open ? null : { bridgeId: b.id, port: p, form: portFormOf(p) }); }}
                          title={[p.hw ? 'Switched by the switch chip' : 'Switched by the CPU', p.pvid ? `PVID ${p.pvid}` : '', p.role ?? '',
                            p.tagStacking ? 'tag stacking' : '', p.mvrpRegistrar === 'fixed' ? 'MVRP registrar fixed' : '',
                            p.mvrpApplicant === 'non-participant' ? 'MVRP non-participant' : '',
                            p.bpduGuard ? 'BPDU guard' : '', p.restrictedRole ? 'restricted role' : '',
                            p.inactive ? 'inactive' : '', p.disabled ? 'disabled' : '', editable ? 'Click for spanning tree, tag stacking and MVRP' : ''].filter(Boolean).join(' · ')}
                          className={clsx('px-1.5 py-0.5 rounded font-mono text-xs border disabled:cursor-default',
                            open ? 'border-blue-500 ring-1 ring-blue-500' : '',
                            p.disabled || p.inactive ? 'border-gray-200 text-gray-400 dark:border-slate-700' : 'border-gray-300 text-gray-700 dark:border-slate-600 dark:text-slate-200',
                            editable && 'enabled:hover:border-blue-400')}>
                          {p.name}{!p.hw && <Cpu className="w-3 h-3 inline ml-0.5 -mt-0.5 text-amber-500" />}
                          {p.tagStacking && <span className="ml-1 text-[9px] font-sans font-semibold text-indigo-600 dark:text-indigo-300">TS</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {canWrite && !b.dynamic && (() => {
                  const memberOf = (name: string) => bridges.find((x) => x.ports.some((p) => p.name === name));
                  const choices = otherL2.filter((i) => !b.ports.some((p) => p.name === i.name));
                  if (choices.length === 0) return null;
                  return (
                    <div className="mt-2">
                    <select className="input text-xs py-1 max-w-[16rem]" value="" disabled={busy} aria-label={`Add an interface to ${b.name}`}
                      onChange={(ev) => { const v = ev.target.value; if (!v) return; setNote(null); setAddrConfirm(null); move.mutate({ port: v, bridge: b.name }); }}>
                      <option value="">+ Add EoIP, wireless, VLAN…</option>
                      {choices.map((i) => {
                        const other = memberOf(i.name);
                        const dyn = other?.ports.find((p) => p.name === i.name)?.dynamic;
                        return (
                          <option key={i.name} value={i.name} disabled={!!dyn}>
                            {i.name} ({i.type}){other ? (dyn ? ` · added to ${other.name} automatically` : ` · moves from ${other.name}`) : ''}
                          </option>
                        );
                      })}
                    </select>
                    </div>
                  );
                })()}
                {addrConfirm?.bridge === b.name && (
                  <div className="mt-2 p-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 text-xs text-amber-800 dark:text-amber-300 space-y-1.5">
                    <p>{addrConfirm.text}</p>
                    <div className="flex gap-2">
                      <button type="button" className="btn-primary text-xs py-1" disabled={busy}
                        onClick={() => move.mutate({ port: addrConfirm.port, bridge: addrConfirm.bridge, confirm_addresses: true })}>
                        Add it anyway (with auto-revert)
                      </button>
                      <button type="button" className="btn-secondary text-xs py-1" onClick={() => setAddrConfirm(null)}>Cancel</button>
                    </div>
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
                {!!b.dynamicVlans?.length && (
                  <span className="text-xs text-gray-400" title="VLANs RouterOS added for a port's PVID or a wifi interface, with no entry of their own">
                    {' '}· {b.vlans.length > 0 ? 'also' : 'VLANs'} {b.dynamicVlans.join(', ')} (dynamic)
                  </span>
                )}
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mb-1">Addresses</div>
                {b.addresses.length ? <span className="font-mono text-xs text-gray-700 dark:text-slate-300">{b.addresses.join(', ')}</span> : <span className="text-gray-400">none</span>}
                {canWrite && !b.dynamic && (
                  <button type="button" className="ml-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    onClick={() => setAddrFor(addrFor === b.name ? null : b.name)}>
                    {addrFor === b.name ? 'Close' : b.addresses.length ? 'Edit' : 'Add one'}
                  </button>
                )}
                {b.mtu && <div className="text-xs text-gray-400 mt-1">MTU {b.mtu}{b.macAddress ? ` · ${b.macAddress}` : ''}</div>}
              </div>
            </div>

            {addrFor === b.name && (
              <div className="mt-3">
                <IpAddressesCard deviceId={deviceId} deviceName={deviceName || 'confirm'} iface={b.name} onChanged={refresh} />
              </div>
            )}

            {portEdit?.bridgeId === b.id && (() => {
              const pe = portEdit;
              const d = portChanges(pe.port, pe.form);
              const hasMvrp = pe.port.mvrpApplicant != null || pe.port.mvrpRegistrar != null;
              const hasStp = b.protocolMode !== 'none' && (pe.port.edge != null || pe.port.stpPriority != null);
              const prioErr = portPriorityError(pe.form.stp_priority);
              const costErr = pathCostError(pe.form.path_cost);
              const guardWarn = pe.form.bpdu_guard && !pe.port.bpduGuard ? bpduGuardWarning(pe.port.role) : null;
              const setF = (patch: Partial<PortForm>) => setPortEdit({ ...pe, form: { ...pe.form, ...patch } });
              return (
                <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-3">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Port <span className="font-mono">{pe.port.name}</span></h4>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                        <input type="checkbox" checked={pe.form.tag_stacking} onChange={(ev) => setPortEdit({ ...pe, form: { ...pe.form, tag_stacking: ev.target.checked } })} />
                        Tag stacking
                      </label>
                      <p className="text-[11px] mt-1 text-gray-400">
                        Every frame in is treated as untagged and gets the port&apos;s PVID{pe.port.pvid ? ` (${pe.port.pvid})` : ''} as an
                        outer tag, over any tag it had. Needs VLAN filtering and a VLAN entry for the PVID.
                      </p>
                    </div>
                    {hasMvrp && (<>
                      <div><label className="label">MVRP applicant</label>
                        <select className="input" value={pe.form.mvrp_applicant_state} onChange={(ev) => setPortEdit({ ...pe, form: { ...pe.form, mvrp_applicant_state: ev.target.value } })}>
                          <option value="normal-participant">Normal participant</option>
                          <option value="non-participant">Non-participant (sends nothing)</option>
                        </select></div>
                      <div><label className="label">MVRP registrar</label>
                        <select className="input" value={pe.form.mvrp_registrar_state} onChange={(ev) => setPortEdit({ ...pe, form: { ...pe.form, mvrp_registrar_state: ev.target.value } })}>
                          <option value="normal">Normal</option>
                          <option value="fixed">Fixed (ignores registrations, stays in its configured VLANs)</option>
                        </select></div>
                    </>)}
                  </div>
                  {hasStp && (
                    <div className="space-y-2 border-t border-gray-100 dark:border-slate-700 pt-3">
                      <div className="text-xs font-semibold text-gray-700 dark:text-slate-200">
                        Spanning Tree
                        <span className="ml-2 font-normal text-gray-400">
                          {[pe.port.role ? `${pe.port.role.replace(/-port$/, '')} port` : '', pe.port.edgePort ? 'running as an edge port' : ''].filter(Boolean).join(' · ') || 'not running yet'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div><label className="label">Port priority</label>
                          <input className={clsx('input font-mono', prioErr && 'border-red-400')} value={pe.form.stp_priority} placeholder="0x80"
                            onChange={(ev) => setF({ stp_priority: ev.target.value })} />
                          {prioErr && <p className="text-[11px] mt-1 text-red-500">{prioErr}</p>}</div>
                        <div><label className="label">Path cost</label>
                          <input className={clsx('input font-mono', costErr && 'border-red-400')} value={pe.form.path_cost} placeholder="default"
                            onChange={(ev) => setF({ path_cost: ev.target.value })} />
                          {costErr && <p className="text-[11px] mt-1 text-red-500">{costErr}</p>}</div>
                        <div><label className="label">Edge</label>
                          <select className="input" value={pe.form.edge} onChange={(ev) => setF({ edge: ev.target.value })}>
                            {EDGE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select></div>
                        <div><label className="label">Point-to-point</label>
                          <select className="input" value={pe.form.point_to_point} onChange={(ev) => setF({ point_to_point: ev.target.value })}>
                            <option value="auto">Auto (from duplex)</option>
                            <option value="yes">Yes</option>
                            <option value="no">No (shared segment)</option>
                          </select></div>
                      </div>
                      <p className="text-[11px] text-gray-400">
                        Between two links to the same switch, the lower path cost becomes the root port, then the lower priority.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                            <input type="checkbox" checked={pe.form.bpdu_guard} onChange={(ev) => setF({ bpdu_guard: ev.target.checked })} />
                            BPDU guard
                          </label>
                          <p className="text-[11px] mt-1 text-gray-400">Shuts the port if a BPDU arrives. For ports to end devices only.</p>
                          {guardWarn && <p className="text-[11px] mt-1 text-amber-600 dark:text-amber-400 flex gap-1"><AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />{guardWarn}</p>}
                        </div>
                        <div>
                          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                            <input type="checkbox" checked={pe.form.restricted_role} onChange={(ev) => setF({ restricted_role: ev.target.checked })} />
                            Restricted role
                          </label>
                          <p className="text-[11px] mt-1 text-gray-400">The port can never become the root port, so equipment beyond it can&apos;t take over as root.</p>
                        </div>
                        <div>
                          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300">
                            <input type="checkbox" checked={pe.form.restricted_tcn} onChange={(ev) => setF({ restricted_tcn: ev.target.checked })} />
                            Restricted TCN
                          </label>
                          <p className="text-[11px] mt-1 text-gray-400">Topology changes heard on the port aren&apos;t passed on, so they don&apos;t flush the network&apos;s MAC tables.</p>
                        </div>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-gray-400">On the port the manager connects through, these run with auto-revert.</p>
                  <div className="flex gap-2">
                    <button onClick={() => portUpdate.mutate({ iface: pe.port.name, d })} disabled={busy || Object.keys(d).length === 0 || !!prioErr || !!costErr}
                      className="btn-primary flex items-center gap-2 text-sm">
                      {portUpdate.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                    </button>
                    <button onClick={() => setPortEdit(null)} disabled={portUpdate.isPending} className="btn-secondary text-sm"><X className="w-3.5 h-3.5 inline mr-1" />Cancel</button>
                    <button onClick={() => { setNote(null); move.mutate({ port: pe.port.name, bridge: null }); }} disabled={busy}
                      title={`Take ${pe.port.name} out of ${b.name}`}
                      className="ml-auto btn-secondary text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
                      {move.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Remove from bridge
                    </button>
                  </div>
                </div>
              );
            })()}

            {b.mvrp && b.ports.some((p) => p.registeredVlans || p.declaredVlans) && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700">
                      <th className="table-header px-2 py-1.5 text-left">MVRP port</th>
                      <th className="table-header px-2 py-1.5 text-left">Registered VLANs</th>
                      <th className="table-header px-2 py-1.5 text-left">Declared VLANs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                    {b.ports.filter((p) => p.registeredVlans || p.declaredVlans).map((p) => (
                      <tr key={p.name}>
                        <td className="px-2 py-1 font-mono">{p.name}</td>
                        <td className="px-2 py-1 font-mono">{p.registeredVlans || '—'}</td>
                        <td className="px-2 py-1 font-mono">{p.declaredVlans || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
