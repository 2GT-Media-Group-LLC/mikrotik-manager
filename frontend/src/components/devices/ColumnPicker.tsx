import { useEffect, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import { DEVICE_COLUMNS, type ColumnPrefs, type DeviceColumnId } from '../../utils/deviceColumns';

/**
 * Show or hide the Devices list's columns, and put them back (#283). Widths
 * are changed by dragging a header's right edge; "Reset columns" clears those
 * too.
 */
export default function ColumnPicker({ prefs, onChange }: { prefs: ColumnPrefs; onChange: (p: ColumnPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const toggle = (id: DeviceColumnId) => {
    const hidden = prefs.hidden.includes(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id];
    onChange({ ...prefs, hidden });
  };
  const changed = prefs.hidden.length > 0 || Object.keys(prefs.widths).length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Show, hide or reset columns"
        aria-expanded={open}
        className="mono text-[11.5px] px-[8px] py-[4px] rounded-[5px] flex items-center gap-1.5"
        style={{ color: changed ? 'var(--ink)' : 'var(--ink-3)', border: '1px solid var(--line)', background: 'transparent' }}
      >
        <Columns3 className="w-3.5 h-3.5" /> Columns{prefs.hidden.length > 0 ? ` (${prefs.hidden.length} hidden)` : ''}
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-52 rounded-lg p-2 shadow-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        >
          {DEVICE_COLUMNS.filter((c) => !c.fixed).map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-2 py-1 rounded text-[12px] cursor-pointer"
              style={{ color: 'var(--ink-2)' }}>
              <input type="checkbox" checked={!prefs.hidden.includes(c.id)} onChange={() => toggle(c.id)} />
              {c.pickerLabel ?? c.label}
            </label>
          ))}
          <div className="mt-1 pt-1.5 px-2 text-[10.5px]" style={{ borderTop: '1px solid var(--line-soft)', color: 'var(--ink-4)' }}>
            Drag a header&apos;s right edge to resize; double-click it to reset that column.
          </div>
          <button
            onClick={() => onChange({ hidden: [], widths: {} })}
            disabled={!changed}
            className="mt-1.5 w-full text-left px-2 py-1 rounded text-[12px] disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
          >
            Reset columns
          </button>
        </div>
      )}
    </div>
  );
}
