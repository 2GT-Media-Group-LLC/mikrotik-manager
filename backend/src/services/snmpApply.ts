import { query } from '../config/database';
import { siteScopeDevices } from '../utils/siteScope';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { fieldToWrite, unknownVariables, type SnmpDeviceVars } from '../utils/snmpTemplate';

/**
 * Applying SNMP settings to every online router or switch in scope.
 *
 * Shared by /routers/snmp and /switches/snmp, which were copies of each other.
 * Three changes from those copies:
 *
 *   - contact, location and trap target accept per-device variables (#164)
 *   - a blank field is left alone on the device instead of being written blank
 *   - the active site is respected; the page listed one site's devices while
 *     Apply wrote to every site
 */

export interface SnmpConfigInput {
  enabled: boolean;
  community_name: string;
  version: 'v1' | 'v2c' | 'v3';
  contact?: string;
  location?: string;
  trap_target?: string;
  auth_protocol?: string;
  auth_password?: string;
  priv_protocol?: string;
  priv_password?: string;
}

export class SnmpInputError extends Error {}

/** Throws SnmpInputError on anything that should be rejected before touching a device. */
export function validateSnmpInput(config: SnmpConfigInput): void {
  if (!config.community_name || !config.version) {
    throw new SnmpInputError('community_name and version are required');
  }
  const bad = [config.contact, config.location, config.trap_target]
    .flatMap((v) => (v ? unknownVariables(v) : []));
  if (bad.length) {
    throw new SnmpInputError(
      `Unknown variable ${bad.join(', ')}. Available: {identity}, {name}, {ip}, {model}, {serial}, {site}, {location}.`
    );
  }
}

export async function applySnmpConfig(
  deviceType: 'router' | 'switch',
  config: SnmpConfigInput,
  siteId: number | null | undefined
) {
  validateSnmpInput(config);

  const siteFilter = siteScopeDevices(siteId ?? null, 'd');
  const devices = await query<DeviceRow & { site_name: string | null }>(
    `SELECT d.*, s.name AS site_name
       FROM devices d LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.device_type = $1 AND d.status = 'online'
        ${siteFilter ? `AND ${siteFilter}` : ''}`,
    [deviceType]
  );

  const results = await Promise.allSettled(
    devices.map(async (d) => {
      const collector = new DeviceCollector(d);
      try {
        await collector.connect();
        // The RouterOS identity, read live, since the name in the manager can
        // differ from it.
        const identity = await collector.getSystemIdentity().catch(() => '');
        const vars: SnmpDeviceVars = {
          identity: identity || d.name,
          name: d.name,
          ip: d.ip_address,
          model: (d as { model?: string | null }).model ?? null,
          serial: (d as { serial_number?: string | null }).serial_number ?? null,
          site: d.site_name,
          location: (d as { location_address?: string | null }).location_address ?? null,
        };
        await collector.setSnmpConfig({
          ...config,
          contact: fieldToWrite(config.contact, vars),
          location: fieldToWrite(config.location, vars),
          trap_target: fieldToWrite(config.trap_target, vars),
        });
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
