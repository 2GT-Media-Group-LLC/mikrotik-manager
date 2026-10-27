/**
 * Match a device's discovered neighbours to managed devices (topology_links.to_device_id).
 *
 * Runs after each neighbour collection. The Topology page also matches by MAC
 * when it draws the map; storing the match here lets everything else that
 * reads the links (a client's upstream, rollout waves, adoption) see it too.
 */
import { query } from '../../config/database';

export async function resolveNeighbourDevices(deviceId: number): Promise<void> {
  // Resolve neighbor_address to a known device, but only one in this
  // device's own site, and only when exactly one device there has that
  // address. Matching across the fleet joined two customers' networks
  // whenever both used the same management address, such as RouterOS's
  // default 192.168.88.1 (outside review P2-19).
  await query(
    `UPDATE topology_links tl
     SET to_device_id = m.id
     FROM (
       SELECT d.ip_address, MIN(d.id) AS id
         FROM devices d
        WHERE d.site_id IS NOT DISTINCT FROM (SELECT site_id FROM devices WHERE id = $1)
        GROUP BY d.ip_address
       HAVING COUNT(*) = 1
     ) m
     WHERE tl.from_device_id = $1
       AND m.ip_address = tl.neighbor_address
       AND tl.to_device_id IS DISTINCT FROM m.id`,
    [deviceId]
  );
  // A neighbour with no address on the link, such as a core switch managed
  // out of band, whose fabric side has no IP (#363): match it by MAC, as
  // the Topology page does, then by identity. Same rules as above: rows
  // still unmatched, devices in this site, exactly one device fitting. A
  // MAC two devices share (a VRRP virtual MAC) matches neither.
  await query(
    `UPDATE topology_links tl
     SET to_device_id = m.device_id
     FROM (
       SELECT x.mac, MIN(x.device_id) AS device_id
         FROM (
           SELECT UPPER(i.mac_address) AS mac, i.device_id FROM interfaces i WHERE i.mac_address IS NOT NULL
           UNION
           SELECT UPPER(w.mac_address), w.device_id FROM wireless_interfaces w WHERE w.mac_address IS NOT NULL
         ) x
         JOIN devices d ON d.id = x.device_id
        WHERE d.site_id IS NOT DISTINCT FROM (SELECT site_id FROM devices WHERE id = $1)
        GROUP BY x.mac
       HAVING COUNT(DISTINCT x.device_id) = 1
     ) m
     WHERE tl.from_device_id = $1
       AND tl.to_device_id IS NULL
       AND m.device_id <> $1
       AND m.mac = UPPER(tl.neighbor_mac)`,
    [deviceId]
  );
  await query(
    `UPDATE topology_links tl
     SET to_device_id = m.id
     FROM (
       SELECT d.name, MIN(d.id) AS id
         FROM devices d
        WHERE d.site_id IS NOT DISTINCT FROM (SELECT site_id FROM devices WHERE id = $1)
        GROUP BY d.name
       HAVING COUNT(*) = 1
     ) m
     WHERE tl.from_device_id = $1
       AND tl.to_device_id IS NULL
       AND m.id <> $1
       AND m.name = tl.neighbor_identity`,
    [deviceId]
  );
}
