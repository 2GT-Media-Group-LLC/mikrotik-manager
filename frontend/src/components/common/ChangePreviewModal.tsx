import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, X, Copy, Check, AlertTriangle, ShieldAlert, Info } from 'lucide-react';
import clsx from 'clsx';
import type { ChangePreview, PreviewStep } from '../../services/api';

const ACTION: Record<string, { label: string; cls: string }> = {
  add: { label: 'Add', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  set: { label: 'Change', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  remove: { label: 'Remove', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  move: { label: 'Move', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  enable: { label: 'Enable', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  disable: { label: 'Disable', cls: 'bg-gray-200 text-gray-700 dark:bg-slate-700 dark:text-slate-300' },
};

/** What a step acts on, in words: its name, comment or address. */
export function stepSubject(s: PreviewStep): string {
  const t = s.target ?? {};
  const p = s.params;
  return t.name || t.comment || t.address || t['dst-address'] || t['vlan-ids'] || t['mac-address']
    || p.name || p.comment || p.address || p['dst-address'] || p['vlan-ids'] || p['mac-address']
    || t['.id'] || p['.id'] || p.numbers || '';
}

/** True when a step would leave its item exactly as it is. */
const isNoop = (s: PreviewStep) => s.action === 'set' && s.changes.length === 0;

/**
 * "Review changes" (#255): what an edit form would send to the device, shown
 * only when asked for. Nothing has been applied when this opens.
 */
export default function ChangePreviewModal({ preview, deviceName, onApply, applyLabel = 'Apply changes', onClose }: {
  preview: ChangePreview;
  deviceName?: string;
  onApply?: () => void;
  applyLabel?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<'changes' | 'commands'>('changes');
  const [copied, setCopied] = useState(false);
  const steps = preview.steps;
  const real = steps.filter((s) => !isNoop(s));
  const noops = steps.length - real.length;
  const hosts = [...new Set(steps.map((s) => s.host))];
  const cli = real.map((s) => s.cli).join('\n');
  const v = preview.verdict;
  const risky = v && v.severity !== 'safe';

  const copy = () => {
    void navigator.clipboard?.writeText(cli).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]" role="dialog" aria-label="Review changes">
        <div className="flex items-start gap-3 p-5 pb-3 border-b border-gray-100 dark:border-slate-700">
          <Eye className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white">Review changes</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
              Nothing has been applied. This is what would be sent to {deviceName || 'the device'}
              {real.length > 0 ? `: ${real.length} change${real.length === 1 ? '' : 's'}` : ''}.
            </p>
          </div>
          <button className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200" onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {risky && (
            <div className={clsx('flex gap-2 p-3 rounded-lg border text-xs',
              v.severity === 'critical'
                ? 'border-red-300 bg-red-50 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300'
                : 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-300')}>
              {v.severity === 'critical' ? <ShieldAlert className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
              <div className="space-y-1">
                <p className="font-medium">Change Guard: {v.headline}</p>
                {v.violations.map((x) => <p key={x.id}>{x.title}</p>)}
                {v.warnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
            </div>
          )}

          {real.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
              <Info className="w-4 h-4 text-gray-400" />This wouldn&apos;t change anything on the device.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-1 text-xs">
                {(['changes', 'commands'] as const).map((k) => (
                  <button key={k} onClick={() => setView(k)}
                    className={clsx('px-2.5 py-1 rounded-md', view === k
                      ? 'bg-gray-900 text-white dark:bg-slate-200 dark:text-slate-900'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700')}>
                    {k === 'changes' ? 'Changes' : 'Commands'}
                  </button>
                ))}
                {view === 'commands' && (
                  <button onClick={copy} className="ml-auto inline-flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-white">
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>

              {view === 'commands' ? (
                <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{cli}</pre>
              ) : (
                <ul className="space-y-2">
                  {real.map((s, i) => <StepRow key={i} step={s} showHost={hosts.length > 1} />)}
                </ul>
              )}
            </>
          )}
          {noops > 0 && (
            <p className="text-[11px] text-gray-400 dark:text-slate-500">
              {noops} more write{noops === 1 ? '' : 's'} would set values the device already has, so {noops === 1 ? 'it isn’t' : 'they aren’t'} shown.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-100 dark:border-slate-700">
          <button className="btn-secondary text-sm" onClick={onClose}>Close</button>
          {onApply && real.length > 0 && (
            <button className="btn-primary text-sm" onClick={() => { onClose(); onApply(); }}>{applyLabel}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StepRow({ step: s, showHost }: { step: PreviewStep; showHost: boolean }) {
  const a = ACTION[s.action] ?? { label: s.action, cls: 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-slate-300' };
  const subject = stepSubject(s);
  const shown = s.action === 'add'
    ? Object.entries(s.params)
    : s.action === 'remove' && s.target
      ? Object.entries(s.target).filter(([k, val]) => k !== '.id' && val !== '').slice(0, 8)
      : [];
  return (
    <li className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={clsx('px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide', a.cls)}>{a.label}</span>
        <span className="font-mono text-xs text-gray-500 dark:text-slate-400">{s.path}</span>
        {subject && <span className="font-mono text-xs text-gray-900 dark:text-white">{subject}</span>}
        {showHost && <span className="ml-auto text-[11px] text-gray-400">{s.host}</span>}
      </div>
      {s.changes.length > 0 && (
        <table className="mt-2 text-xs w-full">
          <tbody>
            {s.changes.map((c) => (
              <tr key={c.field} className="align-top">
                <td className="pr-3 py-0.5 font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">{c.field}</td>
                <td className="py-0.5 font-mono break-all">
                  {c.from !== null && c.from !== '' && <span className="text-red-600 dark:text-red-400 line-through mr-1.5">{c.from}</span>}
                  <span className="text-green-700 dark:text-green-400">{c.to === '' ? '(empty)' : c.to}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono">
          {shown.map(([k, val]) => (
            <span key={k} className={s.action === 'remove' ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-slate-300'}>
              <span className="text-gray-400 dark:text-slate-500">{k}=</span>{val === '' ? '""' : val}
            </span>
          ))}
        </div>
      )}
      {s.unchanged.length > 0 && (
        <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">Already set: {s.unchanged.join(', ')}</p>
      )}
    </li>
  );
}
