import { query } from '../config/database';
import { siteScopeDevices, type SiteScope } from '../utils/siteScope';
import { buildPairs, buildPeerLink, peerLinkFindings, type MlagBond, type MlagBridge, type MlagEvents, type MlagPair, type PeerLink, type PortFacts } from '../utils/mlag';
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
  const pairs = buildPairs(bridges, bonds, links, ev);
  await addPeerLinks(pairs, bonds, ids);
  return pairs;
}

const csv = (v: string | null | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Each pair's peer link in detail (#376): its members on both switches with
 * speed, link-downs, errors and the last flap, the VLANs it carries, and
 * whether each side's LACP partner is the other peer. All from what's stored.
 */
async function addPeerLinks(pairs: MlagPair[], bonds: MlagBond[], ids: number[]): Promise<void> {
  const peerBonds = bonds.filter((b) => b.is_peer_link);
  const members = [...new Set(peerBonds.flatMap((b) => (csv(b.slaves).length ? csv(b.slaves) : [b.bond])))];
  if (!pairs.length || !members.length) return;
  const [ports, macRows, vlanRows, linkRows, bootRows] = await Promise.all([
    query<PortFacts>(
      `SELECT i.device_id, i.name, i.running, COALESCE(NULLIF(i.link_rate, ''), NULLIF(i.speed, '')) AS speed,
              NULLIF(i.config_json->>'link-downs', '')::int AS link_downs,
              COALESCE((SELECT SUM(e.fcs + e.align + e.overflow + e.other)::float8 FROM interface_error_events e
                         WHERE e.device_id = i.device_id AND e.interface = i.name AND e.at > NOW() - INTERVAL '24 hours'), 0) AS errors_24h,
              (SELECT MAX(e.at) FROM interface_error_events e
                WHERE e.device_id = i.device_id AND e.interface = i.name AND e.link_downs > 0) AS last_down_at
         FROM interfaces i WHERE i.device_id = ANY($1::int[]) AND i.name = ANY($2::text[])`, [ids, members]),
    query<{ device_id: number; mac: string }>(
      `SELECT DISTINCT device_id, upper(mac_address) AS mac FROM interfaces WHERE device_id = ANY($1::int[]) AND mac_address IS NOT NULL`, [ids]),
    query<{ device_id: number; bridge: string; vlan_id: number; tagged_ports: string[] | null; current_tagged: string | null }>(
      `SELECT device_id, bridge, vlan_id, tagged_ports, config_json->>'current-tagged' AS current_tagged
         FROM vlans WHERE device_id = ANY($1::int[])`, [ids]),
    query<{ from_device_id: number; from_interface: string | null; to_device_id: number | null; to_interface: string | null }>(
      `SELECT from_device_id, from_interface, to_device_id, to_interface FROM topology_links
        WHERE from_device_id = ANY($1::int[]) AND to_device_id = ANY($1::int[])`, [ids]),
    // Boots in the window flaps are kept for, to tell a restart from a real flap.
    query<{ device_id: number; boot_at: string }>(
      `SELECT device_id, boot_at FROM device_reboots WHERE device_id = ANY($1::int[]) AND boot_at > NOW() - INTERVAL '8 days'`, [ids]),
  ]);
  const boots = new Map<number, string[]>();
  for (const r of bootRows) boots.set(r.device_id, [...(boots.get(r.device_id) ?? []), r.boot_at]);
  const macs = new Map<number, Set<string>>();
  for (const r of macRows) {
    if (!macs.has(r.device_id)) macs.set(r.device_id, new Set());
    macs.get(r.device_id)!.add(r.mac);
  }
  for (const pair of pairs) {
    // VLANs tagged on each side's peer port, as RouterOS has them now.
    const vlans = new Map<number, number[]>();
    for (const d of [pair.a, pair.b]) {
      if (!d) continue;
      const tagged = vlanRows.filter((v) => v.device_id === d.device_id && v.bridge === d.bridge_name
        && (v.current_tagged !== null ? csv(v.current_tagged) : v.tagged_ports ?? []).includes(d.mlag_peer_port));
      vlans.set(d.device_id, [...new Set(tagged.map((v) => v.vlan_id))]);
    }
    const view = buildPeerLink({ pair, ports, macs, vlans, links: linkRows, boots });
    pair.peerLink = view;
    const extra = peerLinkFindings(pair, view);
    if (extra.length) {
      pair.findings = [...extra, ...pair.findings];
      pair.status = 'critical';
    }
  }
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
