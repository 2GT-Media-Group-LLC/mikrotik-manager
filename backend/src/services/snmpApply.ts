import { query } from '../config/database';
import { siteScopeDevices, type SiteScope } from '../utils/siteScope';
import { DeviceCollector, type DeviceRow } from './mikrotik/DeviceCollector';
import { effectiveLocation } from '../utils/effectiveLocation';
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

/**
 * A fleet change. Every field is optional: only what is present is written.
 * The form used to require community, version and on/off, prefilled from one
 * device, so "apply to all" pushed that device's settings to the whole fleet
 * (P1-11).
 */
export interface SnmpConfigInput {
  enabled?: boolean;
  community_name?: string;
  version?: 'v1' | 'v2c' | 'v3';
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
  const changesSomething =
    typeof config.enabled === 'boolean' || !!config.community_name?.trim() || !!config.version ||
    !!config.contact?.trim() || !!config.location?.trim() || !!config.trap_target?.trim();
  if (!changesSomething) throw new SnmpInputError('Nothing to change: pick at least one setting to apply');
  if (config.version && !['v1', 'v2c', 'v3'].includes(config.version)) {
    throw new SnmpInputError('version must be v1, v2c or v3');
  }
  if (config.version === 'v3' && !config.community_name?.trim()) {
    throw new SnmpInputError('SNMPv3 needs the user name to set it up on');
  }
  const bad = [config.contact, config.location, config.trap_target]
    .flatMap((v) => (v ? unknownVariables(v) : []));
  if (bad.length) {
    throw new SnmpInputError(
      `Unknown variable ${bad.join(', ')}. Available: {identity}, {name}, {ip}, {model}, {serial}, {site}, {location}.`
    );
  }
}

/** Which devices a change goes to. Always explicit: there is no "everything" default. */
export type SnmpTarget =
  | { deviceIds: number[] }                 // the devices the operator picked
  | { all: true; deviceTypes?: string[] };  // every online device in the site (optionally of some types)

/**
 * Apply SNMP settings to the chosen online devices in the active site, of any
 * type (routers, switches, access points and anything else running RouterOS).
 * Devices that are offline or in another site are skipped, and listed.
 */
export async function applySnmpConfig(
  target: SnmpTarget,
  config: SnmpConfigInput,
  siteId: SiteScope | undefined
) {
  validateSnmpInput(config);
  if ('deviceIds' in target && target.deviceIds.length === 0) {
    throw new SnmpInputError('Choose at least one device');
  }

  const siteFilter = siteScopeDevices(siteId ?? null, 'd');
  const params: unknown[] = [];
  const where: string[] = [`d.status = 'online'`, 'NOT d.ssh_only'];
  if ('deviceIds' in target) {
    params.push(target.deviceIds);
    where.push(`d.id = ANY($${params.length}::int[])`);
  } else if (target.deviceTypes?.length) {
    params.push(target.deviceTypes);
    where.push(`d.device_type = ANY($${params.length}::text[])`);
  }
  if (siteFilter) where.push(siteFilter);

  const devices = await query<DeviceRow & {
    site_name: string | null; site_address: string | null; site_lat: string | null; site_lng: string | null;
  }>(
    `SELECT d.*, s.name AS site_name, s.address AS site_address,
            s.location_lat AS site_lat, s.location_lng AS site_lng
       FROM devices d LEFT JOIN sites s ON s.id = d.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.name`,
    params
  );
  const skipped = 'deviceIds' in target
    ? target.deviceIds.filter((id) => !devices.some((d) => d.id === id))
    : [];

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
          // The device's own location, or its site's when it has none (#167).
          location: effectiveLocation(
            d as { location_address?: string | null },
            { address: d.site_address, location_lat: d.site_lat, location_lng: d.site_lng }
          )?.address ?? null,
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
  const applied = statuses.filter((s) => s.success).length;
  if (applied > 0) await saveSnmpTemplates(config).catch(() => { /* remembering is a convenience */ });
  return { applied, total: devices.length, results: statuses, skipped };
}

/**
 * The contact, location and trap destination as last typed, variables and all
 * (#164). Devices only hold the filled-in result, so without this the form
 * came back showing one device's value instead of `{identity}@example.com`.
 */
export type SnmpTemplates = Partial<Record<'contact' | 'location' | 'trap_target', string>>;
const TEMPLATES_KEY = 'snmp_field_templates';

export async function getSnmpTemplates(): Promise<SnmpTemplates> {
  const [row] = await query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [TEMPLATES_KEY]);
  const v = row?.value;
  return v && typeof v === 'object' ? (v as SnmpTemplates) : {};
}

async function saveSnmpTemplates(config: SnmpConfigInput): Promise<void> {
  const changes: SnmpTemplates = {};
  for (const f of ['contact', 'location', 'trap_target'] as const) {
    const v = config[f]?.trim();
    if (v) changes[f] = v;
  }
  if (!Object.keys(changes).length) return;
  const merged = { ...(await getSnmpTemplates()), ...changes };
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [TEMPLATES_KEY, JSON.stringify(merged)]
  );
}

/** Current SNMP settings of every online device in the site, of any type. */
export async function getSnmpStatuses(siteId: SiteScope | undefined, deviceTypes?: string[]) {
  const siteFilter = siteScopeDevices(siteId ?? null);
  const params: unknown[] = [];
  const where = [`status = 'online'`, 'NOT ssh_only'];
  if (deviceTypes?.length) { params.push(deviceTypes); where.push(`device_type = ANY($1::text[])`); }
  if (siteFilter) where.push(siteFilter);
  const devices = await query<DeviceRow>(
    `SELECT * FROM devices WHERE ${where.join(' AND ')} ORDER BY name`, params
  );
  const results = await Promise.allSettled(
    devices.map(async (d) => {
      const collector = new DeviceCollector(d);
      try {
        await collector.connect();
        const snmp = await collector.getSnmpConfig();
        return { id: d.id, name: d.name, ip_address: d.ip_address, device_type: d.device_type, ...snmp };
      } finally {
        collector.disconnect();
      }
    })
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: devices[i].id, name: devices[i].name, ip_address: devices[i].ip_address,
          device_type: devices[i].device_type, enabled: null as boolean | null, error: (r.reason as Error).message,
        }
  );
}
