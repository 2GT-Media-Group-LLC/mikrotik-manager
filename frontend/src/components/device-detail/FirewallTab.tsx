import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Pencil, AlertCircle, RefreshCw, Check, X, ArrowRightLeft, Shield,
  ArrowUp, ArrowDown, List, Activity,
} from 'lucide-react';
import { devicesApi } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { formatBytes, formatCount, ruleSummary, natSummary } from '../../utils/firewallSummary';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import clsx from 'clsx';

type Row = Record<string, string> & { '.id': string };

const COMMON_CHAINS = ['forward', 'input', 'output'];
const FW_ACTIONS    = ['accept', 'drop', 'reject', 'log', 'passthrough', 'jump', 'return'];
const PROTOCOLS     = ['tcp', 'udp', 'icmp', 'ip', 'gre', 'ospf'];
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
  label, kind, value, onKind, onValue, lists,
}: {
  label: string; kind: Endpoint; value: string;
  onKind: (k: Endpoint) => void; onValue: (v: string) => void; lists: string[];
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
        <input className="input font-mono" value={value} onChange={e => onValue(e.target.value)} placeholder="0.0.0.0/0" />
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
  title, form, setForm, onSave, onClose, isPending, error, lists,
}: {
  title: string; form: RuleForm; setForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  onSave: () => void; onClose: () => void; isPending: boolean; error: string; lists: string[];
}) {
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
                {PROTOCOLS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          {form.action === 'jump' && (
            <div><label className="label">Jump Target Chain</label>
              <input className="input" value={form.jump_target} onChange={e => set('jump_target', e.target.value)} placeholder="custom-chain" /></div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <EndpointPicker label="Source" kind={form.src_kind} value={form.src_value}
              onKind={k => set('src_kind', k)} onValue={v => set('src_value', v)} lists={lists} />
            <EndpointPicker label="Destination" kind={form.dst_kind} value={form.dst_value}
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
function AddressListsCard({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [list, setList] = useState(''); const [address, setAddress] = useState(''); const [comment, setComment] = useState('');
  const [err, setErr] = useState('');

  const { data: entries = [] } = useQuery({
    queryKey: ['address-lists', deviceId],
    queryFn: () => devicesApi.getAddressLists(deviceId).then(r => r.data as Row[]),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['address-lists', deviceId] });

  // Guarded: the manager may be let in by one of these lists (P2-8).
  const guard = useGuardedWrite();
  const fail = (e: unknown) => setErr(errMsg(e));
  const addMut = useMutation({
    mutationFn: (confirm: boolean) => devicesApi.addAddressListEntry(deviceId, { list, address, comment: comment || undefined, ...(confirm ? { confirm_lockout: true } : {}) }),
    onSuccess: (res) => { invalidate(); guard.onSuccess(res); setAdding(false); setList(''); setAddress(''); setComment(''); setErr(''); },
  });
  const delMut = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => devicesApi.removeAddressListEntry(deviceId, id, confirm),
    onSuccess: (res) => { invalidate(); setErr(''); guard.onSuccess(res); },
  });
  const add = () => addMut.mutate(false, { onError: guard.onError(() => addMut.mutate(true, { onError: fail }), fail) });
  const remove = (id: string) => delMut.mutate({ id }, { onError: guard.onError(() => delMut.mutate({ id, confirm: true }, { onError: fail }), fail) });

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
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={addMut.isPending || delMut.isPending} />
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 p-4 text-left">
        <div className="w-7 h-7 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg flex items-center justify-center flex-shrink-0">
          <List className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex-1">
          Address Lists <span className="text-gray-400 font-normal">({entries.length} entries, {listNames.length} lists)</span>
        </h3>
        <span className="text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Reusable address objects. Reference a list from any firewall rule&apos;s Source/Destination instead of repeating IPs.
          </p>
          {listNames.length === 0 ? (
            <div className="text-sm text-gray-400 py-3 text-center">No address lists yet.</div>
          ) : listNames.map(name => (
            <div key={name} className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 text-xs font-semibold text-gray-700 dark:text-slate-200 font-mono">{name}</div>
              <div className="divide-y divide-gray-100 dark:divide-slate-700/50">
                {(grouped.get(name) ?? []).map(e => (
                  <div key={e['.id']} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="font-mono text-gray-700 dark:text-slate-300">{e.address}</span>
                    {e.comment && <span className="text-gray-400 italic truncate">{e.comment}</span>}
                    {e.dynamic === 'true' && <span className="text-amber-500 text-[10px]">dynamic</span>}
                    {canWrite && e.dynamic !== 'true' && (
                      <button onClick={() => remove(e['.id'])} className="ml-auto text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {canWrite && (adding ? (
            <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className="input" value={list} onChange={e => setList(e.target.value)} placeholder="list name (e.g. Trusted)" list="al-names" />
                <datalist id="al-names">{listNames.map(n => <option key={n} value={n} />)}</datalist>
                <input className="input font-mono" value={address} onChange={e => setAddress(e.target.value)} placeholder="192.168.1.0/24 or host" />
              </div>
              <input className="input" value={comment} onChange={e => setComment(e.target.value)} placeholder="comment (optional)" />
              {err && <p className="text-xs text-red-500">{err}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => { setAdding(false); setErr(''); }} className="btn-secondary text-xs py-1">Cancel</button>
                <button onClick={add} disabled={!list || !address || addMut.isPending} className="btn-primary text-xs py-1">Add Entry</button>
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
  rows, fullOrder, canWrite, canReorder, summaryFn, onEdit, onToggle, onDelete, onMove,
}: {
  rows: Row[]; fullOrder: Row[]; canWrite: boolean; canReorder: boolean;
  summaryFn: (r: Row) => string;
  onEdit: (r: Row) => void; onToggle: (r: Row) => void; onDelete: (r: Row) => void;
  onMove: (r: Row, dir: 'up' | 'down') => void;
}) {
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
            return (
              <tr key={r['.id'] ?? i} className={clsx('hover:bg-gray-50 dark:hover:bg-slate-700/30', disabled && 'opacity-40')}>
                <td className="px-3 py-2 text-gray-400 text-xs">{fullIdx >= 0 ? fullIdx + 1 : i + 1}</td>
                <td className={clsx('px-3 py-2 text-xs font-bold uppercase', ACTION_COLOR[r.action] ?? 'text-gray-500')}>
                  {r.action}{r['jump-target'] ? ` → ${r['jump-target']}` : ''}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600 dark:text-slate-300 font-mono max-w-[320px] truncate" title={summaryFn(r)}>
                  <span className="text-gray-400">{r.chain}</span> · {summaryFn(r)}
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

function NatModal({ title, form, setForm, onSave, onClose, isPending, error }: {
  title: string; form: NatForm; setForm: React.Dispatch<React.SetStateAction<NatForm>>;
  onSave: () => void; onClose: () => void; isPending: boolean; error: string;
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
                  <input className="input font-mono" value={form.to_addresses} onChange={e => set('to_addresses', e.target.value)} placeholder="192.168.1.10" /></div>
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
                <input className="input font-mono" value={form.src_address} onChange={e => set('src_address', e.target.value)} placeholder="192.168.1.0/24" /></div>
            </div>
          )}
          {form.pattern === 'one-to-one' && (
            <div className="space-y-3">
              <div><label className="label">Public Address</label>
                <input className="input font-mono" value={form.dst_address} onChange={e => set('dst_address', e.target.value)} placeholder="203.0.113.10" /></div>
              <div><label className="label">Internal Address</label>
                <input className="input font-mono" value={form.to_addresses} onChange={e => set('to_addresses', e.target.value)} placeholder="192.168.1.10" /></div>
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
function NatCard({ deviceId }: { deviceId: number }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState<Row | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<NatForm>(EMPTY_NAT);
  const [err, setErr] = useState('');

  const { data: rules = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['nat', deviceId], queryFn: () => devicesApi.getNat(deviceId).then(r => r.data as Row[]),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['nat', deviceId] });

  const addMut = useMutation({ mutationFn: (d: Record<string, unknown>) => devicesApi.addNatRule(deviceId, d),
    onSuccess: () => { invalidate(); setShowAdd(false); setErr(''); }, onError: e => setErr(errMsg(e)) });
  const updMut = useMutation({ mutationFn: ({ id, d }: { id: string; d: Record<string, unknown> }) => devicesApi.updateNatRule(deviceId, id, d),
    onSuccess: () => { invalidate(); setEditing(null); setErr(''); }, onError: e => setErr(errMsg(e)) });
  const delMut = useMutation({ mutationFn: (id: string) => devicesApi.deleteNatRule(deviceId, id), onSuccess: invalidate });
  const toggleMut = useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => devicesApi.updateNatRule(deviceId, id, { disabled: disabled ? 'yes' : 'no' }), onSuccess: invalidate });
  const moveMut = useMutation({ mutationFn: ({ id, destination }: { id: string; destination?: string }) => devicesApi.moveNatRule(deviceId, id, destination), onSuccess: invalidate });

  const onMove = (r: Row, dir: 'up' | 'down') => { const d = moveDestination(rules, r, dir); if (d.ok) moveMut.mutate({ id: r['.id'], destination: d.destination }); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-orange-50 dark:bg-orange-900/20 rounded-lg flex items-center justify-center"><ArrowRightLeft className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" /></div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">NAT <span className="text-gray-400 font-normal">({rules.length})</span></h3>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh</button>
          {canWrite && <button onClick={() => { setForm(EMPTY_NAT); setErr(''); setShowAdd(true); }} className="btn-primary flex items-center gap-1.5 text-xs py-1.5"><Plus className="w-3.5 h-3.5" /> Add NAT</button>}
        </div>
      </div>
      {err && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{err}</div>}
      {isLoading ? <div className="text-center py-6 text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
        : rules.length === 0 ? <div className="card p-8 text-center text-gray-400">No NAT rules.</div>
        : <RuleTable rows={rules} fullOrder={rules} canWrite={canWrite} canReorder summaryFn={natSummary}
            onEdit={r => { setForm(natRuleToForm(r)); setErr(''); setEditing(r); }}
            onToggle={r => toggleMut.mutate({ id: r['.id'], disabled: !(r.disabled === 'true') })}
            onDelete={r => { if (confirm('Delete this NAT rule?')) delMut.mutate(r['.id']); }} onMove={onMove} />}
      {showAdd && <NatModal title="Add NAT Rule" form={form} setForm={setForm} isPending={addMut.isPending} error={err}
        onClose={() => setShowAdd(false)} onSave={() => addMut.mutate(natPayload(form))} />}
      {editing && <NatModal title="Edit NAT Rule" form={form} setForm={setForm} isPending={updMut.isPending} error={err}
        onClose={() => setEditing(null)} onSave={() => updMut.mutate({ id: editing['.id'], d: natPayload(form, true) })} />}
    </div>
  );
}

// ─── Main FirewallTab ─────────────────────────────────────────────────────────────
export default function FirewallTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [chainFilter, setChainFilter] = useState('all');
  const [editing, setEditing] = useState<Row | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<RuleForm>(EMPTY_FW);
  const [err, setErr] = useState('');
  // Every rule change runs under Change Guard. A predicted lockout comes back
  // as 409 with a verdict; confirming re-sends the same change with
  // confirm_lockout. That covers toggles, moves and deletes too, which used to
  // skip the check entirely.
  const guard = useGuardedWrite();

  const { data: rules = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['firewall', deviceId], queryFn: () => devicesApi.getFirewall(deviceId).then(r => r.data as Row[]),
  });
  const { data: addrLists = [] } = useQuery({
    queryKey: ['address-lists', deviceId], queryFn: () => devicesApi.getAddressLists(deviceId).then(r => r.data as Row[]),
  });
  const listNames = Array.from(new Set(addrLists.map(e => e.list).filter(Boolean))).sort();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['firewall', deviceId] });
  const done = (res: unknown) => { invalidate(); setErr(''); guard.onSuccess(res); };
  const fail = (e: unknown) => setErr(errMsg(e));

  const addMut = useMutation({
    mutationFn: (d: Record<string, unknown>) => devicesApi.addFirewallRule(deviceId, d),
    onSuccess: (res) => { done(res); setShowAdd(false); },
  });
  const updMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Record<string, unknown> }) => devicesApi.updateFirewallRule(deviceId, id, d),
    onSuccess: (res) => { done(res); setEditing(null); },
  });
  const delMut = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) => devicesApi.deleteFirewallRule(deviceId, id, confirm),
    onSuccess: done,
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, disabled, confirm }: { id: string; disabled: boolean; confirm?: boolean }) =>
      devicesApi.updateFirewallRule(deviceId, id, { disabled: disabled ? 'yes' : 'no', ...(confirm ? { confirm_lockout: true } : {}) }),
    onSuccess: done,
  });
  const moveMut = useMutation({
    mutationFn: ({ id, destination, confirm }: { id: string; destination?: string; confirm?: boolean }) =>
      devicesApi.moveFirewallRule(deviceId, id, destination, confirm),
    onSuccess: done,
  });
  const resetMut = useMutation({ mutationFn: () => devicesApi.resetFirewallCounters(deviceId), onSuccess: invalidate });

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
  const anyPending = addMut.isPending || updMut.isPending || delMut.isPending || toggleMut.isPending || moveMut.isPending;

  const onMove = (r: Row, dir: 'up' | 'down') => { const d = moveDestination(rules, r, dir); if (d.ok) move(r['.id'], d.destination); };

  const allChains = ['all', ...Array.from(new Set(rules.map(r => r.chain).filter(Boolean))).sort()];
  const filtered = chainFilter === 'all' ? rules : rules.filter(r => r.chain === chainFilter);

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <AddressListsCard deviceId={deviceId} deviceName={deviceName} />

      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center"><Shield className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /></div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Firewall Filter Rules</h3>
      </div>

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
          {canWrite && <button onClick={() => resetMut.mutate()} disabled={resetMut.isPending} title="Reset hit counters"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><Activity className="w-3.5 h-3.5" /> Reset Counters</button>}
          <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"><RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh</button>
          {canWrite && <button onClick={() => { setForm({ ...EMPTY_FW, chain: chainFilter !== 'all' ? chainFilter : 'forward' }); setErr(''); setShowAdd(true); }}
            className="btn-primary flex items-center gap-1.5 text-xs py-1.5"><Plus className="w-3.5 h-3.5" /> Add Rule</button>}
        </div>
      </div>

      {chainFilter !== 'all' && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> Switch to &quot;All&quot; to reorder rules (order is global across chains).</p>
      )}
      {err && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">{err}</div>}
      <GuardedWriteUi state={guard} deviceId={deviceId} deviceName={deviceName} pending={anyPending} />

      {filtered.length === 0 ? <div className="card p-8 text-center text-gray-400">No firewall rules{chainFilter !== 'all' ? ` in "${chainFilter}"` : ''}.</div>
        : <RuleTable rows={filtered} fullOrder={rules} canWrite={canWrite} canReorder={chainFilter === 'all'} summaryFn={ruleSummary}
            onEdit={r => { setForm(ruleToForm(r)); setErr(''); setEditing(r); }}
            onToggle={r => toggle(r['.id'], !(r.disabled === 'true'))}
            onDelete={r => { if (confirm('Delete this firewall rule?')) remove(r['.id']); }} onMove={onMove} />}

      {showAdd && <RuleModal title="Add Firewall Rule" form={form} setForm={setForm} isPending={addMut.isPending} error={err} lists={listNames}
        onClose={() => setShowAdd(false)} onSave={submitAdd} />}
      {editing && <RuleModal title="Edit Firewall Rule" form={form} setForm={setForm} isPending={updMut.isPending} error={err} lists={listNames}
        onClose={() => setEditing(null)} onSave={submitEdit} />}

      {/* NAT is available on all RouterOS devices */}
      <div className="border-t border-gray-200 dark:border-slate-700 pt-2" />
      <NatCard deviceId={deviceId} />
    </div>
  );
}
