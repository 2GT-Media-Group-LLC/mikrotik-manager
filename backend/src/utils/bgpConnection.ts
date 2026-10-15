/**
 * A BGP connection to add, checked (the route used to pass the request body
 * to RouterOS as it came). RouterOS 7.20+ needs an instance, which carries the
 * local AS; 7.0–7.19 takes the local AS on the connection; 6 adds a peer.
 */
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
export const BGP_ROLES = ['ebgp', 'ibgp', 'ebgp-customer', 'ebgp-provider', 'ebgp-peer', 'ebgp-rs', 'ebgp-rs-client', 'ibgp-rr', 'ibgp-rr-client'] as const;

export interface BgpConnectionInput {
  name: string;
  remoteAddress: string;
  remoteAs: string;
  role: string;
  /** Used where the device has no instance yet (7.20+) or wants it on the connection (7.0–7.19). */
  localAs: string | null;
  instance: string | null;
}

const asn = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 4294967295 ? String(n) : null;
};

export function parseBgpConnection(body: Record<string, unknown>): BgpConnectionInput | { error: string } {
  const name = String(body.name ?? '').trim();
  if (!NAME.test(name)) return { error: 'Name is required: letters, digits, dot, dash or underscore' };
  const remoteAddress = String(body.remote_address ?? body['remote.address'] ?? '').trim();
  if (!IPV4.test(remoteAddress) && !(remoteAddress.includes(':') && IPV6.test(remoteAddress))) {
    return { error: 'Remote address must be an IP address' };
  }
  const remoteAs = asn(body.remote_as ?? body['remote.as']);
  if (!remoteAs) return { error: 'Remote AS must be a number from 1 to 4294967295' };
  const role = String(body.local_role ?? body['local.role'] ?? 'ebgp').trim();
  if (!(BGP_ROLES as readonly string[]).includes(role)) return { error: `Role must be one of ${BGP_ROLES.join(', ')}` };
  const rawLocal = body.local_as ?? body.as;
  const localAs = rawLocal === undefined || rawLocal === null || String(rawLocal).trim() === '' ? null : asn(rawLocal);
  if (rawLocal !== undefined && rawLocal !== null && String(rawLocal).trim() !== '' && !localAs) {
    return { error: 'Local AS must be a number from 1 to 4294967295' };
  }
  const rawInstance = String(body.instance ?? '').trim();
  if (rawInstance && !NAME.test(rawInstance)) return { error: 'Instance is not a valid name' };
  return { name, remoteAddress, remoteAs, role, localAs, instance: rawInstance || null };
}
