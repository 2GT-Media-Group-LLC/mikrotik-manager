import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, AlertCircle, AlertTriangle, Info, RefreshCw, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import ReviewChangesButton from '../common/ReviewChangesButton';
import { LockoutVerdictDialog, lockoutVerdictOf, type LockoutVerdict } from '../ChangeGuardDialog';
import { routingRulesApi, type RoutingRule, type RoutingRuleInput } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';

const ACTIONS = [
  { value: 'lookup', label: 'Look up in table' },
  { value: 'lookup-only-in-table', label: 'Look up only in table' },
  { value: 'drop', label: 'Drop' },
  { value: 'unreachable', label: 'Unreachable' },
];
const needsTable = (action: string) => action === 'lookup' || action === 'lookup-only-in-table';

function errMsg(err: unknown) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Operation failed';
}

/** Same checks as the server, so the form says what's wrong before it's sent. */
function prefixError(v: string): string | null {
  if (!v) return null;
  const [net, len] = v.split('/');
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(net) && net.split('.').every((o) => Number(o) <= 255);
  const v6 = net.includes(':') && /^[0-9a-f:]+$/i.test(net);
  const max = v6 ? 128 : 32;
  if ((!v4 && !v6) || (len !== undefined && (!/^\d+$/.test(len) || Number(len) > max))) {
    return `${v} isn't an address or prefix (like 192.168.52.0/24).`;
  }
  return null;
}
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

function formErrors(f: RoutingRuleInput): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of ['src-address', 'dst-address'] as const) { const m = prefixError(f[k] ?? ''); if (m) e[k] = m; }
  if (!e['src-address'] && !e['dst-address'] && f['src-address'] && f['dst-address']
    && f['src-address'].includes(':') !== f['dst-address'].includes(':')) e['dst-address'] = 'Source and destination must both be IPv4 or both IPv6.';
  for (const k of ['routing-mark', 'interface'] as const) if (f[k] && !NAME.test(f[k]!)) e[k] = 'Letters, digits, dot, dash and underscore only.';
  if (needsTable(f.action) && !f.table) e.table = 'Choose the table to look up.';
  else if (needsTable(f.action) && f.table && !NAME.test(f.table)) e.table = 'Letters, digits, dot, dash and underscore only.';
  return e;
}

function matchText(r: RoutingRule): string {
  const parts = [r.src && `from ${r.src}`, r.dst && `to ${r.dst}`, r.routingMark && `mark ${r.routingMark}`,
    r.iface && `in ${r.iface}`, r.minPrefix && `min-prefix ${r.minPrefix}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'All traffic';
}

function actionText(r: RoutingRule): string {
  const a = ACTIONS.find((x) => x.value === r.action)?.label ?? r.action;
  return needsTable(r.action) && r.table ? `${a} ${r.table}` : a;
}

const EMPTY: RoutingRuleInput = { action: 'lookup', table: '' };

/** Routing rules (#370): in order, each table's routes beside it, and what's wrong with them. */
export default function RoutingRulesSubTab({ deviceId, deviceName }: { deviceId: number; deviceName?: string }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const { data, isLoading, error: loadError, refetch, isFetching } = useQuery({
    queryKey: ['routing-rules', deviceId],
    queryFn: () => routingRulesApi.list(deviceId).then((r) => r.data),
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<RoutingRuleInput>(EMPTY);
  const [error, setError] = useState('');
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; retry: () => void } | null>(null);

  const clean = (): RoutingRuleInput => {
    const out: RoutingRuleInput = { action: form.action };
    for (const k of ['src-address', 'dst-address', 'routing-mark', 'interface', 'comment'] as const) {
      const v = form[k]?.trim(); if (v) out[k] = v;
    }
    if (needsTable(form.action) && form.table) out.table = form.table.trim();
    return out;
  };
  const addRequest = (confirm = false) => routingRulesApi.add(deviceId, { ...clean(), ...(confirm ? { confirm_lockout: true } : {}) });
  const done = () => { queryClient.invalidateQueries({ queryKey: ['routing-rules', deviceId] }); setLockout(null); setError(''); };
  const addMutation = useMutation({
    mutationFn: (confirm: boolean) => addRequest(confirm),
    onSuccess: () => { done(); setShowAdd(false); setForm(EMPTY); },
    onError: (err: unknown) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => addMutation.mutate(true) }); return; }
      setError(errMsg(err));
    },
  });
  const removeMutation = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) => routingRulesApi.remove(deviceId, id, confirm),
    onSuccess: done,
    onError: (err: unknown, v) => {
      const verdict = lockoutVerdictOf(err);
      if (verdict) { setLockout({ verdict, retry: () => removeMutation.mutate({ ...v, confirm: true }) }); return; }
      setError(errMsg(err));
    },
  });

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading…</div>;
  if (loadError) return <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{errMsg(loadError)}</div>;
  const rules = data?.rules ?? [];
  const routesOf = new Map((data?.tables ?? []).map((t) => [t.table, t.routes]));
  const errs = formErrors(form);
  const tableNames = data?.table_names ? ['main', ...data.table_names.filter((t) => t !== 'main')] : null;
  const flagged = rules.filter((r) => r.flags.some((f) => f.level === 'warn')).length;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const field = (k: 'src-address' | 'dst-address' | 'routing-mark' | 'interface', label: string, placeholder: string) => (
    <div>
      <label className="label">{label}</label>
      <input className={clsx('input', errs[k] && 'border-red-400')} value={form[k] ?? ''} placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
      {errs[k] && <p className="text-xs text-red-500 mt-1">{errs[k]}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      {error && <div className="flex items-center gap-2 text-sm text-red-500"><AlertCircle className="w-4 h-4" />{error}</div>}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Routing Rules</h3>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
            Tried top to bottom; the first rule that matches decides.{flagged ? ` ${flagged} need${flagged === 1 ? 's' : ''} a look.` : ''}
          </p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-1.5 text-xs py-1.5">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {canWrite && (showAdd ? (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {field('src-address', 'Source', 'any')}
            {field('dst-address', 'Destination', 'any')}
            {field('routing-mark', 'Routing mark', 'any')}
            {field('interface', 'In interface', 'any')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Action</label>
              <select className="input" value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}>
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            {needsTable(form.action) && (
              <div>
                <label className="label">Table</label>
                {tableNames ? (
                  <select className={clsx('input', errs.table && 'border-red-400')} value={form.table ?? ''} onChange={(e) => setForm((f) => ({ ...f, table: e.target.value }))}>
                    <option value="">Choose…</option>
                    {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                ) : (
                  <input className={clsx('input', errs.table && 'border-red-400')} value={form.table ?? ''} placeholder="routing mark"
                    onChange={(e) => setForm((f) => ({ ...f, table: e.target.value }))} />
                )}
                {errs.table && <p className="text-xs text-red-500 mt-1">{errs.table}</p>}
              </div>
            )}
            <div>
              <label className="label">Comment</label>
              <input className="input" maxLength={200} value={form.comment ?? ''} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))} />
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">The new rule goes at the end, after the rules already there.</p>
          <div className="flex gap-2">
            <button onClick={() => addMutation.mutate(false)} disabled={Object.keys(errs).length > 0 || addMutation.isPending} className="btn-primary text-sm flex items-center gap-1.5">
              {addMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />} Add Rule
            </button>
            <ReviewChangesButton request={() => addRequest(false)} onApply={() => addMutation.mutate(false)} applyLabel="Add Rule" deviceName={deviceName}
              disabled={Object.keys(errs).length > 0 || addMutation.isPending} />
            <button onClick={() => { setShowAdd(false); setForm(EMPTY); }} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="btn-secondary flex items-center gap-1.5 text-sm"><Plus className="w-3.5 h-3.5" /> Add Rule</button>
      ))}

      {rules.length === 0 ? (
        <p className="text-center py-8 text-gray-400 dark:text-slate-500">No routing rules. Traffic is routed by the main table{data?.ros6 ? ' and routing marks' : ''}.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
              <th className="table-header px-3 py-2.5 text-left w-10">#</th>
              <th className="table-header px-3 py-2.5 text-left">Matches</th>
              <th className="table-header px-3 py-2.5 text-left">Action</th>
              <th className="table-header px-3 py-2.5 text-left">Notes</th>
              {canWrite && <th className="w-10" />}
            </tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {rules.map((r) => {
                const routes = r.table ? routesOf.get(r.table) ?? [] : [];
                const expandable = needsTable(r.action) && !!r.table;
                const isOpen = open.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr className={clsx('hover:bg-gray-50 dark:hover:bg-slate-700/30', r.disabled && 'opacity-50')}>
                      <td className="px-3 py-2.5 text-gray-500 tabular-nums">{r.position}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-mono text-xs text-gray-800 dark:text-slate-200">{matchText(r)}</div>
                        {r.comment && <div className="text-xs text-gray-500 dark:text-slate-400">{r.comment}</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        {expandable ? (
                          <button onClick={() => toggle(r.id)} className="flex items-center gap-1 text-left text-gray-800 dark:text-slate-200 hover:text-blue-600"
                            title={isOpen ? 'Hide this table\'s routes' : 'Show this table\'s routes'}>
                            <ChevronRight className={clsx('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-90')} />
                            {actionText(r)} <span className="text-xs text-gray-500">({routes.length} route{routes.length === 1 ? '' : 's'})</span>
                          </button>
                        ) : <span className="text-gray-800 dark:text-slate-200">{actionText(r)}</span>}
                        {r.disabled && <span className="ml-2 text-xs text-gray-500">disabled</span>}
                        {r.dynamic && <span className="ml-2 text-xs text-gray-500">dynamic</span>}
                      </td>
                      <td className="px-3 py-2.5 space-y-0.5">
                        {r.flags.map((f, i) => (
                          <div key={i} className={clsx('flex items-start gap-1 text-xs', f.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-slate-400')}>
                            {f.level === 'warn' ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> : <Info className="w-3.5 h-3.5 shrink-0 mt-px" />}{f.text}
                          </div>
                        ))}
                      </td>
                      {canWrite && <td className="px-3 py-2.5">
                        {!r.dynamic && <button onClick={() => { if (confirm(`Remove rule ${r.position} (${matchText(r)} → ${actionText(r)})?`)) removeMutation.mutate({ id: r.id, confirm: false }); }}
                          className="p-1 text-gray-400 hover:text-red-500" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>}
                      </td>}
                    </tr>
                    {expandable && isOpen && (
                      <tr className="bg-gray-50/60 dark:bg-slate-800/40">
                        <td />
                        <td colSpan={canWrite ? 4 : 3} className="px-3 py-2">
                          {routes.length === 0 ? <p className="text-xs text-gray-500">No routes in {r.table}.</p> : (
                            <table className="text-xs font-mono">
                              <tbody>
                                {routes.map((rt, i) => (
                                  <tr key={i} className={clsx(!rt.active && 'opacity-50')}>
                                    <td className="pr-4 py-0.5">{rt.dst}</td>
                                    <td className="pr-4 py-0.5">{rt.gateway ? `via ${rt.gateway}` : ''}</td>
                                    <td className="pr-4 py-0.5">{rt.distance ? `distance ${rt.distance}` : ''}</td>
                                    <td className="py-0.5 font-sans">{rt.active ? '' : 'inactive'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {lockout && (
        <LockoutVerdictDialog deviceId={deviceId} verdict={lockout.verdict} confirmPhrase={deviceName || 'confirm'}
          pending={addMutation.isPending || removeMutation.isPending} onConfirm={lockout.retry} onCancel={() => setLockout(null)} />
      )}
    </div>
  );
}
