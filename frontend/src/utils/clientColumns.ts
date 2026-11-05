import { columnStore, type ColumnDef } from './columnPrefs';

/**
 * The Clients list's columns (#336). Which ones apply depends on the view:
 * SSID, signal and rate only for wireless clients, Type only when both kinds
 * are listed, Active only with inactive clients shown. Hiding and widths are
 * kept in this browser, across views.
 */
export type ClientColumnId =
  | 'host' | 'ip' | 'ssid' | 'signal' | 'rate' | 'type' | 'port' | 'vlan' | 'device' | 'data' | 'seen' | 'active';

export type ClientView = 'wireless' | 'wired' | 'all';

export interface ClientColumn extends ColumnDef<ClientColumnId> {
  /** The sort the header asks for, when it sorts. */
  sortCol: string | null;
  /** Views it belongs in; omitted means every view. */
  views?: ClientView[];
  /** Only with inactive clients shown. */
  showAllOnly?: boolean;
}

export const CLIENT_COLUMNS: ClientColumn[] = [
  { id: 'host',   label: 'Host / Vendor / MAC', sortCol: 'hostname',            width: null, fixed: true },
  { id: 'ip',     label: 'IP Address',          sortCol: 'ip_address',          width: 168 },
  { id: 'ssid',   label: 'SSID',                sortCol: 'ssid',                width: 140, views: ['wireless'] },
  { id: 'signal', label: 'Signal',              sortCol: 'signal_strength',     width: 150, views: ['wireless'] },
  { id: 'rate',   label: 'Rate',                sortCol: 'tx_rate_bps',         width: 120, views: ['wireless'] },
  { id: 'type',   label: 'Type',                sortCol: 'client_type',         width: 150, views: ['all'] },
  { id: 'port',   label: 'Port',                sortCol: 'interface_name',      width: 140 },
  { id: 'vlan',   label: 'VLAN',                sortCol: 'vlan_id',             width: 80 },
  { id: 'device', label: 'Device',              sortCol: 'device_name',         width: 160 },
  { id: 'data',   label: 'Data (today)',        sortCol: 'traffic_today_bytes', width: 120 },
  { id: 'seen',   label: 'Last Seen',           sortCol: 'last_seen',           width: 130 },
  { id: 'active', label: 'Active',              sortCol: null,                  width: 80, showAllOnly: true },
];

const store = columnStore('clients.columns', CLIENT_COLUMNS);
export const loadClientColumnPrefs = store.load;
export const saveClientColumnPrefs = store.save;
export const parseClientColumnPrefs = store.parse;

/** The columns to draw for this view, without the hidden ones. */
export function clientColumnsFor(prefs: ReturnType<typeof store.load>, view: ClientView, showAll: boolean): ClientColumn[] {
  return (store.visible(prefs) as ClientColumn[])
    .filter((c) => (!c.views || c.views.includes(view)) && (!c.showAllOnly || showAll));
}
