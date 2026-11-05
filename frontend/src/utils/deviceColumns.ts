import { columnStore, clampWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, type ColumnDef, type ColumnPrefs as GenericPrefs } from './columnPrefs';

/**
 * The Devices list's columns, and which of them a user has hidden or resized
 * (#283). Kept in this browser: it is a viewing preference, like sort order.
 */
export type DeviceColumnId =
  | 'status' | 'device' | 'type' | 'model' | 'serial' | 'rack' | 'ip'
  | 'api' | 'login' | 'ros' | 'cpu' | 'load' | 'seen' | 'actions';

export interface DeviceColumn extends ColumnDef<DeviceColumnId> {
  /** Sort key, when the header sorts. */
  sortKey: string | null;
}

export const DEVICE_COLUMNS: DeviceColumn[] = [
  { id: 'status',  label: '',           sortKey: null,            width: 22,  fixed: true },
  { id: 'device',  label: 'DEVICE',     sortKey: 'name',          width: null, fixed: true },
  { id: 'type',    label: 'TYPE', pickerLabel: 'Type',       sortKey: 'device_type',   width: 72 },
  { id: 'model',   label: 'MODEL', pickerLabel: 'Model',      sortKey: 'model',         width: null },
  { id: 'serial',  label: 'SERIAL', pickerLabel: 'Serial number',     sortKey: 'serial_number', width: 130 },
  { id: 'rack',    label: 'RACK', pickerLabel: 'Rack',       sortKey: 'rack_name',     width: 100 },
  { id: 'ip',      label: 'IP ADDRESS', pickerLabel: 'IP address', sortKey: 'ip_address',    width: null },
  { id: 'api',     label: 'API', pickerLabel: 'API',        sortKey: 'api',           width: 64 },
  { id: 'login',   label: 'LOGIN', pickerLabel: 'Login',      sortKey: 'login',         width: 90 },
  { id: 'ros',     label: 'ROS', pickerLabel: 'RouterOS version',        sortKey: 'ros_version',   width: 110 },
  { id: 'cpu',     label: 'CPU', pickerLabel: 'CPU',        sortKey: null,            width: 110 },
  { id: 'load',    label: 'LOAD', pickerLabel: 'Load',       sortKey: null,            width: 100 },
  { id: 'seen',    label: 'SEEN', pickerLabel: 'Last seen',       sortKey: 'last_seen',     width: 90 },
  { id: 'actions', label: '',           sortKey: null,            width: 150, fixed: true, pickerLabel: 'Actions' },
];

export { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, clampWidth };
export type ColumnPrefs = GenericPrefs<DeviceColumnId>;

const store = columnStore('devices.columns', DEVICE_COLUMNS);

/** Tolerant of anything previously stored: unknown or fixed columns are dropped. */
export const parseColumnPrefs = (raw: string | null): ColumnPrefs => store.parse(raw);
export const loadColumnPrefs = (): ColumnPrefs => store.load();
export const saveColumnPrefs = (p: ColumnPrefs): void => store.save(p);
export const visibleColumns = (p: ColumnPrefs): DeviceColumn[] => store.visible(p) as DeviceColumn[];
