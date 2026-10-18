import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Search } from 'lucide-react';
import clsx from 'clsx';
import { sitesApi } from '../../services/api';
import { filterDevices, PICKER_RENDER_LIMIT, type PickerDevice } from '../../utils/devicePicker';

interface Props<T extends PickerDevice> {
  devices: T[];
  value: number | null;
  onChange: (id: number | null, device: T | null) => void;
  /** Shown on the button when nothing is chosen. */
  placeholder?: string;
  /**
   * Offer "nothing" as a choice with this label (e.g. "All devices"), at the
   * top of the list; without it, the choice can't be cleared.
   */
  emptyLabel?: string;
  /** Extra words after a device's name, e.g. its type. */
  describe?: (d: T) => string | null | undefined;
  /** Devices listed but not selectable, with the reason shown. */
  unavailable?: (d: T) => string | null | undefined;
  /** Width and layout classes for the button (it fills its container by default). */
  className?: string;
  disabled?: boolean;
  /** 'filter': the small style of a filter bar (FilterSelect), name only. */
  variant?: 'input' | 'filter';
  id?: string;
  'aria-label'?: string;
  title?: string;
}

/**
 * A device drop-down you can type into (#304): filter by name, address, site,
 * model or identity. Used wherever a list of devices is chosen from, so a
 * large fleet doesn't mean scrolling through hundreds of names.
 */
export default function DevicePicker<T extends PickerDevice>({
  devices, value, onChange, placeholder = 'Choose a device', emptyLabel, describe, unavailable,
  className, disabled, variant = 'input', id, 'aria-label': ariaLabel, title,
}: Props<T>) {
  const compact = variant === 'filter';
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Site names, where the rows only carry site_id. Shared with the rest of the
  // app's ['sites'] query, so usually already loaded.
  const needSites = devices.some((d) => d.site_id != null && !d.site_name);
  const { data: sites } = useQuery({
    queryKey: ['sites'], queryFn: () => sitesApi.list().then((r) => r.data),
    staleTime: 300_000, enabled: needSites,
  });
  const rows = useMemo(() => {
    if (!needSites || !sites) return devices;
    const names = new Map(sites.map((s) => [s.id, s.name]));
    return devices.map((d) => (d.site_name || d.site_id == null ? d : { ...d, site_name: names.get(d.site_id) ?? null }));
  }, [devices, sites, needSites]);
  const manySites = useMemo(() => new Set(rows.map((d) => d.site_name ?? '')).size > 1, [rows]);

  const matches = useMemo(() => filterDevices(rows, text), [rows, text]);
  const shown = matches.slice(0, PICKER_RENDER_LIMIT);
  // The list as the keyboard walks it: the "nothing" choice first when offered and not filtering.
  const options: (T | null)[] = useMemo(
    () => (emptyLabel && !text.trim() ? [null, ...shown] : shown),
    [emptyLabel, text, shown],
  );

  const selected = value == null ? null : rows.find((d) => d.id === value) ?? null;

  const place = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 300);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const up = window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom;
    setPos({ left: Math.max(8, left), top: up ? r.top - 4 : r.bottom + 4, width, up });
  };

  const openList = (initial = '') => {
    if (disabled) return;
    setText(initial);
    place();
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    setText('');
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (d: T | null) => {
    if (d && unavailable?.(d)) return;
    onChange(d ? d.id : null, d);
    close();
  };

  // Start on the current choice, so Enter right away keeps it.
  useEffect(() => {
    if (!open) return;
    const at = options.findIndex((o) => (o ? o.id : null) === value);
    setActive(text.trim() ? 0 : Math.max(0, at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    const onMove = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 10)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 10)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options.length) choose(options.find((_, i) => i === active) ?? null); }
    // Closes the list, not the dialog it sits in.
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  const label = (d: T) => {
    const extra = describe?.(d);
    const off = d.status && d.status !== 'online' ? d.status : null;
    return { main: d.name.trim(), sub: [d.ip_address, manySites ? d.site_name : null, extra, off].filter(Boolean).join(' · ') };
  };

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ?? title}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={clsx(
          compact
            ? 'mono text-[11.5px] px-[8px] py-[4px] rounded-[5px] bg-transparent outline-none flex items-center gap-1.5 text-left max-w-[14rem] focus-visible:ring-2'
            : 'input flex items-center gap-2 text-left',
          'disabled:opacity-60', className)}
        style={compact ? { border: '1px solid var(--line)' } : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); }
          // Typing on the closed picker starts a search with that letter.
          else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openList(e.key); }
        }}
      >
        <span className="flex-1 truncate" style={{
          color: compact ? (selected ? 'var(--ink)' : 'var(--ink-3)')
            : selected || (value == null && emptyLabel) ? 'var(--ink)' : 'var(--ink-4)',
        }}>
          {selected ? (
            <>
              {selected.name.trim()}
              {!compact && selected.ip_address && <span style={{ color: 'var(--ink-4)' }}> ({selected.ip_address})</span>}
            </>
          ) : value == null && emptyLabel ? emptyLabel : placeholder}
        </span>
        <ChevronDown className={clsx(compact ? 'w-3 h-3' : 'w-4 h-4', 'flex-shrink-0 transition-transform', open && 'rotate-180')} style={{ color: 'var(--ink-4)' }} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          // Rendered outside the page, but React still bubbles its events to
          // the picker's parents: a dialog that closes on a backdrop click
          // must not see a click on an option.
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[1000] rounded-lg shadow-lg flex flex-col"
          style={{
            left: pos.left, width: pos.width,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            background: 'var(--surface)', border: '1px solid var(--line)', maxHeight: 340,
          }}
        >
          <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
            <Search className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--ink-4)' }} />
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Name, address, site or model"
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: 'var(--ink)' }}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
              aria-label="Search devices"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="overflow-y-auto py-1 text-sm">
            {options.map((d, i) => {
              const why = d ? unavailable?.(d) : null;
              const l = d ? label(d) : null;
              const isSel = (d ? d.id : null) === value;
              return (
                <li
                  key={d ? d.id : 'none'}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={!!why}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(d)}
                  className={clsx('px-3 py-1.5', why ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}
                  style={{ background: i === active ? 'var(--surface-3)' : undefined }}
                >
                  {d && l ? (
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className={clsx('truncate flex-shrink-0 max-w-[75%]', isSel && 'font-semibold')} style={{ color: 'var(--ink)' }} title={l.main}>{l.main}</span>
                      {(l.sub || why) && (
                        <span className="truncate min-w-0 text-xs" style={{ color: 'var(--ink-4)' }}>{why ?? l.sub}</span>
                      )}
                    </div>
                  ) : (
                    <span className={clsx(isSel && 'font-semibold')} style={{ color: 'var(--ink-2)' }}>{emptyLabel}</span>
                  )}
                </li>
              );
            })}
            {matches.length === 0 && (
              <li className="px-3 py-2 text-xs" style={{ color: 'var(--ink-4)' }}>No device matches “{text.trim()}”.</li>
            )}
            {matches.length > shown.length && (
              <li className="px-3 py-2 text-xs" style={{ color: 'var(--ink-4)' }}>
                {matches.length - shown.length} more. Type to narrow the list.
              </li>
            )}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
