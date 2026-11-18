// Firewall Logs display settings (#415): the port names an admin adds or
// overrides, and the row colours for DHCP and multicast/broadcast.

export const FIREWALL_LOG_SERVICES_KEY = 'firewall_log_services';
export const FIREWALL_LOG_COLORS_KEY = 'firewall_log_colors';

export const SERVICES_MAX = 1000;
const COLORS = ['none', 'gray', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'violet', 'pink'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+/()-]{0,31}$/;

/** Why the saved port names would be refused, or null when they're fine. */
export function servicesError(v: unknown): string | null {
  if (!Array.isArray(v)) return 'firewall_log_services must be a list.';
  if (v.length > SERVICES_MAX) return `firewall_log_services holds at most ${SERVICES_MAX} entries.`;
  const seen = new Set<string>();
  const ranges: { p: string; lo: number; hi: number }[] = [];
  for (const [i, s] of v.entries()) {
    const at = `Entry ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return `${at} must be an object.`;
    const { port, to, protocol, name } = s as Record<string, unknown>;
    const keys = Object.keys(s);
    if (keys.some((k) => !['port', 'to', 'protocol', 'name'].includes(k))) return `${at} has fields other than port, to, protocol and name.`;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return `${at}: the port must be a whole number from 1 to 65535.`;
    // A range (#415): `to` is its last port.
    if (to !== undefined && (!Number.isInteger(to) || (to as number) <= (port as number) || (to as number) > 65535)) {
      return `${at}: the end of the range must be a whole number above ${port as number}, up to 65535.`;
    }
    if (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'both') return `${at}: the protocol must be tcp, udp or both.`;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return `${at}: the name must be 1 to 32 letters, digits, spaces or . _ + / ( ) -, starting with a letter or digit.`;
    }
    for (const p of protocol === 'both' ? ['tcp', 'udp'] : [protocol]) {
      if (to === undefined) {
        const k = `${p}/${port}`;
        if (seen.has(k)) return `${p.toUpperCase()} port ${port} is listed twice.`;
        seen.add(k);
        continue;
      }
      const lo = port as number;
      const hi = to as number;
      // A single port inside a range names that port; two ranges can't share one.
      const clash = ranges.find((r) => r.p === p && r.lo <= hi && lo <= r.hi);
      if (clash) return `${p.toUpperCase()} ports ${clash.lo}-${clash.hi} and ${lo}-${hi} overlap.`;
      ranges.push({ p, lo, hi });
    }
  }
  return null;
}

/** Why the saved colours would be refused, or null when they're fine. */
export function colorsError(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'firewall_log_colors must be an object.';
  for (const [k, c] of Object.entries(v)) {
    if (k !== 'dhcp' && k !== 'multicast') return 'firewall_log_colors takes only dhcp and multicast.';
    if (typeof c !== 'string' || !COLORS.includes(c)) return `firewall_log_colors.${k} must be one of ${COLORS.join(', ')}.`;
  }
  return null;
}
