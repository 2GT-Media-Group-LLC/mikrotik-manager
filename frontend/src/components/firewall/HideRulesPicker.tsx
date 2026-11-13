import { useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import type { FirewallRuleOption } from '../../services/api';

/** A rule's key in the Hide filter and in `?hide=`: its device and whole prefix. */
export const ruleKey = (o: { deviceId: number | null; prefix: string }) => `${o.deviceId}|${o.prefix}`;

/** Most rules hidden at once; the server takes no more. */
export const HIDE_MAX = 20;

/**
 * Firewall Logs: the rules left out of the list, the opposite of the Rule
 * filter. The usual wish is "everything except the internet scans", which one
 * rule picked can't say. Rules hidden earlier that didn't log in this period
 * stay listed, so they can be shown again.
 */
export default function HideRulesPicker({ choices, hidden, onChange, label, deviceId, deviceName }: {
  choices: FirewallRuleOption[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
  label: (o: FirewallRuleOption) => string;
  /** The device picked, if any: only its hidden rules apply. */
  deviceId: string;
  deviceName: (id: number) => string | undefined;
}) {
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

  const listed = new Set(choices.map(ruleKey));
  const applies = hidden.filter((k) => !deviceId || k.startsWith(`${deviceId}|`));
  const rows: { key: string; text: string }[] = [
    ...choices.map((o) => ({ key: ruleKey(o), text: label(o) })),
    ...applies.filter((k) => !listed.has(k)).map((k) => {
      const cut = k.indexOf('|');
      const where = deviceId ? '' : ` · ${deviceName(Number(k.slice(0, cut))) ?? 'unknown device'}`;
      return { key: k, text: `${k.slice(cut + 1)}${where} — none in this period` };
    }),
  ];
  const toggle = (key: string) =>
    onChange(hidden.includes(key) ? hidden.filter((h) => h !== key) : [...hidden, key]);

  return (
    <div ref={ref} className="relative w-full sm:w-auto">
      <button
        type="button"
        className="input w-full sm:w-auto flex items-center gap-1.5 whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Leave chosen rules out of the list, such as the internet scans"
      >
        <EyeOff className="w-3.5 h-3.5" />
        {applies.length ? `${applies.length} hidden` : 'Hide rules'}
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-80 max-h-80 overflow-y-auto rounded-lg p-2 shadow-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        >
          {rows.length === 0 ? (
            <p className="px-2 py-1 text-[12px]" style={{ color: 'var(--ink-3)' }}>No rule logged with a prefix in this period.</p>
          ) : rows.map((r) => {
            const on = hidden.includes(r.key);
            return (
              <label key={r.key} className="flex items-start gap-2 px-2 py-1 rounded text-[12px] cursor-pointer"
                style={{ color: 'var(--ink-2)' }}>
                <input type="checkbox" className="mt-0.5" checked={on}
                  disabled={!on && hidden.length >= HIDE_MAX} onChange={() => toggle(r.key)} />
                <span>{r.text}</span>
              </label>
            );
          })}
          <div className="mt-1 pt-1.5 px-2 text-[10.5px]" style={{ borderTop: '1px solid var(--line-soft)', color: 'var(--ink-4)' }}>
            Checked rules are left out of both views. Up to {HIDE_MAX}; kept in this browser.
          </div>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={hidden.length === 0}
            className="mt-1.5 w-full text-left px-2 py-1 rounded text-[12px] disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
          >
            Show all rules
          </button>
        </div>
      )}
    </div>
  );
}
