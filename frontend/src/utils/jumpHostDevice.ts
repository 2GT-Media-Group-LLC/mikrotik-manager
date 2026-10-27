import type { JumpHost } from '../services/api';
import type { AddDevicePrefill } from '../components/devices/AddDeviceModal';

/**
 * Add Device filled in from a jump host just added, so the router can be
 * monitored as a device without typing it all again. It is reached directly:
 * it is the router the manager connects to. A password login is the device's
 * login too; a private key can't log in to the API, so only its username is
 * filled in. The password is passed from the form in the browser, never read
 * back from the server.
 */
export function deviceFromJumpHost(
  j: Pick<JumpHost, 'name' | 'host' | 'port' | 'site_id' | 'auth' | 'username' | 'credential_preset_id'>,
  password: string,
): AddDevicePrefill {
  const login: AddDevicePrefill = j.auth === 'preset' && j.credential_preset_id != null
    ? { credential_preset_id: j.credential_preset_id }
    : { api_username: j.username ?? '', ...(j.auth === 'password' && password ? { api_password: password } : {}) };
  return {
    name: j.name,
    ip_address: j.host,
    ...(j.site_id != null ? { site_id: j.site_id } : {}),
    ...(j.port !== 22 ? { ssh_port: j.port } : {}),
    jump_host_id: null,
    ...login,
  };
}
