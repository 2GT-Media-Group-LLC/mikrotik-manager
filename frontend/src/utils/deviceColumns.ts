/**
 * The Devices list's columns, and which of them a user has hidden or resized
 * (#283). Kept in this browser: it is a viewing preference, like sort order.
 */
export type DeviceColumnId =
  | 'status' | 'device' | 'type' | 'model' | 'serial' | 'rack' | 'ip'
  | 'api' | 'login' | 'ros' | 'cpu' | 'load' | 'seen' | 'actions';

export interface DeviceColumn {
  id: DeviceColumnId;
  label: string;
  /** Name in the column picker, where the header label is blank. */
  pickerLabel?: string;
  /** Sort key, when the header sorts. */
  sortKey: string | null;
  /** Default width in px; null lets the column take what it needs. */
  width: number | null;
  /** The status dot, the name and the actions are always shown. */
  fixed?: boolean;
}

export const DEVICE_COLUMNS: DeviceColumn[] = [
  { id: 'status',  label: '',           sortKey: null,            width: 22,  fixed: true },
  { id: 'device',  label: 'DEVICE',     sortKey: 'name',          width: null, fixed: true },
  { id: 'type',    label: 'TYPE', pickerLabel: 'Type',       sortKey: null,            width: 72 },
  { id: 'model',   label: 'MODEL', pickerLabel: 'Model',      sortKey: 'model',         width: null },
  { id: 'serial',  label: 'SERIAL', pickerLabel: 'Serial number',     sortKey: 'serial_number', width: 130 },
  { id: 'rack',    label: 'RACK', pickerLabel: 'Rack',       sortKey: 'rack_name',     width: 100 },
  { id: 'ip',      label: 'IP ADDRESS', pickerLabel: 'IP address', sortKey: 'ip_address',    width: null },
  { id: 'api',     label: 'API', pickerLabel: 'API',        sortKey: null,            width: 64 },
  { id: 'login',   label: 'LOGIN', pickerLabel: 'Login',      sortKey: null,            width: 90 },
  { id: 'ros',     label: 'ROS', pickerLabel: 'RouterOS version',        sortKey: 'ros_version',   width: 110 },
  { id: 'cpu',     label: 'CPU', pickerLabel: 'CPU',        sortKey: null,            width: 110 },
  { id: 'load',    label: 'LOAD', pickerLabel: 'Load',       sortKey: null,            width: 100 },
  { id: 'seen',    label: 'SEEN', pickerLabel: 'Last seen',       sortKey: 'last_seen',     width: 90 },
  { id: 'actions', label: '',           sortKey: null,            width: 56,  fixed: true, pickerLabel: 'Actions' },
];

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 800;
const KEY = 'devices.columns';

export interface ColumnPrefs {
  hidden: DeviceColumnId[];
  /** Widths the user dragged to, in px. */
  widths: Partial<Record<DeviceColumnId, number>>;
}

const known = new Set<string>(DEVICE_COLUMNS.map((c) => c.id));
const fixed = new Set<string>(DEVICE_COLUMNS.filter((c) => c.fixed).map((c) => c.id));

/** Tolerant of anything previously stored: unknown or fixed columns are dropped. */
export function parseColumnPrefs(raw: string | null): ColumnPrefs {
  const out: ColumnPrefs = { hidden: [], widths: {} };
  if (!raw) return out;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return out; }
  if (!v || typeof v !== 'object') return out;
  const o = v as { hidden?: unknown; widths?: unknown };
  if (Array.isArray(o.hidden)) {
    out.hidden = [...new Set(o.hidden.filter((h): h is DeviceColumnId =>
      typeof h === 'string' && known.has(h) && !fixed.has(h)))];
  }
  if (o.widths && typeof o.widths === 'object') {
    for (const [k, w] of Object.entries(o.widths as Record<string, unknown>)) {
      if (known.has(k) && typeof w === 'number' && Number.isFinite(w)) {
        out.widths[k as DeviceColumnId] = clampWidth(w);
      }
    }
  }
  return out;
}

export function clampWidth(w: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));
}

export function loadColumnPrefs(): ColumnPrefs {
  try { return parseColumnPrefs(localStorage.getItem(KEY)); } catch { return { hidden: [], widths: {} }; }
}

export function saveColumnPrefs(p: ColumnPrefs): void {
  try {
    if (p.hidden.length === 0 && Object.keys(p.widths).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* private mode */ }
}

export function visibleColumns(p: ColumnPrefs): DeviceColumn[] {
  return DEVICE_COLUMNS.filter((c) => c.fixed || !p.hidden.includes(c.id));
}
