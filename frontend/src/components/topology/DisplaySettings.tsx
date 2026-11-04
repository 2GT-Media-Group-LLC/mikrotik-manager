import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { SlidersHorizontal } from 'lucide-react';

interface Choice { value: string; label: string }

function Segmented({ label, help, value, choices, onChange }: {
  label: string; help: string; value: string; choices: Choice[]; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-gray-700 dark:text-slate-200">{label}</div>
      <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden" role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button key={c.value} type="button" role="radio" aria-checked={value === c.value} onClick={() => onChange(c.value)}
            className={clsx('px-3 py-1 text-sm transition-colors',
              value === c.value
                ? 'bg-sky-600 text-white'
                : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60')}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400 leading-snug">{help}</p>
    </div>
  );
}

/**
 * How the map is drawn, in one popup rather than a row of selects in the
 * header. Kept in this browser only.
 */
export default function DisplaySettings({ compact, curved, onCards, onLinks }: {
  compact: boolean; curved: boolean; onCards: (v: string) => void; onLinks: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Capture: the map stops the events a click on it makes from reaching the document.
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button className="btn-secondary flex items-center gap-2" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        title="How cards and links are drawn">
        <SlidersHorizontal className="w-4 h-4" />Display
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-20 w-72 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-lg p-4 space-y-4"
          role="dialog" aria-label="Display settings">
          <Segmented label="Cards" value={compact ? 'compact' : 'detailed'} onChange={onCards}
            choices={[{ value: 'detailed', label: 'Detailed' }, { value: 'compact', label: 'Compact' }]}
            help="Compact shows icons with the name and address under them. The rest shows when you hover." />
          <Segmented label="Links" value={curved ? 'curved' : 'straight'} onChange={onLinks}
            choices={[{ value: 'curved', label: 'Curved' }, { value: 'straight', label: 'Straight' }]}
            help="A link with a side chosen by hand keeps its right angles." />
          <p className="text-[11px] text-gray-400 dark:text-slate-500 border-t border-gray-100 dark:border-slate-700 pt-2">Saved in this browser only.</p>
        </div>
      )}
    </div>
  );
}
