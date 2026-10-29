/**
 * Where a client really is, and which way a device goes up (#363).
 *
 * A MAC has one `clients` row per device that learned it. On a switched
 * network every switch between the client and the router learns it, most of
 * them on an uplink, and picking the most recently polled row put the client
 * on a core switch's bond. These SQL fragments rank the sightings so the
 * switch that sees the client on an edge port wins.
 */

/**
 * The `clients` table as a FROM item, use as `FROM ${CLIENT_SIGHTINGS} c`,
 * with a wireless sighting on a CAPsMAN controller's copy of a CAP radio
 * moved to the CAP (#365).
 *
 * With traffic processed on the controller, the registration table is the
 * controller's: a client on the CAP is listed against the controller's name
 * for the CAP radio ("WAP-5Ghz"), and was shown on the controller, with the
 * CAP as its way up. capsman_radios knows which CAP that radio lives on. A
 * client on the radio itself moves to the CAP's interface for it; one on a
 * virtual AP (a guest SSID whose master is the radio) moves to the CAP and
 * keeps the controller's interface name, since the CAP's isn't known.
 *
 * Every `clients` column, plus `reported_by_device_id` (the device that
 * reported the sighting, which a disconnect has to go to) and `capsman_ssid`
 * (the SSID of the controller interface it was on; the CAP holds none).
 * A CAP that isn't a managed device leaves the sighting on the controller.
 */
export const CLIENT_SIGHTINGS = `(
  SELECT r.*, c0.device_id AS reported_by_device_id, cap.ssid AS capsman_ssid
    FROM clients c0
    LEFT JOIN LATERAL (
      SELECT cr.matched_device_id AS device_id,
             CASE WHEN cr.interface_name = c0.interface_name
                  THEN COALESCE(capwi.name, c0.interface_name)
                  ELSE c0.interface_name END AS interface_name,
             COALESCE(mwi.ssid, cr.ssid) AS ssid
        FROM capsman_radios cr
        LEFT JOIN wireless_interfaces mwi
          ON mwi.device_id = c0.device_id AND mwi.name = c0.interface_name
        LEFT JOIN wireless_interfaces capwi
          ON capwi.device_id = cr.matched_device_id AND capwi.radio_mac = cr.radio_mac
         AND COALESCE(capwi.config_json->>'master-interface', '') = ''
       WHERE c0.client_type = 'wireless'
         AND cr.controller_device_id = c0.device_id
         AND cr.local = false
         AND cr.matched_device_id IS NOT NULL
         AND cr.matched_device_id <> c0.device_id
         AND (cr.interface_name = c0.interface_name
              OR cr.interface_name = mwi.config_json->>'master-interface')
       ORDER BY (cr.interface_name = c0.interface_name) DESC, capwi.id
       LIMIT 1
    ) cap ON TRUE
    CROSS JOIN LATERAL jsonb_populate_record(c0, CASE WHEN cap.device_id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('device_id', cap.device_id, 'interface_name', cap.interface_name) END) r
)`;

/** A bond's member ports, as a text[] from the `interfaces` row aliased `alias`. */
const BOND_MEMBERS = (alias: string) =>
  `string_to_array(replace(COALESCE(${alias}.config_json->>'slaves', ''), ' ', ''), ',')`;

/**
 * `infra_ports(device_id, port)`: ports that face another managed device,
 * from the discovered neighbour links, for use in a WITH clause.
 *
 * A link counts when its neighbour is a managed device: matched by the
 * topology (to_device_id), or by address or identity where the topology left
 * it unmatched because several neighbours share the port (an unmanaged switch
 * in between). Neighbours that aren't managed (an unmanaged AP, a phone)
 * don't count, so clients behind them still land on the port they use.
 *
 * Both ends of a link are included, since each device names its own port.
 * RouterOS names a bridged port by its path ("bridge/Po1/sfp-sfpplus1"), so
 * the name is split and each part counts; a bridge's own name is excluded
 * where the rank is used (CLIENT_PORT_RANK), because traffic heard on the
 * bridge isn't on any one port.
 */
export const INFRA_PORTS_CTE = `infra_ports AS (
  WITH link_ports AS (
    SELECT tl.from_device_id AS device_id, p AS port
      FROM topology_links tl, unnest(string_to_array(tl.from_interface, '/')) AS p
     WHERE tl.to_device_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM devices nd
                    WHERE nd.id <> tl.from_device_id
                      AND (nd.ip_address = tl.neighbor_address OR nd.name = tl.neighbor_identity))
    UNION
    SELECT nd.id, p
      FROM topology_links tl
      JOIN devices nd ON nd.id = tl.to_device_id
                      OR (tl.to_device_id IS NULL AND (nd.ip_address = tl.neighbor_address OR nd.name = tl.neighbor_identity))
      CROSS JOIN LATERAL unnest(string_to_array(tl.to_interface, '/')) AS p
     WHERE nd.id <> tl.from_device_id
  )
  SELECT device_id, port FROM link_ports
  UNION
  -- The bond a link's member port belongs to: LLDP names the member
  -- (sfp-sfpplus1), the bridge host table the bond (Po1).
  SELECT bi.device_id, bi.name
    FROM interfaces bi
    JOIN link_ports lp ON lp.device_id = bi.device_id
   WHERE bi.type = 'bond'
     AND lp.port = ANY(${BOND_MEMBERS('bi')})
)`;

/**
 * How good a sighting `c` is, lower being better, for an ORDER BY: 0 on a
 * bridge port that faces no managed device (an edge port, where the client
 * is plugged in), 1 anywhere else (an address learned on a router's bridge
 * or VLAN interface), 2 on a port facing another managed device (an uplink,
 * bond or peer link). Needs INFRA_PORTS_CTE in the query's WITH clause.
 */
export const CLIENT_PORT_RANK = `(CASE
    WHEN EXISTS (SELECT 1 FROM infra_ports ip WHERE ip.device_id = c.device_id AND ip.port = c.interface_name)
     AND NOT EXISTS (SELECT 1 FROM bridge_vlan_entries bb WHERE bb.device_id = c.device_id AND bb.bridge = c.interface_name)
      THEN 2
    WHEN EXISTS (SELECT 1 FROM bridge_vlan_entries b WHERE b.device_id = c.device_id AND b.port = c.interface_name)
      THEN 0
    ELSE 1
  END)`;

/**
 * The sighting that says where a client is, best first. Columns of `clients c`.
 *
 * Current sightings (live, or seen in the last day) first. Then a live AP
 * registration, since the AP knows a wireless client best. Then the edge port
 * before an uplink (#363), then live before stale, then the latest.
 *
 * Live isn't first: overnight a switch's host table forgets a quiet PC while
 * the router's ARP table still lists it, and the router's VLAN interface won
 * over the switch port the PC is on (#363). Whether the client is online is a
 * separate question, answered from all its sightings (CLIENT_MAC_WINDOW).
 */
export const CLIENT_SIGHTING_ORDER =
  `(c.active OR c.last_seen > NOW() - INTERVAL '24 hours') DESC, (c.active AND c.client_type = 'wireless') DESC, ` +
  `${CLIENT_PORT_RANK} ASC, c.active DESC, c.last_seen DESC NULLS LAST`;

/**
 * Columns from all of a MAC's sightings, for a query that shows one row per
 * client: online when any device sees it live, last seen when any last did.
 * Needs `WINDOW mac AS (PARTITION BY c.mac_address)` in the query.
 */
export const CLIENT_MAC_COLUMNS =
  `bool_or(COALESCE(c.active, FALSE)) OVER mac AS mac_active, MAX(c.last_seen) OVER mac AS mac_last_seen`;

/** Put the per-client values over the chosen sighting's, for the response. */
export function withMacColumns<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  if ('mac_active' in out) { out.active = out.mac_active; delete out.mac_active; }
  if ('mac_last_seen' in out) { if (out.mac_last_seen != null) out.last_seen = out.mac_last_seen; delete out.mac_last_seen; }
  return out as T;
}

/**
 * Order of a device's links (`tl`, from device `d`, to device `ud`) when
 * choosing its way up: the spanning-tree root port when it has one (J7); then
 * not the link that leaves through the interface holding the device's
 * management address, when that's a port of its own (an out-of-band
 * management port; a bridge is in-band and shares the uplinks); then links on
 * a bridge port, which carry the network, before links on ports outside the
 * bridge; then links heard over LLDP; then a router before a switch before
 * anything else; then not a neighbour whose own way up is this device; then
 * the oldest.
 * On an MLAG/LACP fabric nothing is the root port, and the neighbour heard on
 * a management port used to win (#363).
 *
 * LLDP because bridges don't forward it, so an LLDP neighbour is at the other
 * end of the cable. MNDP and CDP pass through a bridge: an AP behind a switch
 * also hears the router through it, on the same port, and the router won (#365).
 *
 * The last two only break ties. The STP root bridge has no root port, and its
 * links up to the router and down to an AP tied, so it went up to the AP; two
 * switches without a root port each went up to the other (#365).
 *
 * Before all of it, a managed neighbour: one the manager doesn't manage is
 * only the way up when there's no other (UPSTREAM_CANDIDATE).
 */
function upstreamLinkOrder(d: string, tl: string, ud: string, mutual: boolean): string {
  return `(${tl}.to_device_id IS NULL) ASC,
       (${tl}.stp_role = 'root') DESC NULLS LAST,
       EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${d}.ip_addresses_jsonb) = 'array' THEN ${d}.ip_addresses_jsonb ELSE '[]'::jsonb END) a
          WHERE split_part(a->>'address', '/', 1) = ${d}.ip_address
            AND a->>'interface' = ANY(string_to_array(${tl}.from_interface, '/'))
            AND NOT EXISTS (SELECT 1 FROM bridge_vlan_entries mb WHERE mb.device_id = ${d}.id AND mb.bridge = a->>'interface')
       ) ASC,
       EXISTS (
         SELECT 1 FROM bridge_vlan_entries bp
          WHERE bp.device_id = ${tl}.from_device_id
            AND (bp.port = ANY(string_to_array(${tl}.from_interface, '/'))
                 -- a member of a bonded bridge port (#363): LLDP names sfp-sfpplus1, the bridge Po1
                 OR EXISTS (SELECT 1 FROM interfaces bi
                             WHERE bi.device_id = bp.device_id AND bi.name = bp.port AND bi.type = 'bond'
                               AND string_to_array(${tl}.from_interface, '/') && ${BOND_MEMBERS('bi')}))
       ) DESC,
       (COALESCE(${tl}.discovered_by, '') ILIKE '%lldp%') DESC,
       ${deviceTier(ud)} ASC,${mutual ? `
       ${goesUpThrough(tl, ud)} ASC,` : ''}
       ${tl}.id`;
}

/** Router, then switch, then anything else (a neighbour the manager doesn't manage too). */
const deviceTier = (alias: string) => `CASE ${alias}.device_type WHEN 'router' THEN 0 WHEN 'switch' THEN 1 ELSE 2 END`;

/** Whether the neighbour `ud` (at the far end of `tl`) would itself go up to `tl`'s device. */
function goesUpThrough(tl: string, ud: string): string {
  return `COALESCE((
         SELECT nl.to_device_id = ${tl}.from_device_id
           FROM topology_links nl
           JOIN devices nd ON nd.id = nl.to_device_id
          WHERE nl.from_device_id = ${tl}.to_device_id
          ORDER BY ${upstreamLinkOrder(ud, 'nl', 'nd', false)}
          LIMIT 1
       ), FALSE)`;
}

/**
 * Links that can be a device's way up: to a managed device, or to one the
 * manager doesn't manage that was heard over LLDP, so is at the other end of
 * the cable. CAPs behind an unmanaged switch had no way up at all (#365).
 */
export const UPSTREAM_CANDIDATE = `(tl.to_device_id IS NOT NULL OR COALESCE(tl.discovered_by, '') ILIKE '%lldp%')`;

/**
 * The chosen link (`tl`, from `d` to `ud`) leads down, not up: the neighbour
 * goes up through this device, and is a switch or AP under a router (or an AP
 * under a switch). This device is then the top of the site and has no way up.
 * The gateway router went up into its own LAN (#365). Two of a kind are left
 * alone: there, which is on top can't be told.
 */
export const UPSTREAM_IS_TOP = `(${deviceTier('d')} < ${deviceTier('ud')} AND ${goesUpThrough('tl', 'ud')})`;

/** The ORDER BY for a device's way up. The query needs `topology_links tl`, `devices d` (from) and `devices ud` (to). */
export const UPSTREAM_LINK_ORDER = upstreamLinkOrder('d', 'tl', 'ud', true);
