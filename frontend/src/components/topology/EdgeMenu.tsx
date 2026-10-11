import { useEffect } from 'react';
import { X } from 'lucide-react';
import { SIDES, type Side } from '../../utils/topologyGeometry';

/**
 * What clicking a link offers (#147): which side of each card it attaches to,
 * and, for a link drawn by hand, removing it.
 */
export default function EdgeMenu({ at, title, ports, sourceName, targetName, sourceSide, targetSide, canWrite, onSides, onRemove, onClose }: {
  at: { x: number; y: number };
  title: string;
  ports?: string;
  sourceName: string;
  targetName: string;
  sourceSide: Side | null;
  targetSide: Side | null;
  canWrite: boolean;
  onSides: (source: Side | null, target: Side | null) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.min(at.x + 8, window.innerWidth - 300);
  const top = Math.min(at.y + 8, window.innerHeight - 260);
  const picker = (name: string, value: Side | null, set: (v: Side | null) => void) => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="truncate text-gray-600 dark:text-slate-300" title={name}>{name}</span>
      <select className="input py-0.5 text-xs w-28" value={value ?? ''} disabled={!canWrite}
        onChange={(e) => set((e.target.value || null) as Side | null)}>
        {SIDES.map((s) => <option key={s.label} value={s.side ?? ''}>{s.label}</option>)}
      </select>
    </label>
  );
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div className="fixed z-50 card p-3 w-72 space-y-2 shadow-lg" style={{ left, top }}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{title}</p>
            {ports && <p className="text-[11px] font-mono text-gray-400 truncate">{ports}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[11px] text-gray-400">Attach at</p>
        {picker(sourceName, sourceSide, (v) => onSides(v, targetSide))}
        {picker(targetName, targetSide, (v) => onSides(sourceSide, v))}
        {onRemove && canWrite && (
          <button className="text-xs text-red-600 hover:underline pt-1" onClick={onRemove}>Remove this hand-drawn link</button>
        )}
      </div>
    </>
  );
}
