import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { SIDES, type Side } from '../../utils/topologyGeometry';

/**
 * What clicking a link offers (#147): which side of each card it attaches to,
 * and, for a link drawn by hand, removing it.
 */
/** Colours a link can be given (#260); the first is the default for its kind. */
export const LINK_COLORS: { color: string | null; label: string }[] = [
  { color: null, label: 'Default' },
  { color: '#f97316', label: 'Orange' },
  { color: '#eab308', label: 'Yellow' },
  { color: '#22c55e', label: 'Green' },
  { color: '#06b6d4', label: 'Cyan' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#a855f7', label: 'Purple' },
  { color: '#ec4899', label: 'Pink' },
];

export default function EdgeMenu({ at, title, ports, sourceName, targetName, sourceSide, targetSide, canWrite, onSides, onRemove, onHide, color, onColor, hand, onSaveHand, onClose }: {
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
  /** Hide a discovered link that's wrong (discussion #85). */
  onHide?: () => void;
  /** The link's colour, and setting it (#260). */
  color?: string | null;
  onColor?: (color: string | null) => void;
  /** For a link drawn by hand: its ports and label, and saving them (#260). */
  hand?: { aPort: string; bPort: string; label: string };
  onSaveHand?: (v: { aPort: string; bPort: string; label: string }) => void;
  onClose: () => void;
}) {
  const [handForm, setHandForm] = useState(hand ?? { aPort: '', bPort: '', label: '' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.min(at.x + 8, window.innerWidth - 300);
  const top = Math.min(at.y + 8, window.innerHeight - (hand ? 420 : 320));
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
        {onColor && (
          <div>
            <p className="text-[11px] text-gray-400 mb-1">Colour</p>
            <div className="flex items-center gap-1.5">
              {LINK_COLORS.map((c) => (
                <button key={c.label} type="button" title={c.label} disabled={!canWrite}
                  onClick={() => onColor(c.color)}
                  className={`w-5 h-5 rounded-full border ${(color ?? null) === c.color ? 'ring-2 ring-offset-1 ring-blue-500' : ''}`}
                  style={c.color ? { background: c.color, borderColor: c.color } : { background: 'transparent', borderColor: '#94a3b8', borderStyle: 'dashed' }} />
              ))}
            </div>
          </div>
        )}
        {hand && onSaveHand && canWrite && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] text-gray-400">Ports and label</p>
            <div className="grid grid-cols-2 gap-1.5">
              <input className="input py-0.5 text-xs" placeholder={`Port on ${sourceName}`} maxLength={64}
                value={handForm.aPort} onChange={(e) => setHandForm((f) => ({ ...f, aPort: e.target.value }))} />
              <input className="input py-0.5 text-xs" placeholder={`Port on ${targetName}`} maxLength={64}
                value={handForm.bPort} onChange={(e) => setHandForm((f) => ({ ...f, bPort: e.target.value }))} />
            </div>
            <input className="input py-0.5 text-xs w-full" placeholder="Label (optional)" maxLength={100}
              value={handForm.label} onChange={(e) => setHandForm((f) => ({ ...f, label: e.target.value }))} />
            <button className="btn-primary text-xs py-1 px-2" onClick={() => onSaveHand(handForm)}>Save</button>
          </div>
        )}
        {onHide && canWrite && (
          <button className="block text-xs text-red-600 hover:underline pt-1" onClick={onHide}
            title="For a link discovery reports that isn't a real cable. It can be shown again from the list below the map.">
            Hide this link
          </button>
        )}
        {onRemove && canWrite && (
          <button className="text-xs text-red-600 hover:underline pt-1" onClick={onRemove}>Remove this hand-drawn link</button>
        )}
      </div>
    </>
  );
}
