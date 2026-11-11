import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { tagOf, logsUntagged, ruleLinesUrl } from '../../utils/ruleTags';
import QuickRulesModal from './QuickRulesModal';
import ZonesCard from './ZonesCard';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Pencil, Power, AlertCircle, RefreshCw, Check, X, ArrowRightLeft, Shield, Zap,
  ArrowUp, ArrowDown, List, Activity, Ban, ChevronDown, ChevronRight, ScrollText,
} from 'lucide-react';
import { devicesApi, zonesApi, type FirewallFamily, type QuickPreset } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { formatBytes, formatCount, ruleSummary, natSummary } from '../../utils/firewallSummary';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import clsx from 'clsx';

type Row = Record<string, string> & { '.id': string };

const COMMON_CHAINS = ['forward', 'input', 'output'];
const FW_ACTIONS    = ['accept', 'drop', 'reject', 'log', 'passthrough', 'jump', 'return'];
const PROTOCOLS     = ['tcp', 'udp', 'icmp', 'ip', 'gre', 'ospf'];
const PROTOCOLS_V6  = ['tcp', 'udp', 'icmpv6', 'gre', 'ospf'];
const CONN_STATES   = ['new', 'established', 'related', 'invalid'];
const PORT_PRESETS  = [
  { label: 'HTTPS', port: '443' }, { label: 'HTTP', port: '80' }, { label: 'SSH', port: '22' },
  { label: 'DNS', port: '53' }, { label: 'RDP', port: '3389' }, { label: 'SMB', port: '445' },
];

const ACTION_COLOR: Record<string, string> = {
  accept: 'text-green-600 dark:text-green-400', drop: 'text-red-600 dark:text-red-400',
  reject: 'text-red-500 dark:text-red-400', log: 'text-yellow-600 dark:text-yellow-400',
  passthrough: 'text-blue-600 dark:text-blue-400', jump: 'text-purple-600 dark:text-purple-400',
  return: 'text-indigo-500 dark:text-indigo-400', masquerade: 'text-orange-600 dark:text-orange-400',
  'src-nat': 'text-blue-600 dark:text-blue-400', 'dst-nat': 'text-cyan-600 dark:text-cyan-400',
  netmap: 'text-teal-600 dark:text-teal-400', redirect: 'text-violet-600 dark:text-violet-400',
};

const NAT_CHAINS  = ['srcnat', 'dstnat'];
const NAT_ACTIONS = ['masquerade', 'src-nat', 'dst-nat', 'netmap', 'redirect', 'accept', 'drop', 'return', 'jump', 'passthrough'];

function errMsg(err: unknown) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Operation failed';
}

/** The device has no such IPv6 menu (#312): the ipv6 package off, or no IPv6 NAT on RouterOS 6. */
function ipv6Unavailable(err: unknown): string | null {
  const d = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
  return d?.code === 'ipv6_unavailable' ? (d.error || 'IPv6 isn\u2019t available on this device.') : null;
}

/** Query keys per family; IPv4 keeps the keys other screens already use. */
const fwKey = (what: string, deviceId: number, family: FirewallFamily) =>
  family === 'ipv6' ? [what, deviceId, 'ipv6'] : [what, deviceId];

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium text-gray-700 dark:text-slate-300">{label}</label>
      <button type="button" onClick={() => onChange(!value)}
        className={clsx('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', value ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600')}>
        <span className={clsx('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', value ? 'translate-x-6' : 'translate-x-1')} />
      </button>
    </div>
  );
}

// ─── Firewall rule form ─────────────────────────────────────────────────────────
type Endpoint = 'any' | 'address' | 'list';
interface RuleForm {
  chain: string; action: string;
  src_kind: Endpoint; src_value: string;
  dst_kind: Endpoint; dst_value: string;
  protocol: string; src_port: string; dst_port: string;
  in_interface: string; out_interface: string;
  connection_state: string; jump_target: string;
  log: boolean; log_prefix: string;
  comment: string; disabled: boolean;
}
const EMPTY_FW: RuleForm = {
  chain: 'forward', action: 'accept', src_kind: 'any', src_value: '', dst_kind: 'any', dst_value: '',
  protocol: '', src_port: '', dst_port: '', in_interface: '', out_interface: '',
  connection_state: '', jump_target: '', log: false, log_prefix: '', comment: '', disabled: false,
};
function ruleToForm(r: Row): RuleForm {
  const srcKind: Endpoint = r['src-address-list'] ? 'list' : r['src-address'] ? 'address' : 'any';
  const dstKind: Endpoint = r['dst-address-list'] ? 'list' : r['dst-address'] ? 'address' : 'any';
  return {
    chain: r.chain ?? 'forward', action: r.action ?? 'accept',
    src_kind: srcKind, src_value: r['src-address-list'] || r['src-address'] || '',
    dst_kind: dstKind, dst_value: r['dst-address-list'] || r['dst-address'] || '',
    protocol: r.protocol ?? '', src_port: r['src-port'] ?? '', dst_port: r['dst-port'] ?? '',
    in_interface: r['in-interface'] ?? '', out_interface: r['out-interface'] ?? '',
    connection_state: r['connection-state'] ?? '', jump_target: r['jump-target'] ?? '',
    log: r.log === 'yes' || r.log === 'true', log_prefix: r['log-prefix'] ?? '',
    comment: r.comment ?? '', disabled: r.disabled === 'true',
  };
}
/**
 * The rule as RouterOS properties. When editing, a field left empty is sent as
 * '' so it is cleared on the device (P2-10); it used to be left out, and the
 * old value stayed while the UI showed it gone. Switching a source or
 * destination between an address and an address list clears the other one.
 */
function fwPayload(f: RuleForm, force = false, forEdit = false): Record<string, unknown> {
  const p: Record<string, unknown> = { chain: f.chain, action: f.action, disabled: f.disabled ? 'yes' : 'no' };
  const put = (key: string, value: string, use = true) => {
    if (use && value) Object.assign(p, { [key]: value });
    else if (forEdit) Object.assign(p, { [key]: '' });
  };
  put('src_address', f.src_value, f.src_kind === 'address');
  put('src_address_list', f.src_value, f.src_kind === 'list');
  put('dst_address', f.dst_value, f.dst_kind === 'address');
  put('dst_address_list', f.dst_value, f.dst_kind === 'list');
  put('protocol', f.protocol);
  put('src_port', f.src_port);
  put('dst_port', f.dst_port);
  put('in_interface', f.in_interface);
  put('out_interface', f.out_interface);
  put('connection_state', f.connection_state);
  if (f.action === 'jump' && f.jump_target) p.jump_target = f.jump_target;
  p.log = f.log ? 'yes' : 'no';
  put('log_prefix', f.log_prefix, f.log);
  put('comment', f.comment);
  if (force) p.force = true;
  return p;
}
// Mirror the form into a RouterOS-shaped object for the live summary preview.
function formToRuleish(f: RuleForm): Record<string, string> {
  return {
    action: f.action, protocol: f.protocol,
    'src-address': f.src_kind === 'address' ? f.src_value : '',
    'src-address-list': f.src_kind === 'list' ? f.src_value : '',
    'dst-address': f.dst_kind === 'address' ? f.dst_value : '',
    'dst-address-list': f.dst_kind === 'list' ? f.dst_value : '',
    'dst-port': f.dst_port, 'connection-state': f.connection_state,
    'in-interface': f.in_interface, 'out-interface': f.out_interface, 'jump-target': f.jump_target,
  };
}

// ─── Endpoint picker (Any / Address / List) ──────────────────────────────────────
function EndpointPicker({
  label, kind, value, onKind, onValue, lists, v6 = false,
}: {
  label: string; kind: Endpoint; value: string;
  onKind: (k: Endpoint) => void; onValue: (v: string) => void; lists: string[]; v6?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex gap-1 mb-1.5">
        {(['any', 'address', 'list'] as Endpoint[]).map(k => (
          <button key={k} type="button" onClick={() => onKind(k)}
            className={clsx('px-2.5 py-1 text-xs font-medium rounded-md border transition-colors capitalize',
              kind === k ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
            {k === 'list' ? 'Address List' : k}
          </button>
        ))}
      </div>
      {kind === 'address' && (
        <input className="input font-mono" value={value} onChange={e => onValue(e.target.value)} placeholder={v6 ? '2001:db8::/32' : '0.0.0.0/0'} />
      )}
      {kind === 'list' && (
        lists.length > 0 ? (
          <select className="input" value={value} onChange={e => onValue(e.target.value)}>
            <option value="">— choose list —</option>
            {lists.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        ) : (
          <input className="input" value={value} onChange={e => onValue(e.target.value)} placeholder="list name (none defined yet)" />
        )
      )}
    </div>
  );
}

// ─── Firewall Rule Modal ──────────────────────────────────────────────────────
function RuleModal({
  title, form, setForm, onSave, onReview, onClose, isPending, error, lists, family = 'ipv4',
}: {
  title: string; form: RuleForm; setForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  onSave: () => void; onReview?: () => Promise<unknown>; onClose: () => void; isPending: boolean; error: string; lists: string[];
  family?: FirewallFamily;
}) {
  const v6 = family === 'ipv6';
  const protocols = v6 ? PROTOCOLS_V6 : PROTOCOLS;
  const set = (k: keyof RuleForm, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));
  const toggleState = (s: string) => {
    const cur = form.connection_state ? form.connection_state.split(',').filter(Boolean) : [];
    set('connection_state', (cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]).join(','));
  };
  const states = form.connection_state ? form.connection_state.split(',').filter(Boolean) : [];
  const hasPorts = form.protocol === 'tcp' || form.protocol === 'udp' || form.protocol === '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-5">
          {/* Action chips */}
          <div>
            <label className="label">Action</label>
            <div className="flex flex-wrap gap-2">
              {[['accept', 'Allow'], ['drop', 'Drop'], ['reject', 'Reject']].map(([a, lbl]) => (
                <button key={a} type="button" onClick={() => set('action', a)}
                  className={clsx('px-3 py-1.5 text-sm font-semibold rounded-lg border transition-colors',
                    form.action === a
                      ? a === 'accept' ? 'bg-green-600 border-green-600 text-white'
                        : 'bg-red-600 border-red-600 text-white'
                      : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
                  {lbl}
                </button>
              ))}
              <select className="input w-auto text-sm" value={FW_ACTIONS.includes(form.action) && !['accept', 'drop', 'reject'].includes(form.action) ? form.action : ''}
                onChange={e => e.target.value && set('action', e.target.value)}>
                <option value="">Advanced…</option>
                {FW_ACTIONS.filter(a => !['accept', 'drop', 'reject'].includes(a)).map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Chain</label>
              <input list="fw-chains" className="input" value={form.chain} onChange={e => set('chain', e.target.value)} placeholder="forward" />
              <datalist id="fw-chains">{COMMON_CHAINS.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div>
              <label className="label">Protocol</label>
              <select className="input" value={form.protocol} onChange={e => set('protocol', e.target.value)}>
                <option value="">any</option>
                {protocols.map(p => <option key={p} value={p}>{p}</option>)}
                {form.protocol && !protocols.includes(form.protocol) && <option value={form.protocol}>{form.protocol}</option>}
              </select>
            </div>
          </div>
          {form.action === 'jump' && (
            <div><label className="label">Jump Target Chain</label>
              <input className="input" value={form.jump_target} onChange={e => set('jump_target', e.target.value)} placeholder="custom-chain" /></div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <EndpointPicker label="Source" kind={form.src_kind} value={form.src_value} v6={v6}
              onKind={k => set('src_kind', k)} onValue={v => set('src_value', v)} lists={lists} />
            <EndpointPicker label="Destination" kind={form.dst_kind} value={form.dst_value} v6={v6}
              onKind={k => set('dst_kind', k)} onValue={v => set('dst_value', v)} lists={lists} />
          </div>

          {hasPorts && (
            <div>
              <label className="label">Destination Port</label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {PORT_PRESETS.map(p => (
                  <button key={p.port} type="button" onClick={() => set('dst_port', p.port)}
                    className="px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:border-blue-400">
                    {p.label}
                  </button>
                ))}
              </div>
              <input className="input font-mono" value={form.dst_port} onChange={e => set('dst_port', e.target.value)} placeholder="443 or 1000-2000 (blank = any)" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">In Interface</label>
              <input className="input font-mono" value={form.in_interface} onChange={e => set('in_interface', e.target.value)} placeholder="(any)" /></div>
            <div><label className="label">Out Interface</label>
              <input className="input font-mono" value={form.out_interface} onChange={e => set('out_interface', e.target.value)} placeholder="(any)" /></div>
          </div>

          <div>
            <label className="label">Connection State</label>
            <div className="flex flex-wrap gap-2">
              {CONN_STATES.map(s => (
                <button key={s} type="button" onClick={() => toggleState(s)}
                  className={clsx('px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                    states.includes(s) ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>{s}</button>
              ))}
            </div>
          </div>

          <Toggle label="Log matches" value={form.log} onChange={v => set('log', v)} />
          <div><label className="label">Comment</label>
            <input className="input" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Optional description…" /></div>
          <Toggle label="Disabled" value={form.disabled} onChange={v => set('disabled', v)} />

          {/* Live plain-English preview */}
          <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-800 dark:text-blue-300">
            <span className="text-xs uppercase tracking-wide opacity-60">Preview</span>
            <div className="font-medium">{ruleSummary(formToRuleish(form))}</div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            {onReview && <ReviewChangesButton request={onReview} onApply={onSave} applyLabel="Save Rule" disabled={isPending} />}
            <button onClick={onSave} disabled={isPending} className="btn-primary flex items-center gap-2">
              {isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save Rule
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Address Lists section ───────────────────────────────────────────────────────
function AddressListsCard({ deviceId, deviceName, family }: { deviceId: number; deviceName?: string; family: FirewallFamily }) {
  const v6 = family === 'ipv6';
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [list, setList] = useState(''); const [address, setAddress] = useState(''); const [comment, setComment] = useState('');
  const [err, setErr] = useState('');

  const { data: entries = [] } = useQuery({
    queryKey: fwKey('address-lists', deviceId, family),
    queryFn: () => devicesApi.getAddressLists(deviceId, family).then(r => r.data as Row[]),
    retry: false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: fwKey('address-lists', deviceId, family) });

  // Guarded: the manager may be let in by one of these lists (P2-8).
  const guard = useGuardedWrite();
  const fail = (e: unknown) => setErr(errMsg(e));
  const addMut = useMutation({
    mutationFn: (confirm: boolean) => devicesApi.addAddressListEntry(deviceId, { list, address, comment: comment || undefined, ...(confirm ? { confirm_lockout: true } : {}) }, family),
    onSuccess: (res) => { invalidate(); guard.onSuccess(res); setAdding(false); setList(''); setAddress(''); setComment(''); setErr(''); },
  });
  const delMut = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => devicesApi.removeAddressListEntry(deviceId, id, confirm, family),
    onSuccess: (res) => { invalidate(); setErr(''); guard.onSuccess(res); },
  });
  // Turning an entry off without deleting it (Stanley, D85). Guarded like a
  // removal: disabling the entry that admits the manager locks it out too.
  const togMut = useMutation({
    mutationFn: ({ id, disabled, confirm }: { id: string; disabled: boolean; confirm?: boolean }) =>
      devicesApi.updateAddressListEntry(deviceId, id, { disabled, ...(confirm ? { confirm_lockout: true } : {}) }, family),
    onSuccess: (res) => { invalidate(); setErr(''); guard.onSuccess(res); },
  });
  const add = () => addMut.mutate(false, { onError: guard.onError(() => addMut.mutate(true, { onError: fail }), fail) });
  const remove = (id: string) => delMut.mutate({ id }, { onError: guard.onError(() => delMut.mutate({ id, confirm: true }, { onError: fail }), fail) });
  const toggle = (id: string, disabled: boolean) =>
    togMut.mutate({ id, disabled }, { onError: guard.onError(() => togMut.mutate({ id, disabled, confirm: true }, { onError: fail }), fail) });

  // A Map, not an object: a list named "constructor" or "__proto__" (names
  // come from the device) found Object.prototype and crashed the tab (U12).
  const grouped = new Map<string, Row[]>();
  for (const e of entries) {
    const k = e.list ?? '(none)';
    grouped.set(k, [...(grouped.get(k) ?? []), e]);
  }
  const listNames = [...grouped.keys()].sort();

  return (
    <div className="card overflow-hidden">
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={addMut.isPending || delMut.isPending || togMut.isPending} />
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 p-4 text-left">
        <div className="w-7 h-7 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg flex items-center justify-center flex-shrink-0">
          <List className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1">
          {v6 ? 'IPv6 Address Lists' : 'Address Lists'} <span className="text-gray-400 font-normal">({entries.length} entries, {listNames.length} lists)</span>
        </h3>
        <span className="text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Reusable address objects. Reference a list from any firewall rule&apos;s Source/Destination instead of repeating IPs.
          </p>
          {err && !adding && <p className="text-xs text-red-500">{err}</p>}
          {listNames.length === 0 ? (
            <div className="text-sm text-gray-400 py-3 text-center">No address lists yet.</div>
          ) : listNames.map(name => (
            <div key={name} className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 text-xs font-semibold text-gray-700 dark:text-slate-200 font-mono">{name}</div>
              <div className="divide-y divide-gray-100 dark:divide-slate-700/50">
                {(grouped.get(name) ?? []).map(e => {
                  const off = e.disabled === 'true';
                  const busy = togMut.isPending && togMut.variables?.id === e['.id'];
                  return (
                    <div key={e['.id']} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className={clsx('font-mono', off ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-slate-300')}>{e.address}</span>
                      {e.comment && <span className="text-gray-400 italic truncate">{e.comment}</span>}
                      {off && <span className="text-gray-400 text-[10px] uppercase tracking-wide">disabled</span>}
                      {e.dynamic === 'true' && <span className="text-amber-500 text-[10px]">dynamic</span>}
                      {canWrite && e.dynamic !== 'true' && (
                        <div className="ml-auto flex items-center gap-2">
                          <button onClick={() => toggle(e['.id'], !off)} disabled={busy}
                            title={off ? 'Enable this entry' : 'Disable this entry (it stays in the list)'}
                            className={clsx('disabled:opacity-40', off ? 'text-gray-400 hover:text-green-600' : 'text-green-600 hover:text-gray-500')}>
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => remove(e['.id'])} title="Remove this entry" className="text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {canWrite && (adding ? (
            <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className="input" value={list} onChange={e => setList(e.target.value)} placeholder="list name (e.g. Trusted)" list="al-names" />
                <datalist id="al-names">{listNames.map(n => <option key={n} value={n} />)}</datalist>
                <input className="input font-mono" value={address} onChange={e => setAddress(e.target.value)} placeholder={v6 ? '2001:db8::/48' : '192.168.1.0/24 or host'} />
              </div>
              <input className="input" value={comment} onChange={e => setComment(e.target.value)} placeholder="comment (optional)" />
              {err && <p className="text-xs text-red-500">{err}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => { setAdding(false); setErr(''); }} className="btn-secondary text-xs py-1">Cancel</button>
                <button onClick={add} disabled={!list || !address || addMut.isPending} className="btn-primary text-xs py-1">Add Entry</button>
                <ReviewChangesButton className="text-xs py-1" deviceName={deviceName} applyLabel="Add Entry" onApply={add} disabled={!list || !address || addMut.isPending}
                  request={() => devicesApi.addAddressListEntry(deviceId, { list, address, comment: comment || undefined }, family)} />
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="btn-secondary text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Add entry</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Banned addresses (#405) ──────────────────────────────────────────────────

/**
 * What brute-force protection has banned (the mtm-banned list), with the time
 * left. Unban removes the entry; Never ban also adds the address to the
 * exempt list first, so it isn't counted again.
 */
function BannedCard({ deviceId, deviceName, entries, protectedHere, onQuick }: {
  deviceId: number; deviceName?: string; entries: Row[]; protectedHere: boolean; onQuick?: (preset?: QuickPreset) => void;
}) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const guard = useGuardedWrite();
  const [err, setErr] = useState('');
  const banned = entries.filter((e) => e.list === 'mtm-banned');
  const invalidate = () => qc.invalidateQueries({ queryKey: fwKey('address-lists', deviceId, 'ipv4') });
  const fail = (e: unknown) => setErr(errMsg(e));
  const unban = useMutation({
    mutationFn: async ({ e, exempt, confirm }: { e: Row; exempt: boolean; confirm?: boolean }) => {
      if (exempt) {
        await devicesApi.addAddressListEntry(deviceId, { list: 'mtm-bf-exempt', address: e.address, comment: 'mtm: never ban', ...(confirm ? { confirm_lockout: true } : {}) });
      }
      return devicesApi.removeAddressListEntry(deviceId, e['.id'], confirm);
    },
    onSuccess: (res) => { invalidate(); setErr(''); guard.onSuccess(res); },
  });
  const run = (e: Row, exempt: boolean) =>
    unban.mutate({ e, exempt }, { onError: guard.onError(() => unban.mutate({ e, exempt, confirm: true }, { onError: fail }), fail) });

  if (!protectedHere && banned.length === 0) return null;
  return (
    <div className="card p-4 space-y-2">
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={unban.isPending} />
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-red-50 dark:bg-red-900/20 rounded-lg flex items-center justify-center flex-shrink-0">
          <Ban className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1">
          Banned <span className="text-gray-400 font-normal">({banned.length})</span>
        </h3>
        {!protectedHere && onQuick && (
          <button onClick={() => onQuick('brute-force')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Brute-force protection isn&apos;t set up here</button>
        )}
      </div>
      {err && <p className="text-xs text-red-500">{err}</p>}
      {banned.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-slate-400">Nothing banned. Brute-force protection bans an address that opens four new connections to a protected port within a few minutes.</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-slate-700/50 border border-gray-200 dark:border-slate-700 rounded-lg">
          {banned.map((e) => (
            <div key={e['.id']} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <span className="font-mono text-gray-800 dark:text-slate-200">{e.address}</span>
              <span className="text-gray-400">{e.timeout ? `${e.timeout} left` : 'until removed'}</span>
              {e['creation-time'] && <span className="text-gray-400 hidden sm:inline">since {e['creation-time']}</span>}
              {canWrite && (
                <div className="ml-auto flex items-center gap-3">
                  <button onClick={() => run(e, false)} disabled={unban.isPending} className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40">Unban</button>
                  <button onClick={() => run(e, true)} disabled={unban.isPending} title="Unban, and add to mtm-bf-exempt so it's never counted again"
                    className="text-gray-500 hover:text-gray-800 dark:hover:text-slate-200 disabled:opacity-40">Never ban</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Counters cell ────────────────────────────────────────────────────────────
function Counters({ r }: { r: Row }) {
  const bytes = Number(r.bytes || 0); const packets = Number(r.packets || 0);
  if (packets === 0) return <span className="text-[11px] text-gray-300 dark:text-slate-600" title="No packets matched — possible dead rule">0</span>;
  return (
    <span className="text-[11px] text-gray-500 dark:text-slate-400" title={`${packets} packets / ${bytes} bytes`}>
      {formatCount(packets)} pkts<br /><span className="text-gray-400">{formatBytes(bytes)}</span>
    </span>
  );
}

// ─── Reusable rule table with reorder ────────────────────────────────────────────
function RuleTable({
  rows, fullOrder, canWrite, canReorder, summaryFn, onEdit, onToggle, onDelete, onMove, deviceId, highlight,
}: {
  rows: Row[]; fullOrder: Row[]; canWrite: boolean; canReorder: boolean;
  /** For links to a rule's log lines (#369). */
  deviceId: number;
  /** The tag of a rule to pick out, from a log line's link. */
  highlight?: string | null;
  summaryFn: (r: Row) => string;
  onEdit: (r: Row) => void; onToggle: (r: Row) => void; onDelete: (r: Row) => void;
  onMove: (r: Row, dir: 'up' | 'down') => void;
}) {
  const picked = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => { picked.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlight, rows.length]);
  return (
    <div className="card overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
            <th className="table-header px-3 py-2.5 text-left w-8">#</th>
            <th className="table-header px-3 py-2.5 text-left">Action</th>
            <th className="table-header px-3 py-2.5 text-left">Rule</th>
            <th className="table-header px-3 py-2.5 text-left w-20">Hits</th>
            <th className="table-header px-3 py-2.5 text-left">Comment</th>
            {canWrite && <th className="table-header px-3 py-2.5 w-32" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
          {rows.map((r, i) => {
            const disabled = r.disabled === 'true';
            const fullIdx = fullOrder.findIndex(x => x['.id'] === r['.id']);
            const tag = tagOf(r['log-prefix']);
            const isPicked = !!tag && tag === highlight;
            return (
              <tr key={r['.id'] ?? i} ref={isPicked ? picked : undefined}
                className={clsx('hover:bg-gray-50 dark:hover:bg-slate-700/30', disabled && 'opacity-40', isPicked && 'ring-2 ring-inset ring-blue-500 bg-blue-50/60 dark:bg-blue-900/20')}>
                <td className="px-3 py-2 text-gray-400 text-xs">{fullIdx >= 0 ? fullIdx + 1 : i + 1}</td>
                <td className={clsx('px-3 py-2 text-xs font-bold uppercase', ACTION_COLOR[r.action] ?? 'text-gray-500')}>
                  {r.action}{r['jump-target'] ? ` → ${r['jump-target']}` : ''}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600 dark:text-slate-300 font-mono max-w-[320px]" title={summaryFn(r)}>
                  <div className="truncate"><span className="text-gray-400">{r.chain}</span> · {summaryFn(r)}</div>
                  {tag && (
                    <Link to={ruleLinesUrl(deviceId, tag)} title="This rule's log lines, on Firewall Events"
                      className="inline-block mt-0.5 px-1.5 rounded bg-gray-100 dark:bg-slate-700 text-[10px] text-gray-500 dark:text-slate-300 hover:text-blue-600">
                      mtm#{tag} · log lines
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2"><Counters r={r} /></td>
                <td className="px-3 py-2 text-xs text-gray-400 dark:text-slate-500 italic max-w-[120px] truncate">{r.comment || ''}</td>
                {canWrite && (
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-0.5 justify-end">
                      {canReorder && (
                        <>
                          <button disabled={fullIdx <= 0} onClick={() => onMove(r, 'up')} title="Move up"
                            className="p-1 rounded text-gray-400 hover:text-blue-500 disabled:opacity-20"><ArrowUp className="w-3.5 h-3.5" /></button>
                          <button disabled={fullIdx >= fullOrder.length - 1} onClick={() => onMove(r, 'down')} title="Move down"
                            className="p-1 rounded text-gray-400 hover:text-blue-500 disabled:opacity-20"><ArrowDown className="w-3.5 h-3.5" /></button>
                        </>
                      )}
                      <button title={disabled ? 'Enable' : 'Disable'} onClick={() => onToggle(r)}
                        className={clsx('p-1 rounded', disabled ? 'text-gray-400 hover:text-green-500' : 'text-green-500')}>
                        <span className={clsx('inline-block w-2 h-2 rounded-full', disabled ? 'bg-gray-400' : 'bg-green-500')} />
                      </button>
                      <button onClick={() => onEdit(r)} className="p-1 rounded text-gray-400 hover:text-blue-500"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => onDelete(r)} className="p-1 rounded text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
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

// Compute the RouterOS `destination` (.id to place before) for an up/down move.
function moveDestination(fullOrder: Row[], r: Row, dir: 'up' | 'down'): { ok: boolean; destination?: string } {
  const idx = fullOrder.findIndex(x => x['.id'] === r['.id']);
  if (idx < 0) return { ok: false };
  if (dir === 'up') {
    if (idx === 0) return { ok: false };
    return { ok: true, destination: fullOrder[idx - 1]['.id'] };
  }
  if (idx >= fullOrder.length - 1) return { ok: false };
  if (idx + 2 <= fullOrder.length - 1) return { ok: true, destination: fullOrder[idx + 2]['.id'] };
  return { ok: true }; // moving to the very end → no destination
}

// ─── NAT wizard form ─────────────────────────────────────────────────────────────
type NatPattern = 'port-forward' | 'masquerade' | 'one-to-one' | 'custom';
interface NatForm {
  pattern: NatPattern; chain: string; action: string;
  src_address: string; dst_address: string; protocol: string; src_port: string; dst_port: string;
  in_interface: string; out_interface: string; to_addresses: string; to_ports: string;
  comment: string; disabled: boolean;
}
const EMPTY_NAT: NatForm = {
  pattern: 'port-forward', chain: 'dstnat', action: 'dst-nat',
  src_address: '', dst_address: '', protocol: 'tcp', src_port: '', dst_port: '',
  in_interface: '', out_interface: '', to_addresses: '', to_ports: '', comment: '', disabled: false,
};
function natRuleToForm(r: Row): NatForm {
  const action = r.action ?? 'masquerade';
  const pattern: NatPattern = action === 'dst-nat' ? 'port-forward' : action === 'masquerade' ? 'masquerade' : action === 'netmap' ? 'one-to-one' : 'custom';
  return {
    pattern, chain: r.chain ?? 'srcnat', action,
    src_address: r['src-address'] ?? '', dst_address: r['dst-address'] ?? '', protocol: r.protocol ?? '',
    src_port: r['src-port'] ?? '', dst_port: r['dst-port'] ?? '', in_interface: r['in-interface'] ?? '',
    out_interface: r['out-interface'] ?? '', to_addresses: r['to-addresses'] ?? '', to_ports: r['to-ports'] ?? '',
    comment: r.comment ?? '', disabled: r.disabled === 'true',
  };
}
/** The NAT rule as RouterOS properties; when editing, an emptied field is sent as '' to clear it. */
function natPayload(f: NatForm, forEdit = false): Record<string, unknown> {
  const p: Record<string, unknown> = { chain: f.chain, action: f.action, disabled: f.disabled ? 'yes' : 'no' };
  for (const [k, ros] of [['src_address', 'src_address'], ['dst_address', 'dst_address'], ['protocol', 'protocol'],
    ['src_port', 'src_port'], ['dst_port', 'dst_port'], ['in_interface', 'in_interface'], ['out_interface', 'out_interface'],
    ['to_addresses', 'to_addresses'], ['to_ports', 'to_ports'], ['comment', 'comment']] as const) {
    const v = new Map(Object.entries(f)).get(k) as string | undefined;
    if (v) Object.assign(p, { [ros]: v });
    else if (forEdit) Object.assign(p, { [ros]: '' });
  }
  return p;
}

function NatModal({ title, form, setForm, onSave, onReview, onClose, isPending, error, v6 = false }: {
  title: string; form: NatForm; setForm: React.Dispatch<React.SetStateAction<NatForm>>;
  onSave: () => void; onReview?: () => Promise<unknown>; onClose: () => void; isPending: boolean; error: string; v6?: boolean;
}) {
  const set = (k: keyof NatForm, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));
  const setPattern = (pattern: NatPattern) => setForm(f => {
    if (pattern === 'port-forward') return { ...f, pattern, chain: 'dstnat', action: 'dst-nat', protocol: f.protocol || 'tcp' };
    if (pattern === 'masquerade')  return { ...f, pattern, chain: 'srcnat', action: 'masquerade' };
    if (pattern === 'one-to-one')  return { ...f, pattern, chain: 'dstnat', action: 'netmap' };
    return { ...f, pattern };
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <label className="label">Pattern</label>
            <div className="grid grid-cols-2 gap-2">
              {([['port-forward', 'Port Forward'], ['masquerade', 'Masquerade (Internet sharing)'], ['one-to-one', '1:1 NAT'], ['custom', 'Custom']] as [NatPattern, string][]).map(([p, lbl]) => (
                <button key={p} type="button" onClick={() => setPattern(p)}
                  className={clsx('px-3 py-2 text-sm font-medium rounded-lg border text-left transition-colors',
                    form.pattern === p ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-300')}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {form.pattern === 'port-forward' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Protocol</label>
                  <select className="input" value={form.protocol} onChange={e => set('protocol', e.target.value)}>
                    <option value="tcp">tcp</option><option value="udp">udp</option></select></div>
                <div><label className="label">External Port</label>
                  <input className="input font-mono" value={form.dst_port} onChange={e => set('dst_port', e.target.value)} placeholder="443" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Internal Host</label>
                  <input className="input font-mono" value={form.to_addresses} onChange={e => set('to_addresses', e.target.value)} placeholder={v6 ? '2001:db8::10' : '192.168.1.10'} /></div>
                <div><label className="label">Internal Port</label>
                  <input className="input font-mono" value={form.to_ports} onChange={e => set('to_ports', e.target.value)} placeholder="443" /></div>
              </div>
              <div><label className="label">WAN In-Interface (optional)</label>
                <input className="input font-mono" value={form.in_interface} onChange={e => set('in_interface', e.target.value)} placeholder="ether1" /></div>
            </div>
          )}
          {form.pattern === 'masquerade' && (
            <div className="space-y-3">
              <div><label className="label">WAN Out-Interface</label>
                <input className="input font-mono" value={form.out_interface} onChange={e => set('out_interface', e.target.value)} placeholder="ether1" /></div>
              <div><label className="label">Source (optional, limits which LAN is shared)</label>
                <input className="input font-mono" value={form.src_address} onChange={e => set('src_address', e.target.value)} placeholder={v6 ? 'fd00::/64' : '192.168.1.0/24'} /></div>
            </div>
          )}
          {form.pattern === 'one-to-one' && (
            <div className="space-y-3">
              <div><label className="label">Public Address</label>
                <input className="input font-mono" value={form.dst_address} onChange={e => set('dst_address', e.target.value)} placeholder={v6 ? '2001:db8::10' : '203.0.113.10'} /></div>
              <div><label className="label">Internal Address</label>
                <input className="input font-mono" value={form.to_addresses} onChange={e => set('to_addresses', e.target.value)} placeholder={v6 ? 'fd00::10' : '192.168.1.10'} /></div>
              <div><label className="label">WAN In-Interface (optional)</label>
                <input className="input font-mono" value={form.in_interface} onChange={e => set('in_interface', e.target.value)} placeholder="ether1" /></div>
            </div>
          )}
          {form.pattern === 'custom' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Chain</label>
                  <select className="input" value={form.chain} onChange={e => set('chain', e.target.value)}>{NAT_CHAINS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className="label">Action</label>
                  <select className="input" value={form.action} onChange={e => set('action', e.target.value)}>{NAT_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Src Address</label><input className="input font-mono" value={form.src_address} onChange={e => set('src_address', e.target.value)} /></div>
                <div><label className="label">Dst Address</label><input className="input font-mono" value={form.dst_address} onChange={e => set('dst_address', e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">To Addresses</label><input className="input font-mono" value={form.to_addresses} onChange={e => set('to_addresses', e.target.value)} /></div>
                <div><label className="label">To Ports</label><input className="input font-mono" value={form.to_ports} onChange={e => set('to_ports', e.target.value)} /></div>
              </div>
              {/* With several uplinks, a netmap or src-nat must name its WAN, as masquerade does (#440). */}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">In. Interface</label>
                  <input className="input font-mono" value={form.in_interface} onChange={e => set('in_interface', e.target.value)} placeholder={form.chain === 'dstnat' ? 'ether1' : ''} /></div>
                <div><label className="label">Out. Interface</label>
                  <input className="input font-mono" value={form.out_interface} onChange={e => set('out_interface', e.target.value)} placeholder={form.chain === 'srcnat' ? 'ether1' : ''} /></div>
              </div>
            </div>
          )}

          <div><label className="label">Comment</label>
            <input className="input" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Optional description…" /></div>
          <Toggle label="Disabled" value={form.disabled} onChange={v => set('disabled', v)} />

          <div className="p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 text-sm text-orange-800 dark:text-orange-300">
            <span className="text-xs uppercase tracking-wide opacity-60">Preview</span>
            <div className="font-medium">{natSummary({
              action: form.action, chain: form.chain, protocol: form.protocol, 'dst-port': form.dst_port,
              'dst-address': form.dst_address, 'src-address': form.src_address, 'in-interface': form.in_interface,
              'out-interface': form.out_interface, 'to-addresses': form.to_addresses, 'to-ports': form.to_ports,
            })}</div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            {onReview && <ReviewChangesButton request={onReview} onApply={onSave} applyLabel="Save Rule" disabled={isPending} />}
            <button onClick={onSave} disabled={isPending} className="btn-primary flex items-center gap-2">
              {isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save Rule
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── NAT Card ────────────────────────────────────────────────────────────────────
function NatCard({ deviceId, family, highlight }: { deviceId: number; family: FirewallFamily; highlight?: string | null }) {
  const v6 = family === 'ipv6';
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState<Row | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<NatForm>(EMPTY_NAT);
  const [err, setErr] = useState('');

  const { data: rules = [], isLoading, refetch, isFetching, error: loadError } = useQuery({
    queryKey: fwKey('nat', deviceId, family), queryFn: () => devicesApi.getNat(deviceId, family).then(r => r.data as Row[]),
    retry: false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: fwKey('nat', deviceId, family) });

  const addMut = useMutation({ mutationFn: (d: Record<string, unknown>) => devicesApi.addNatRule(deviceId, d, family),
    onSuccess: () => { invalidate(); setShowAdd(false); setErr(''); }, onError: e => setErr(errMsg(e)) });
  const updMut = useMutation({ mutationFn: ({ id, d }: { id: string; d: Record<string, unknown> }) => devicesApi.updateNatRule(deviceId, id, d, family),
    onSuccess: () => { invalidate(); setEditing(null); setErr(''); }, onError: e => setErr(errMsg(e)) });
  const delMut = useMutation({ mutationFn: (id: string) => devicesApi.deleteNatRule(deviceId, id, family), onSuccess: invalidate });
  const toggleMut = useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => devicesApi.updateNatRule(deviceId, id, { disabled: disabled ? 'yes' : 'no' }, family), onSuccess: invalidate });
  const moveMut = useMutation({ mutationFn: ({ id, destination }: { id: string; destination?: string }) => devicesApi.moveNatRule(deviceId, id, destination, family), onSuccess: invalidate });
  const unavailable = ipv6Unavailable(loadError);

  const onMove = (r: Row, dir: 'up' | 'down') => { const d = moveDestination(rules, r, dir); if (d.ok) moveMut.mutate({ id: r['.id'], destination: d.destination }); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-orange-50 dark:bg-orange-900/20 rounded-lg flex items-center justify-center"><ArrowRightLeft className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" /></div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{v6 ? 'IPv6 NAT' : 'NAT'} <span className="text-gray-400 font-normal">({rules.length})</span></h3>
        </div>
        {!unavailable && <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh</button>
          {canWrite && <button onClick={() => { setForm(EMPTY_NAT); setErr(''); setShowAdd(true); }} className="btn-primary flex items-center gap-1.5 text-xs py-1.5"><Plus className="w-3.5 h-3.5" /> Add NAT</button>}
        </div>}
      </div>
      {err && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{err}</div>}
      {unavailable ? <div className="card p-6 text-center text-sm text-gray-400">{unavailable}</div>
        : isLoading ? <div className="text-center py-6 text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
        : rules.length === 0 ? <div className="card p-8 text-center text-gray-400">No {v6 ? 'IPv6 ' : ''}NAT rules.</div>
        : <RuleTable rows={rules} fullOrder={rules} canWrite={canWrite} canReorder summaryFn={natSummary} deviceId={deviceId} highlight={highlight}
            onEdit={r => { setForm(natRuleToForm(r)); setErr(''); setEditing(r); }}
            onToggle={r => toggleMut.mutate({ id: r['.id'], disabled: !(r.disabled === 'true') })}
            onDelete={r => { if (confirm('Delete this NAT rule?')) delMut.mutate(r['.id']); }} onMove={onMove} />}
      {showAdd && <NatModal title={v6 ? 'Add IPv6 NAT Rule' : 'Add NAT Rule'} form={form} setForm={setForm} isPending={addMut.isPending} error={err} v6={v6}
        onClose={() => setShowAdd(false)} onSave={() => addMut.mutate(natPayload(form))} onReview={() => devicesApi.addNatRule(deviceId, natPayload(form), family)} />}
      {editing && <NatModal title={v6 ? 'Edit IPv6 NAT Rule' : 'Edit NAT Rule'} form={form} setForm={setForm} isPending={updMut.isPending} error={err} v6={v6}
        onClose={() => setEditing(null)} onSave={() => updMut.mutate({ id: editing['.id'], d: natPayload(form, true) })} onReview={() => devicesApi.updateNatRule(deviceId, editing['.id'], natPayload(form, true), family)} />}
    </div>
  );
}

// ─── Main FirewallTab ─────────────────────────────────────────────────────────────
/**
 * The Firewall tab: IPv4 or IPv6 (#312), the same three sections on
 * /ip/firewall or /ipv6/firewall. The body is keyed by family, so switching
 * replaces it whole, with its own queries and form state.
 */
export default function FirewallTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const canWrite = useCanWrite();
  // ?quick=input-basics[&family=ipv6] opens Quick rules (the Security tab links here).
  const [params, setParams] = useSearchParams();
  const linked = params.get('quick') as QuickPreset | null;
  const [familyChoice, setFamily] = useState<FirewallFamily | null>(null);
  const family: FirewallFamily = familyChoice ?? (params.get('family') === 'ipv6' ? 'ipv6' : 'ipv4');
  const [opened, setQuick] = useState<QuickPreset | 'open' | null>(null);
  // Follows the link as it changes, not only when the tab first appears.
  const quick = opened ?? (canWrite && linked ? linked : null);
  const closeQuick = () => {
    setQuick(null);
    if (params.get('quick')) { params.delete('quick'); params.delete('family'); setParams(params, { replace: true }); }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex bg-gray-100 dark:bg-slate-800 p-1 rounded-lg" role="tablist" aria-label="IP version">
          {(['ipv4', 'ipv6'] as FirewallFamily[]).map(f => (
            <button key={f} role="tab" aria-selected={family === f} onClick={() => setFamily(f)}
              className={clsx('px-4 py-1 text-xs font-semibold rounded-md transition-colors',
                family === f ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400')}>
              {f === 'ipv4' ? 'IPv4' : 'IPv6'}
            </button>
          ))}
        </div>
        {family === 'ipv6' && canWrite && (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Changes run with Change Guard&apos;s auto-revert. Lockouts aren&apos;t predicted for IPv6 rules, since the
            manager&apos;s own connection is checked over IPv4.
          </p>
        )}
      </div>
      <FirewallBody key={family} deviceId={deviceId} deviceName={deviceName} family={family} highlight={params.get('rule')}
        onQuick={canWrite ? (p?: QuickPreset) => setQuick(p ?? 'open') : undefined} />
      {quick && (
        <QuickRulesModal deviceId={deviceId} deviceName={deviceName} family={family}
          initial={quick === 'open' ? undefined : quick} onClose={closeQuick} />
      )}
    </div>
  );
}

const ADVANCED_KEY = 'mtm.firewall.zonesShowRules';

function FirewallBody({ deviceId, deviceName, family, onQuick, highlight }: { deviceId: number; deviceName?: string; family: FirewallFamily; onQuick?: (preset?: QuickPreset) => void; highlight?: string | null }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const v6 = family === 'ipv6';
  const [chainFilter, setChainFilter] = useState('all');
  // Only the rules that log (log=yes): the ones with lines on Firewall Logs.
  const [loggedOnly, setLoggedOnly] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<RuleForm>(EMPTY_FW);
  const [err, setErr] = useState('');
  // Every rule change runs under Change Guard. A predicted lockout comes back
  // as 409 with a verdict; confirming re-sends the same change with
  // confirm_lockout. That covers toggles, moves and deletes too, which used to
  // skip the check entirely.
  const guard = useGuardedWrite();

  const { data: rules = [], isLoading, refetch, isFetching, error: loadError } = useQuery({
    queryKey: fwKey('firewall', deviceId, family), queryFn: () => devicesApi.getFirewall(deviceId, family).then(r => r.data as Row[]),
    retry: false,
  });
  const { data: addrLists = [] } = useQuery({
    queryKey: fwKey('address-lists', deviceId, family), queryFn: () => devicesApi.getAddressLists(deviceId, family).then(r => r.data as Row[]),
    retry: false,
  });
  const listNames = Array.from(new Set(addrLists.map(e => e.list).filter(Boolean))).sort();
  // NAT rules too, from NatCard's query, to count the logging rules without a tag (#369).
  const { data: natRules = [] } = useQuery({
    queryKey: fwKey('nat', deviceId, family), queryFn: () => devicesApi.getNat(deviceId, family).then(r => r.data as Row[]),
    retry: false,
  });
  // Zones (#369) own the IPv4 filter table when they're on: the rules are shown but not edited here.
  const { data: zones } = useQuery({
    queryKey: ['firewall-zones', deviceId], queryFn: () => zonesApi.get(deviceId).then(r => r.data),
    retry: false, enabled: !v6,
  });
  const zoned = !v6 && !!zones?.enabled;
  const canEdit = canWrite && !zoned;
  // With zones on, the chains, jumps and returns behind them are detail most
  // people don't need (#369): they're folded away unless asked for, and the
  // choice is remembered. A link to one rule (from a log line) opens them.
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED_KEY) === '1');
  const toggleAdvanced = () => setAdvanced((a) => { localStorage.setItem(ADVANCED_KEY, a ? '0' : '1'); return !a; });
  const showRules = !zoned || advanced || !!highlight;
  const untagged = rules.filter(logsUntagged).length + natRules.filter(logsUntagged).length;
  const invalidate = () => qc.invalidateQueries({ queryKey: fwKey('firewall', deviceId, family) });
  const unavailable = v6 ? ipv6Unavailable(loadError) : null;
  const done = (res: unknown) => { invalidate(); setErr(''); guard.onSuccess(res); };
  const fail = (e: unknown) => setErr(errMsg(e));

  const addMut = useMutation({
    mutationFn: (d: Record<string, unknown>) => devicesApi.addFirewallRule(deviceId, d, family),
    onSuccess: (res) => { done(res); setShowAdd(false); },
  });
  const updMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Record<string, unknown> }) => devicesApi.updateFirewallRule(deviceId, id, d, family),
    onSuccess: (res) => { done(res); setEditing(null); },
  });
  const delMut = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => devicesApi.deleteFirewallRule(deviceId, id, confirm, family),
    onSuccess: done,
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, disabled, confirm }: { id: string; disabled: boolean; confirm?: boolean }) =>
      devicesApi.updateFirewallRule(deviceId, id, { disabled: disabled ? 'yes' : 'no', ...(confirm ? { confirm_lockout: true } : {}) }, family),
    onSuccess: done,
  });
  const moveMut = useMutation({
    mutationFn: ({ id, destination, confirm }: { id: string; destination?: string; confirm?: boolean }) =>
      devicesApi.moveFirewallRule(deviceId, id, destination, confirm, family),
    onSuccess: done,
  });
  const resetMut = useMutation({ mutationFn: () => devicesApi.resetFirewallCounters(deviceId, family), onSuccess: invalidate });
  const tagMut = useMutation({
    mutationFn: (confirm?: boolean) => devicesApi.tagLoggingRules(deviceId, family, confirm),
    onSuccess: (res) => { done(res); qc.invalidateQueries({ queryKey: fwKey('nat', deviceId, family) }); },
  });
  const tagAll = () => tagMut.mutate(false, { onError: guard.onError(() => tagMut.mutate(true, { onError: fail }), fail) });

  // Each action retries itself with the lockout confirmed if the user overrides.
  const submitAdd = () => {
    const d = fwPayload(form);
    addMut.mutate(d, { onError: guard.onError(() => addMut.mutate({ ...d, confirm_lockout: true }, { onError: fail }), fail) });
  };
  const submitEdit = () => {
    if (!editing) return;
    const id = editing['.id'];
    const d = fwPayload(form, false, true);
    updMut.mutate({ id, d }, { onError: guard.onError(() => updMut.mutate({ id, d: { ...d, confirm_lockout: true } }, { onError: fail }), fail) });
  };
  const toggle = (id: string, disabled: boolean) =>
    toggleMut.mutate({ id, disabled }, { onError: guard.onError(() => toggleMut.mutate({ id, disabled, confirm: true }, { onError: fail }), fail) });
  const remove = (id: string) =>
    delMut.mutate({ id }, { onError: guard.onError(() => delMut.mutate({ id, confirm: true }, { onError: fail }), fail) });
  const move = (id: string, destination?: string) =>
    moveMut.mutate({ id, destination }, { onError: guard.onError(() => moveMut.mutate({ id, destination, confirm: true }, { onError: fail }), fail) });
  const anyPending = addMut.isPending || updMut.isPending || delMut.isPending || toggleMut.isPending || moveMut.isPending || tagMut.isPending;

  const onMove = (r: Row, dir: 'up' | 'down') => { const d = moveDestination(rules, r, dir); if (d.ok) move(r['.id'], d.destination); };

  const allChains = ['all', ...Array.from(new Set(rules.map(r => r.chain).filter(Boolean))).sort()];
  const logs = (r: Row) => r.log === 'yes' || r.log === 'true';
  const byChain = chainFilter === 'all' ? rules : rules.filter(r => r.chain === chainFilter);
  const filtered = loggedOnly ? byChain.filter(logs) : byChain;
  const loggedCount = rules.filter(logs).length;

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;
  if (unavailable) return <div className="card p-8 text-center text-sm text-gray-500 dark:text-slate-400">{unavailable}</div>;

  return (
    <div className="space-y-4">
      {!v6 && <BannedCard deviceId={deviceId} deviceName={deviceName} entries={addrLists} onQuick={onQuick}
        protectedHere={rules.some((r) => r.chain === 'mtm-bruteforce')} />}
      <AddressListsCard deviceId={deviceId} deviceName={deviceName} family={family} />
      {!v6 && <ZonesCard deviceId={deviceId} deviceName={deviceName} onApplied={invalidate} />}

      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center"><Shield className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /></div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{v6 ? 'IPv6 Firewall Filter Rules' : 'Firewall Filter Rules'}</h3>
        {zoned && !highlight && (
          <button onClick={toggleAdvanced} aria-expanded={showRules}
            className="ml-auto flex items-center gap-1 text-xs text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">
            {showRules ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {showRules ? 'Hide RouterOS rules' : `Show RouterOS rules (${rules.length})`}
          </button>
        )}
      </div>

      {!showRules && (
        <div className="flex items-center gap-3 flex-wrap">
          <p className="flex-1 min-w-[16rem] text-xs text-gray-500 dark:text-slate-400">
            Zones above decide what is allowed. The {rules.length} RouterOS rules that carry them out (chains, jumps and returns) are
            hidden; <button onClick={toggleAdvanced} className="underline hover:text-gray-900 dark:hover:text-white">show them</button> to see
            exactly what is on the router.
          </p>
          {/* Masquerade is the one Quick rule zones leave open. */}
          {onQuick && <button onClick={() => onQuick()} title="Presets for the rules nearly every router needs"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><Zap className="w-3.5 h-3.5 text-amber-500" /> Quick rules</button>}
        </div>
      )}

      {showRules && <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-slate-800 p-1 rounded-lg flex-wrap">
          {allChains.map(c => (
            <button key={c} onClick={() => setChainFilter(c)}
              className={clsx('px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize',
                chainFilter === c ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400')}>
              {c === 'all' ? `All (${rules.length})` : `${c} (${rules.filter(r => r.chain === c).length})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLoggedOnly(v => !v)} title="Show only the rules that log (log=yes)" aria-pressed={loggedOnly}
            className={clsx('btn-secondary flex items-center gap-1.5 text-xs py-1.5', loggedOnly && 'ring-1 ring-blue-500 text-blue-600 dark:text-blue-400')}>
            <ScrollText className="w-3.5 h-3.5" /> Logged ({loggedCount})
          </button>
          {canWrite && <button onClick={() => resetMut.mutate()} disabled={resetMut.isPending} title="Reset hit counters"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><Activity className="w-3.5 h-3.5" /> Reset Counters</button>}
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh</button>
          {onQuick && <button onClick={() => onQuick()} title="Presets for the rules nearly every router needs"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><Zap className="w-3.5 h-3.5 text-amber-500" /> Quick rules</button>}
          {canEdit && <button onClick={() => { setForm({ ...EMPTY_FW, chain: chainFilter !== 'all' ? chainFilter : 'forward' }); setErr(''); setShowAdd(true); }}
            className="btn-primary flex items-center gap-1.5 text-xs py-1.5"><Plus className="w-3.5 h-3.5" /> Add Rule</button>}
        </div>
      </div>

      {(chainFilter !== 'all' || loggedOnly) && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> Switch to &quot;All&quot; and turn off &quot;Logged&quot; to reorder rules (order is global across chains).</p>
      )}
      {err && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{err}</div>}
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={anyPending} />
      {zoned && (
        <p className="text-xs text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Zones manage these rules: change them under Zones above, or turn zones off to edit them here.
        </p>
      )}
      {untagged > 0 && !zoned && (
        <div className="flex items-center gap-3 flex-wrap rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-gray-600 dark:text-slate-300">
          <span className="flex-1 min-w-[16rem]">
            {untagged} rule{untagged === 1 ? ' logs' : 's log'} without a tag, so {untagged === 1 ? 'its' : 'their'} log lines can&rsquo;t be traced back
            to {untagged === 1 ? 'it' : 'them'}. A tag goes at the end of the log prefix; nothing else changes.
          </span>
          {canWrite && <>
            <button onClick={tagAll} disabled={anyPending} className="btn-secondary text-xs py-1">Tag {untagged === 1 ? 'it' : `all ${untagged}`}</button>
            <ReviewChangesButton className="text-xs py-1" deviceName={deviceName} applyLabel="Tag rules" onApply={tagAll} disabled={anyPending}
              request={() => devicesApi.tagLoggingRules(deviceId, family)} />
          </>}
        </div>
      )}

      {filtered.length === 0 ? <div className="card p-8 text-center text-gray-400">No {loggedOnly ? 'logging ' : ''}{v6 ? 'IPv6 ' : ''}firewall rules{chainFilter !== 'all' ? ` in "${chainFilter}"` : ''}.</div>
        : <RuleTable rows={filtered} fullOrder={rules} canWrite={canEdit} canReorder={chainFilter === 'all' && !loggedOnly} summaryFn={ruleSummary} deviceId={deviceId} highlight={highlight}
            onEdit={r => { setForm(ruleToForm(r)); setErr(''); setEditing(r); }}
            onToggle={r => toggle(r['.id'], !(r.disabled === 'true'))}
            onDelete={r => { if (confirm('Delete this firewall rule?')) remove(r['.id']); }} onMove={onMove} />}
      </>}

      {showAdd && <RuleModal title={v6 ? 'Add IPv6 Firewall Rule' : 'Add Firewall Rule'} form={form} setForm={setForm} isPending={addMut.isPending} error={err} lists={listNames} family={family}
        onClose={() => setShowAdd(false)} onSave={submitAdd} onReview={() => devicesApi.addFirewallRule(deviceId, fwPayload(form), family)} />}
      {editing && <RuleModal title={v6 ? 'Edit IPv6 Firewall Rule' : 'Edit Firewall Rule'} form={form} setForm={setForm} isPending={updMut.isPending} error={err} lists={listNames} family={family}
        onClose={() => setEditing(null)} onSave={submitEdit} onReview={() => devicesApi.updateFirewallRule(deviceId, editing['.id'], fwPayload(form, false, true), family)} />}

      {/* NAT is available on all RouterOS devices */}
      <div className="border-t border-gray-200 dark:border-slate-700 pt-2" />
      <NatCard deviceId={deviceId} family={family} highlight={highlight} />
    </div>
  );
}
