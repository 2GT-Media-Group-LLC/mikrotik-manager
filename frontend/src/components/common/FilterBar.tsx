import type { ReactNode } from 'react';
import { Search } from 'lucide-react';

/**
 * The compact filter bar from the Devices page, shared so every list filters
 * the same way (#222, #217): one bordered strip with a search box first, then
 * small selects and segmented toggles.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="card-subtle flex flex-wrap items-center gap-[6px] p-[6px]">{children}</div>;
}

export function FilterSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 flex-1 min-w-[160px] px-[10px] py-[6px]" style={{ color: 'var(--ink-3)' }}>
      <Search className="w-3.5 h-3.5 flex-shrink-0" />
      <input
        type="text"
        className="bg-transparent text-[13px] outline-none w-full"
        style={{ color: 'var(--ink)' }}
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** A small select; its text darkens while it filters anything. */
export function FilterSelect({
  value, onChange, children, title, className = '',
}: { value: string; onChange: (v: string) => void; children: ReactNode; title?: string; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      aria-label={title}
      className={`mono text-[11.5px] px-[8px] py-[4px] rounded-[5px] bg-transparent outline-none ${className}`}
      style={{ color: value ? 'var(--ink)' : 'var(--ink-3)', border: '1px solid var(--line)' }}
    >
      {children}
    </select>
  );
}

/** Mutually exclusive pills, like the status filter on Devices. */
export function FilterSegment<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="mono text-[11.5px] px-[10px] py-[4px] rounded-[5px] transition-colors"
          style={{
            background: value === o.value ? 'var(--surface-3)' : 'transparent',
            color: value === o.value ? 'var(--ink)' : 'var(--ink-3)',
            border: 'none',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilterDivider() {
  return <div className="w-px h-[18px] mx-1" style={{ background: 'var(--line)' }} />;
}
