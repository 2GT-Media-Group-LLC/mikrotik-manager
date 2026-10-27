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
 * The best sighting first: live before stale, the AP's view of a wireless
 * client before a switch's, then the edge port before an uplink, then the
 * latest. Columns of `clients c`.
 */
export const CLIENT_SIGHTING_ORDER =
  `c.active DESC, (c.client_type = 'wireless') DESC, ${CLIENT_PORT_RANK} ASC, c.last_seen DESC NULLS LAST`;

/**
 * Order of a device's links (`tl`, from device `d`) when choosing its way
 * up: the spanning-tree root port when it has one (J7); then not the link
 * that leaves through the interface holding the device's management address,
 * when that's a port of its own (an out-of-band management port; a bridge is
 * in-band and shares the uplinks); then links on a bridge port, which carry
 * the network, before links on ports outside the bridge; then the oldest.
 * On an MLAG/LACP fabric nothing is the root port, and the neighbour heard on
 * a management port used to win (#363).
 */
export const UPSTREAM_LINK_ORDER = `(tl.stp_role = 'root') DESC NULLS LAST,
       EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.ip_addresses_jsonb) = 'array' THEN d.ip_addresses_jsonb ELSE '[]'::jsonb END) a
          WHERE split_part(a->>'address', '/', 1) = d.ip_address
            AND a->>'interface' = ANY(string_to_array(tl.from_interface, '/'))
            AND NOT EXISTS (SELECT 1 FROM bridge_vlan_entries mb WHERE mb.device_id = d.id AND mb.bridge = a->>'interface')
       ) ASC,
       EXISTS (
         SELECT 1 FROM bridge_vlan_entries bp
          WHERE bp.device_id = tl.from_device_id AND bp.port = ANY(string_to_array(tl.from_interface, '/'))
       ) DESC,
       tl.id`;
