import { useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> & {
  value: number | string | null | undefined;
  /** Called with a whole number within min/max, on blur or Enter only. */
  onCommit: (value: number) => void;
};

/**
 * A number setting that saves when you finish typing, not on every keystroke
 * (outside review U11). Saving per keystroke stored every intermediate value:
 * changing a retention of 90 to 30 briefly saved 3, and clearing the field
 * saved null. An invalid or out-of-range entry snaps back to the saved value.
 */
export default function NumberSetting({ value, onCommit, min, max, className, ...rest }: Props) {
  // What is being typed; null when not editing, so the saved value shows.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (value == null ? '' : String(value));

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    const lo = min === undefined ? -Infinity : Number(min);
    const hi = max === undefined ? Infinity : Number(max);
    setDraft(null); // valid or not, show the saved value again until the save lands
    if (draft.trim() === '' || !Number.isInteger(n) || n < lo || n > hi) return;
    if (String(n) !== String(value)) onCommit(n);
  };

  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      className={className}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}
