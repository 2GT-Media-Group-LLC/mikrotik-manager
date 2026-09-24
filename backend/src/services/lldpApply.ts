import { query } from '../config/database';
import { siteScopeDevices } from '../utils/siteScope';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { type LldpDeviceType } from '../utils/lldpTargets';

export { LLDP_DEVICE_TYPES, parseDeviceTypes } from '../utils/lldpTargets';

/**
 * Reading and setting LLDP across the fleet.
 *
 * Every RouterOS device has `/ip/neighbor/discovery-settings`, access points
 * included, but the page only ever covered routers and switches: the two
 * copies of this code lived in /routers and /switches and filtered on their
 * own type. They now share this, and any device type can be targeted.
 *
 * The PUT side also ignored the active site, so Apply on one site's page wrote
 * to every site. Both directions are site-scoped now.
 */

async function onlineDevices(types: LldpDeviceType[], siteId: number | null | undefined): Promise<DeviceRow[]> {
  const siteFilter = siteScopeDevices(siteId ?? null);
  return query<DeviceRow>(
    `SELECT * FROM devices WHERE device_type::text = ANY($1::text[]) AND status = 'online'
       ${siteFilter ? `AND ${siteFilter}` : ''} ORDER BY name`,
    [types]
  );
}

export async function getLldpStatuses(types: LldpDeviceType[], siteId: number | null | undefined) {
  const devices = await onlineDevices(types, siteId);
  const results = await Promise.allSettled(
    devices.map(async (d) => {
      const collector = new DeviceCollector(d);
      try {
        await collector.connect();
        const lldp = await collector.getLldpEnabled();
        return { id: d.id, name: d.name, ip_address: d.ip_address, device_type: d.device_type, ...lldp };
      } finally {
        collector.disconnect();
      }
    })
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: devices[i].id,
          name: devices[i].name,
          ip_address: devices[i].ip_address,
          device_type: devices[i].device_type,
          enabled: null as boolean | null,
          protocol: null as string | null,
          error: (r.reason as Error).message,
        }
  );
}

export async function setLldpForTypes(
  types: LldpDeviceType[],
  enabled: boolean,
  siteId: number | null | undefined
) {
  const devices = await onlineDevices(types, siteId);
  const results = await Promise.allSettled(
    devices.map(async (d) => {
      const collector = new DeviceCollector(d);
      try {
        await collector.connect();
        await collector.setLldpEnabled(enabled);
        return { id: d.id, name: d.name, success: true };
      } finally {
        collector.disconnect();
      }
    })
  );
  const statuses = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: devices[i].id, name: devices[i].name, success: false, error: (r.reason as Error).message }
  );
  return { applied: statuses.filter((s) => s.success).length, total: devices.length, results: statuses };
}
