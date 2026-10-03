import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { splitList } from '../../utils/ipPrefix';

/**
 * A list edited one entry at a time (#207), instead of a comma-separated text
 * box: Enter, comma or space adds what's typed, a pasted list is split, × or
 * Backspace on an empty box removes. An entry that fails `validate` stays in
 * the box with the reason shown, so nothing is silently dropped.
 */
export default function ListInput({
  value, onChange, validate, placeholder, disabled, ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** An error message for an entry, or null when it's acceptable. */
  validate?: (entry: string) => string | null;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const add = (text: string): boolean => {
    const entries = splitList(text);
    if (entries.length === 0) return true;
    const bad = entries.map((e) => [e, validate?.(e) ?? null] as const).filter(([, err]) => err);
    if (bad.length > 0) {
      setError(bad[0][1] as string);
      setDraft(bad.map(([e]) => e).join(' '));
    } else {
      setError('');
      setDraft('');
    }
    const good = entries.filter((e) => !bad.some(([b]) => b === e) && !value.includes(e));
    if (good.length) onChange([...value, ...good]);
    return bad.length === 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) { e.preventDefault(); add(draft); }
      else if (e.key !== 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) { e.preventDefault(); add(`${draft} ${text}`); }
  };

  return (
    <div>
      <div className={`input w-full flex flex-wrap items-center gap-1 min-h-[2.25rem] py-1 ${disabled ? 'opacity-60' : ''}`}>
        {value.map((entry) => (
          <span key={entry} className="inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 font-mono text-xs text-gray-800 dark:text-slate-200">
            {entry}
            {!disabled && (
              <button type="button" aria-label={`Remove ${entry}`} onClick={() => onChange(value.filter((v) => v !== entry))}
                className="text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
            )}
          </span>
        ))}
        <input
          aria-label={ariaLabel}
          disabled={disabled}
          className="flex-1 min-w-[8rem] bg-transparent outline-none font-mono text-xs py-0.5"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (draft.trim()) add(draft); }}
        />
      </div>
      {error && <p className="mt-0.5 text-xs text-red-500">{error}</p>}
    </div>
  );
}

