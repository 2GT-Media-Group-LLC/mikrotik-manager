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
