import type { JumpHost } from '../services/api';
import { parsePort } from './parsePort';

/*
 * Who may point a jump host at another server, as the server decides it
 * (routes/jumpHosts.ts). A new address, port or host key sends the jump
 * host's login, and the saved passwords of the devices behind it, to whatever
 * answers there. So while devices use one only a fleet admin may, and anyone
 * else changing the address of one no device uses enters its login again.
 */

/** Its address, SSH port and host key are a fleet admin's to change, because devices use it. */
export function redirectLocked(j: Pick<JumpHost, 'device_count'>, fleetAdmin: boolean): boolean {
  return !fleetAdmin && j.device_count > 0;
}

/** The form gives a new address or SSH port, and this account has to enter the login again for that. */
export function loginNeededAgain(
  j: Pick<JumpHost, 'host' | 'port'>, form: { host: string; port: string }, fleetAdmin: boolean,
): boolean {
  if (fleetAdmin) return false;
  // An empty port keeps the saved one: the form sends none.
  return form.host.trim() !== j.host || (form.port !== '' && parsePort(form.port, 22) !== j.port);
}
