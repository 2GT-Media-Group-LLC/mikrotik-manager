/**
 * The fields an IP address edit may change (#285), checked and turned into
 * RouterOS names. Only what was sent is changed; an empty comment clears it.
 */
const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;
const IFACE = /^[^\s"\\;]{1,64}$/;

export function ipAddressEdit(body: Record<string, unknown>): { fields: Record<string, string> } | { error: string } {
  const fields: Record<string, string> = {};
  if (body.address !== undefined) {
    const a = String(body.address).trim();
    if (!IPV4_CIDR.test(a)) return { error: 'address must be an IPv4 address with a prefix length, e.g. 192.168.88.1/24' };
    const notHost = hostAddressProblem(a);
    if (notHost) return { error: notHost };
    fields.address = a;
  }
  if (body.interface !== undefined) {
    const i = String(body.interface).trim();
    if (!IFACE.test(i)) return { error: 'interface is not a valid interface name' };
    fields.interface = i;
  }
  if (body.comment !== undefined) {
    const c = String(body.comment);
    if (c.length > 255) return { error: 'comment is at most 255 characters' };
    fields.comment = c;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return { error: 'disabled must be true or false' };
    fields.disabled = body.disabled ? 'yes' : 'no';
  }
  if (Object.keys(fields).length === 0) return { error: 'Nothing to change' };
  return { fields };
}

const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/**
 * Why an address with a prefix isn't one an interface should carry, or null
 * (#505). RouterOS takes 192.168.33.0/24, but that is the network itself, and
 * the last address the broadcast; /31 and /32 have neither. Anything that
 * isn't an IPv4 address with a prefix is left to the other checks.
 */
export function hostAddressProblem(address: string): string | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(address.trim());
  if (!m || !IPV4_CIDR.test(address.trim())) return null;
  const len = Number(m[2]);
  if (len >= 31) return null;
  const size = 2 ** (32 - len);
  const ip = toInt(m[1]);
  const network = ip - (ip % size);
  if (ip === network) {
    return `${m[1]} is the network address of ${m[1]}/${len}, not one a device can use. Use a host address, such as ${toIp(network + 1)}/${len}.`;
  }
  if (ip === network + size - 1) {
    return `${m[1]} is the broadcast address of ${toIp(network)}/${len}, not one a device can use. Use a host address, such as ${toIp(network + size - 2)}/${len}.`;
  }
  return null;
}
