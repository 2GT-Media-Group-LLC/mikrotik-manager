/**
 * The columns every device-shaped API response must carry.
 *
 * Five separate queries build a device payload -- the list, the detail read,
 * the location patch, and two paths in device creation -- and they had drifted:
 * adding site_id to the list alone left the detail page unable to see which
 * site a device was in, so the Site field showed "Unassigned" and appeared to
 * reject every change while the writes were in fact landing.
 *
 * Endpoints append their own extras (ssh_port, wifi_role, timestamps). This
 * constant only guarantees the shared core, so a column added here reaches
 * every response at once and cannot be half-applied again.
 */
export const DEVICE_BASE_COLUMNS = `
  id, name, ip_address, api_port, api_username, model, serial_number,
  firmware_version, ros_version, device_type, status, last_seen, notes, site_id
`.trim();
