import { query } from '../config/database';
import { wirelessDeviceSql, REMOTE_MANAGED_RADIO } from './mikrotik/capsman';
import { siteScopeByDevice, type SiteScope } from '../utils/siteScope';
import { analyzeSpectrum, summarize, parseChannelSpec, type SpectrumSummary } from '../utils/rfSpectrum';

export interface ChannelLocation {
  key: string;
  name: string;
  controller_device_id: number | null;
  radios: number;
  summary: SpectrumSummary;
}

export interface ChannelRadio {
  device_id: number;
  device_name: string;
  name: string;
  ssid: string | null;
  frequency: number;
  channel_width: string | null;
  registered_clients: number;
  controller_device_id: number | null;
  controller_name: string | null;
  location_key: string;
  low_mhz: number;
  high_mhz: number;
  width_mhz: number;
  channel: number | null;
  overlap: 'clear' | 'co-channel' | 'partial';
  clashes: Array<{
    kind: 'co-channel' | 'partial';
    overlap_mhz: number;
    device_name: string | null;
    interface_name: string | null;
    channel: number | null;
  }>;
}

/**
 * Radios with their actual spectrum occupancy, for Channel Usage and the
 * dashboard's co-channel insight.
 *
 * Radios carry the CAPsMAN controller that provisions them, because channel
 * planning is per physical location: two APs on channel 6 in different
 * buildings are not a conflict (issue #97). Each controller is a location, and
 * so are each site's standalone APs: radios at different sites can't hear each
 * other either (#365).
 */
export async function channelUsage(siteId: SiteScope, deviceId: number | null = null): Promise<{
  radios: ChannelRadio[]; locations: ChannelLocation[];
}> {
  const siteFilter = siteScopeByDevice(siteId, 'wi.device_id');

  // Two sources, because a CAPsMAN-managed AP stores no frequency of its own — the
  // controller owns the channel. Reading only wireless_interfaces silently dropped
  // every managed radio, which left them out of the analysis entirely and pushed
  // whatever remained into "standalone" (issue #97).
  const rows = await query<{
    device_id: number; device_name: string; name: string; ssid: string | null;
    frequency: number | null; channel_width: string | null;
    registered_clients: number | null;
    controller_device_id: number | null; controller_name: string | null;
    capsman_channel: string | null; capsman_peers: number | null;
    site_id: number | null; site_name: string | null;
  }>(`
    SELECT wi.device_id, d.name AS device_name, wi.name, wi.ssid,
           wi.frequency, wi.channel_width, wi.registered_clients,
           COALESCE(cr.controller_device_id, mr.controller_device_id) AS controller_device_id,
           COALESCE(cd.name, CASE WHEN mr.id IS NOT NULL THEN d.name END) AS controller_name,
           COALESCE(cr.current_channel, mr.current_channel) AS capsman_channel,
           COALESCE(cr.registered_peers, mr.registered_peers) AS capsman_peers,
           d.site_id, s.name AS site_name
    FROM wireless_interfaces wi
    JOIN devices d ON d.id = wi.device_id
    LEFT JOIN sites s ON s.id = d.site_id
    LEFT JOIN capsman_radios cr ON cr.matched_device_id = wi.device_id
                               AND cr.radio_mac = wi.radio_mac
    LEFT JOIN devices cd ON cd.id = cr.controller_device_id
    -- A controller's copy of the radio of a CAP that isn't a managed device:
    -- the only view of that radio there is, so it stays, under its controller.
    LEFT JOIN LATERAL (
      SELECT r.id, r.controller_device_id, r.current_channel, r.registered_peers
        FROM capsman_radios r
       WHERE r.controller_device_id = wi.device_id AND r.local = false AND r.matched_device_id IS NULL
         AND (r.interface_name = wi.name OR (wi.radio_mac IS NOT NULL AND r.radio_mac = wi.radio_mac))
       LIMIT 1
    ) mr ON cr.id IS NULL
    WHERE ${wirelessDeviceSql('d')}
      AND wi.disabled = FALSE
      AND (wi.config_json->>'master-interface') IS NULL
      -- A controller's copy of a managed CAP's radio: the CAP's own row
      -- stands for it, and the copy showed up again as a standalone AP (#365).
      AND NOT EXISTS (${REMOTE_MANAGED_RADIO})
      AND (
        (wi.frequency IS NOT NULL AND wi.frequency > 0)
        OR cr.current_channel IS NOT NULL
        OR mr.current_channel IS NOT NULL
      )
      ${deviceId ? 'AND wi.device_id = $1' : ''}
      ${siteFilter ? `AND ${siteFilter}` : ''}
    ORDER BY d.name ASC, wi.name ASC
  `, deviceId ? [deviceId] : []);

  // Resolve each radio's operating channel, preferring what the controller reports.
  const resolved = rows.map(({ site_id, site_name, capsman_channel, capsman_peers, ...r }) => {
    const fromController = parseChannelSpec(capsman_channel);
    const frequency = fromController?.frequency ?? r.frequency ?? 0;
    const channel_width = fromController ? `${fromController.widthMhz}mhz` : r.channel_width;
    return {
      ...r,
      frequency,
      channel_width,
      registered_clients: capsman_peers ?? r.registered_clients ?? 0,
      location_key: r.controller_device_id != null ? `c:${r.controller_device_id}` : `s:${site_id ?? 'none'}`,
      site_name,
    };
  }).filter((r) => r.frequency > 0);

  // Interference is only meaningful between radios that can hear each other, so
  // the analysis runs per location: each controller separately, and each
  // site's unmanaged APs as one group.
  const groups = new Map<string, typeof resolved>();
  for (const r of resolved) groups.set(r.location_key, [...(groups.get(r.location_key) ?? []), r]);

  const radios: ChannelRadio[] = [];
  for (const group of groups.values()) {
    const verdicts = analyzeSpectrum(group);
    group.forEach(({ site_name: _site, ...r }, i) => {
      const v = verdicts[i];
      radios.push({
        ...r,
        low_mhz: v.spectrum.lowMhz,
        high_mhz: v.spectrum.highMhz,
        width_mhz: v.spectrum.widthMhz,
        channel: v.spectrum.channel,
        overlap: v.kind,
        clashes: v.clashes.map((c) => ({
          kind: c.kind,
          overlap_mhz: c.overlapMhz,
          device_name: group[c.with]?.device_name ?? null,
          interface_name: group[c.with]?.name ?? null,
          channel: verdicts[c.with].spectrum.channel,
        })),
      });
    });
  }

  // Standalone APs are named by site only when there's more than one such group.
  const standaloneGroups = [...groups.keys()].filter((k) => k.startsWith('s:')).length;
  const locations = [...groups.entries()].map(([key, group]) => ({
    key,
    name: group[0]?.controller_name
      ?? (standaloneGroups > 1
        ? `Standalone access points · ${group[0]?.site_name ?? 'No site'}`
        : 'Standalone access points'),
    controller_device_id: group[0]?.controller_device_id ?? null,
    radios: group.length,
    summary: summarize(analyzeSpectrum(group)),
  }));

  return { radios, locations };
}
