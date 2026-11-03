import { query } from '../../config/database';
import { UPSTREAM_CANDIDATE, UPSTREAM_IS_TOP, UPSTREAM_LINK_ORDER } from '../../utils/clientPorts';

/**
 * Each device's way up, for the topology map's tiered layout (#367): the same
 * choice the client page's connection path makes (#363, #365), so the map and
 * that path agree. The gateway router has none, and is drawn on top.
 */
export interface WayUp {
  deviceId: number;
  /** The managed device it goes up to, when it is one. */
  upstreamDeviceId: number | null;
  /** The link it goes up over: for one the manager doesn't manage, the map finds the neighbour from it. */
  viaLinkId: number | null;
}

/** `scope` is an SQL condition on `d` (devices), or null for all. */
export async function deviceWaysUp(scope: string | null): Promise<WayUp[]> {
  const rows = await query<{ device_id: number; upstream_device_id: number | null; link_id: number | null }>(
    `SELECT d.id AS device_id, up.upstream_device_id, up.link_id
       FROM devices d
       JOIN LATERAL (
         SELECT x.* FROM (
           SELECT tl.id AS link_id, tl.to_device_id AS upstream_device_id, ${UPSTREAM_IS_TOP} AS is_top
             FROM topology_links tl
             LEFT JOIN devices ud ON ud.id = tl.to_device_id
            WHERE tl.from_device_id = d.id AND ${UPSTREAM_CANDIDATE}
            ORDER BY ${UPSTREAM_LINK_ORDER}
            LIMIT 1
         ) x WHERE NOT x.is_top
       ) up ON TRUE
      ${scope ? `WHERE ${scope}` : ''}`,
  );
  return rows.map((r) => ({
    deviceId: Number(r.device_id),
    upstreamDeviceId: r.upstream_device_id == null ? null : Number(r.upstream_device_id),
    viaLinkId: r.link_id == null ? null : Number(r.link_id),
  }));
}
