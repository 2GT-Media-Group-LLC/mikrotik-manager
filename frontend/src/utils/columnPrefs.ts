/**
 * Hidden and resized table columns, kept in this browser: a viewing
 * preference, like sort order. Shared by the Devices list (#283) and the
 * Clients list (#336).
 */
export interface ColumnDef<Id extends string = string> {
  id: Id;
  label: string;
  /** Name in the column picker, where the header label is blank. */
  pickerLabel?: string;
  /** Default width in px; null lets the column take what it needs. */
  width: number | null;
  /** Always shown: the name, the status dot, the actions. */
  fixed?: boolean;
}

export interface ColumnPrefs<Id extends string = string> {
  hidden: Id[];
  /** Widths the user dragged to, in px. */
  widths: Partial<Record<Id, number>>;
}

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 800;

export function clampWidth(w: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));
}

/** Load, save and apply the preferences for one table, under its own storage key. */
export function columnStore<Id extends string>(key: string, columns: ColumnDef<Id>[]) {
  const known = new Set<string>(columns.map((c) => c.id));
  const fixed = new Set<string>(columns.filter((c) => c.fixed).map((c) => c.id));

  /** Tolerant of anything previously stored: unknown or fixed columns are dropped. */
  function parse(raw: string | null): ColumnPrefs<Id> {
    const out: ColumnPrefs<Id> = { hidden: [], widths: {} };
    if (!raw) return out;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return out; }
    if (!v || typeof v !== 'object') return out;
    const o = v as { hidden?: unknown; widths?: unknown };
    if (Array.isArray(o.hidden)) {
      out.hidden = [...new Set(o.hidden.filter((h): h is Id => typeof h === 'string' && known.has(h) && !fixed.has(h)))];
    }
    if (o.widths && typeof o.widths === 'object') {
      for (const [k, w] of Object.entries(o.widths as Record<string, unknown>)) {
        if (known.has(k) && typeof w === 'number' && Number.isFinite(w)) out.widths[k as Id] = clampWidth(w);
      }
    }
    return out;
  }

  return {
    parse,
    load(): ColumnPrefs<Id> {
      try { return parse(localStorage.getItem(key)); } catch { return { hidden: [], widths: {} }; }
    },
    save(p: ColumnPrefs<Id>): void {
      try {
        if (p.hidden.length === 0 && Object.keys(p.widths).length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(p));
      } catch { /* private mode */ }
    },
    visible(p: ColumnPrefs<Id>): ColumnDef<Id>[] {
      return columns.filter((c) => c.fixed || !p.hidden.includes(c.id));
    },
  };
}
