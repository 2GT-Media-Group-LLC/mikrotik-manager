import { query } from '../config/database';
import { siteScopeDevices, type SiteScope } from '../utils/siteScope';
import { buildPairs, type MlagBond, type MlagBridge, type MlagEvents, type MlagPair, type PeerLink } from '../utils/mlag';
import { alertService } from './AlertService';

/**
 * MLAG pairs (#376), from what the slow polls stored: each pair's state, peer
 * link, bonds side by side and health checks. For the MLAG page and the
 * "MLAG degraded" alert.
 */
export async function loadMlagPairs(scope: SiteScope | null): Promise<MlagPair[]> {
  const filter = siteScopeDevices(scope, 'd');
  const bridges = await query<MlagBridge>(
    `SELECT b.device_id, d.name AS device_name, d.ros_version, b.bridge_name, b.mlag_peer_port, b.mlag_priority,
            b.mlag_heartbeat, b.mlag_init_delay, b.mlag_lacp_fallback, b.mlag_state, b.mlag_role,
            b.mlag_state_changed_at, b.mlag_missing_vlans
       FROM device_bridges b JOIN devices d ON d.id = b.device_id
      WHERE b.mlag_peer_port IS NOT NULL ${filter ? `AND ${filter}` : ''}
      ORDER BY d.name`);
  if (bridges.length === 0) return [];
  const ids = [...new Set(bridges.map((b) => b.device_id))];
  const [bonds, links, events] = await Promise.all([
    // The LACP partner is a managed device when its system ID is one of a device's MACs.
    query<MlagBond>(
      `SELECT m.*, (SELECT d2.name FROM interfaces i JOIN devices d2 ON d2.id = i.device_id
                     WHERE upper(i.mac_address) = m.partner_sys_id LIMIT 1) AS partner_device_name
         FROM mlag_bonds m WHERE m.device_id = ANY($1::int[])`, [ids]),
    query<PeerLink>(
      `SELECT from_device_id, from_interface, to_device_id FROM topology_links
        WHERE from_device_id = ANY($1::int[]) AND to_device_id IS NOT NULL`, [ids]),
    query<{ device_id: number; hb: string; fdb: string; pl: string }>(
      `SELECT device_id,
              COUNT(*) FILTER (WHERE event_time > NOW() - INTERVAL '1 hour' AND message ILIKE '%heartbeat timeout%') AS hb,
              COUNT(*) FILTER (WHERE event_time > NOW() - INTERVAL '1 hour' AND message ILIKE '%failed to sync%') AS fdb,
              COUNT(*) FILTER (WHERE message ILIKE '%peer link down%') AS pl
         FROM events
        WHERE device_id = ANY($1::int[]) AND event_time > NOW() - INTERVAL '24 hours'
          AND (message ILIKE '%mlag%' OR message ILIKE '%peer link%' OR message ILIKE '%failed to sync%')
        GROUP BY device_id`, [ids]),
  ]);
  const ev = new Map<number, MlagEvents>(events.map((e) => [Number(e.device_id),
    { heartbeatHour: Number(e.hb), fdbFailHour: Number(e.fdb), peerLinkDownDay: Number(e.pl) }]));
  return buildPairs(bridges, bonds, links, ev);
}

/** Whether any device in view runs MLAG: the sidebar shows the page only then. */
export async function mlagPresent(scope: SiteScope | null): Promise<boolean> {
  const filter = siteScopeDevices(scope, 'd');
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM device_bridges b JOIN devices d ON d.id = b.device_id
      WHERE b.mlag_peer_port IS NOT NULL ${filter ? `AND ${filter}` : ''}`);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** "MLAG degraded" (#376): every critical finding, one alert per pair and check, per cooldown. */
export async function checkMlag(): Promise<void> {
  const rule = await alertService.getRule('mlag_degraded');
  if (!rule?.enabled) return;
  for (const pair of await loadMlagPairs(null)) {
    const name = pair.b ? `${pair.a.device_name.trim()} / ${pair.b.device_name.trim()}` : pair.a.device_name.trim();
    for (const f of pair.findings.filter((x) => x.severity === 'critical')) {
      await alertService.dispatch('mlag_degraded', `MLAG ${name}: ${f.text}`, {
        deviceId: pair.a.device_id, deviceName: pair.a.device_name.trim(),
        cooldownKey: `mlag_degraded:${pair.a.device_id}:${pair.b?.device_id ?? ''}:${f.code}`,
      });
    }
  }
}
