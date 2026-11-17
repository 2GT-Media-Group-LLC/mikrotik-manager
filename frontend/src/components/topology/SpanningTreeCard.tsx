import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Info, Check, RefreshCw, X, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { devicesApi } from '../../services/api';
import { stpOverview, type StpTreeDevice, type StpTreeRow } from '../../utils/stpTrees';
import type { BridgeInfo } from '../../utils/stpRoot';
import type { StpDomainInfo } from '../../utils/topologyGraph';
import { LockoutVerdictDialog, lockoutVerdictOf, guardOutcomeMessage, type LockoutVerdict, type GuardResult } from '../ChangeGuardDialog';

/** STP priority: 0–61440 in steps of 4096, decimal or hex, as the server takes it. */
function priorityError(v: string): string | null {
  const s = v.trim().toLowerCase();
  const n = /^0x[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 61440 && n % 4096 === 0 ? null : '0 to 61440 in steps of 4096 (0x0000 to 0xF000)';
}

function errText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'That didn’t work';
}

/**
 * Every spanning tree among the bridges in view: its root, and each bridge's
 * priority, root port and distance from the root, with the priority editable
 * in place so the root can be chosen on purpose (core lowest, then
 * distribution, access at the default, access points highest).
 */
export default function SpanningTreeCard({ devices, bridges, domains, canWrite, onChanged }: {
  devices: StpTreeDevice[];
  bridges: BridgeInfo[];
  domains: StpDomainInfo[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { trees, off, warnings } = stpOverview(devices, bridges, domains);
  const [editing, setEditing] = useState<{ row: StpTreeRow; value: string } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockout, setLockout] = useState<{ verdict: LockoutVerdict; deviceId: number; deviceName: string; retry: () => void } | null>(null);

  const save = useMutation({
    mutationFn: ({ row, value, confirm = false }: { row: StpTreeRow; value: string; confirm?: boolean }) =>
      devicesApi.updateBridge(row.deviceId, row.bridgeName, { priority: value.trim() }, confirm),
    onSuccess: (r: { data?: { message?: string; guard?: GuardResult } }, v) => {
      const g = guardOutcomeMessage(r.data?.guard);
      setNote(g ? { ok: g.tone === 'ok', text: g.text }
        : { ok: true, text: `${v.row.deviceName}: priority set. Spanning tree settles within seconds; this list catches up at the next poll.` });
      setEditing(null);
      setLockout(null);
      onChanged();
    },
    onError: (e, v) => {
      const verdict = lockoutVerdictOf(e);
      if (verdict) { setLockout({ verdict, deviceId: v.row.deviceId, deviceName: v.row.deviceName, retry: () => save.mutate({ ...v, confirm: true }) }); return; }
      setNote({ ok: false, text: errText(e) });
    },
  });

  if (trees.length === 0 && off.length === 0) return null;
  const err = editing ? priorityError(editing.value) : null;

  const row = (r: StpTreeRow, inTree: boolean) => {
    const open = editing?.row.deviceId === r.deviceId && editing.row.bridgeName === r.bridgeName;
    return (
      <tr key={`${r.deviceId}:${r.bridgeName}`} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
        <td className="px-4 py-2">
          <Link to={`/devices/${r.deviceId}?tab=bridges`} className="text-blue-600 dark:text-blue-400 hover:underline">{r.deviceName}</Link>
          <span className="ml-1.5 font-mono text-xs text-gray-400">{r.bridgeName}</span>
        </td>
        <td className="px-4 py-2 text-xs uppercase text-gray-500 dark:text-slate-400">{r.mode}</td>
        <td className="px-4 py-2 font-mono text-xs">
          {open ? (
            <span className="inline-flex items-start gap-1">
              <span>
                <input autoFocus className={clsx('input font-mono text-xs py-1 w-24', err && 'border-red-400')} value={editing.value}
                  onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' && !err) save.mutate({ row: r, value: editing.value }); if (ev.key === 'Escape') setEditing(null); }} />
                {err && <span className="block text-[11px] text-red-500 font-sans mt-0.5">{err}</span>}
              </span>
              <button title="Save" disabled={!!err || save.isPending} onClick={() => save.mutate({ row: r, value: editing.value })}
                className="p-1 text-green-600 disabled:opacity-40">
                {save.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </button>
              <button title="Cancel" onClick={() => setEditing(null)} className="p-1 text-gray-400"><X className="w-3.5 h-3.5" /></button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className={clsx(r.priority === '0x8000' ? 'text-gray-500 dark:text-slate-400' : 'text-gray-900 dark:text-white')}>{r.priority ?? '—'}</span>
              {canWrite && r.mode !== 'none' && (
                <button title="Change priority" onClick={() => { setNote(null); setEditing({ row: r, value: r.priority ?? '' }); }}
                  className="text-gray-400 hover:text-blue-600"><Pencil className="w-3 h-3" /></button>
              )}
            </span>
          )}
        </td>
        {inTree && <>
          <td className="px-4 py-2 text-xs">
            {r.isRoot ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 font-medium">Root</span>
              : <span className="font-mono text-gray-700 dark:text-slate-300">{r.rootPort ?? '—'}</span>}
          </td>
          <td className="px-4 py-2 text-xs text-right font-mono text-gray-500 dark:text-slate-400">{r.isRoot ? '0' : (r.cost ?? '—')}</td>
        </>}
      </tr>
    );
  };

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Spanning Tree <span className="font-normal text-gray-400">· {trees.length} tree{trees.length === 1 ? '' : 's'}</span>
        </h3>
        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
          The lowest priority wins root. Give the core the lowest (0x1000), distribution next (0x2000 to 0x4000),
          leave access switches at 0x8000 and set access points to 0xF000.
        </p>
      </div>
      {(warnings.length > 0 || note) && (
        <div className="px-4 py-3 space-y-2 border-b border-gray-100 dark:border-slate-700">
          {warnings.map((w) => (
            <div key={w.text} className={clsx('flex gap-2 text-xs', w.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-slate-300')}>
              {w.tone === 'warn' ? <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
              <span>{w.text}</span>
            </div>
          ))}
          {note && <div className={clsx('text-xs', note.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{note.text}</div>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-slate-700">
              <th className="table-header px-4 py-2 text-left">Bridge</th>
              <th className="table-header px-4 py-2 text-left">Mode</th>
              <th className="table-header px-4 py-2 text-left">Priority</th>
              <th className="table-header px-4 py-2 text-left">Root Port</th>
              <th className="table-header px-4 py-2 text-right">Cost to Root</th>
            </tr>
          </thead>
          {trees.map((t) => (
            <tbody key={t.rootBridgeId} className="divide-y divide-gray-100 dark:divide-slate-700">
              <tr className="bg-gray-50 dark:bg-slate-800/60">
                <td colSpan={5} className="px-4 py-1.5 text-xs text-gray-600 dark:text-slate-300">
                  Tree rooted at{' '}
                  {t.rootDeviceId != null
                    ? <Link to={`/devices/${t.rootDeviceId}?tab=bridges`} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline">{t.rootName}</Link>
                    : <span className="font-semibold">{t.rootName}</span>}
                  {t.rootDeviceId == null && <span className="text-gray-400"> (not managed)</span>}
                  <span className="ml-2 font-mono text-gray-400">{t.rootBridgeId}</span>
                </td>
              </tr>
              {t.rows.map((r) => row(r, true))}
            </tbody>
          ))}
          {off.length > 0 && (
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              <tr className="bg-gray-50 dark:bg-slate-800/60">
                <td colSpan={5} className="px-4 py-1.5 text-xs text-gray-600 dark:text-slate-300">
                  Spanning tree off: these bridges take no part in any tree
                </td>
              </tr>
              {off.map((r) => row(r, false))}
            </tbody>
          )}
        </table>
      </div>
      {lockout && (
        <LockoutVerdictDialog
          deviceId={lockout.deviceId}
          verdict={lockout.verdict}
          confirmPhrase={lockout.deviceName}
          pending={save.isPending}
          onConfirm={lockout.retry}
          onCancel={() => setLockout(null)}
        />
      )}
    </div>
  );
}
