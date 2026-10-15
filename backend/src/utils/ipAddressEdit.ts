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
