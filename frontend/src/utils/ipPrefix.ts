import { isValidIPv4, isValidIPv6 } from './deviceAddress';

/** An IPv4/IPv6 address, optionally with a prefix length ("10.0.0.0/8", "2001:db8::/32"). */
export function isIpOrPrefix(entry: string): boolean {
  const parts = entry.trim().split('/');
  if (parts.length > 2) return false;
  const [ip, len] = parts;
  const v4 = isValidIPv4(ip);
  if (!v4 && !isValidIPv6(ip)) return false;
  if (len === undefined) return true;
  if (!/^\d{1,3}$/.test(len)) return false;
  return Number(len) <= (v4 ? 32 : 128);
}

/** Split a pasted or stored list ("a, b c\nd") into entries. */
export function splitList(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

const v4ToInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const intToV4 = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/**
 * Why an IPv4 address with a prefix isn't one an interface should carry, or
 * null (#505): the network address (192.168.33.0/24) or the broadcast. /31 and
 * /32 have neither. The server refuses the same.
 */
export function hostAddressProblem(address: string): string | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(address.trim());
  if (!m || !isValidIPv4(m[1])) return null;
  const len = Number(m[2]);
  if (len > 30) return null;
  const size = 2 ** (32 - len);
  const ip = v4ToInt(m[1]);
  const network = ip - (ip % size);
  if (ip === network) {
    return `${m[1]} is the network address of ${m[1]}/${len}, not one a device can use. Use a host address, such as ${intToV4(network + 1)}/${len}.`;
  }
  if (ip === network + size - 1) {
    return `${m[1]} is the broadcast address of ${intToV4(network)}/${len}, not one a device can use. Use a host address, such as ${intToV4(network + size - 2)}/${len}.`;
  }
  return null;
}
