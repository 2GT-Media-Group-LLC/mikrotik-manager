import type { Device } from '../types';

/**
 * Whether a device has radios, whatever type it was added as. An all-in-one
 * router such as the hAP ac² (RBD52G) is added as a router but is an access
 * point too; the poller records that as wifi_role 'standalone'.
 */
const RADIO_ROLES = new Set(['standalone', 'cap', 'controller_cap']);

export function hasRadios(d: Pick<Device, 'device_type'> & { wifi_role?: string | null }): boolean {
  return d.device_type === 'wireless_ap' || RADIO_ROLES.has(d.wifi_role ?? 'none');
}

/** Covered by the wireless pages: radios of its own, or a CAPsMAN controller. */
export function isWirelessDevice(d: Pick<Device, 'device_type'> & { wifi_role?: string | null }): boolean {
  return hasRadios(d) || d.wifi_role === 'controller';
}
