// Flow → application category classification by IP protocol + well-known port.
// Port-based heuristics (no DPI): good enough to distinguish web, DNS, VPN,
// mail, etc. The remote endpoint's port is matched first — a client browsing
// uses an ephemeral local port and the service's well-known remote port.

const TCP = 6;
const UDP = 17;
const ICMP = 1;
const ICMPV6 = 58;

export const APP_LAN = 'LAN';
export const APP_OTHER = 'Other';

// `${protocol}/${port}` → category
const PORT_MAP: Record<string, string> = {
  [`${TCP}/443`]: 'HTTPS',
  [`${UDP}/443`]: 'QUIC',
  [`${TCP}/80`]: 'HTTP',
  [`${UDP}/80`]: 'HTTP',
  [`${TCP}/53`]: 'DNS',
  [`${UDP}/53`]: 'DNS',
  [`${TCP}/853`]: 'DNS over TLS',
  [`${UDP}/853`]: 'DNS over TLS',
  [`${TCP}/22`]: 'SSH',
  [`${TCP}/23`]: 'Telnet',
  [`${TCP}/25`]: 'Email',
  [`${TCP}/465`]: 'Email',
  [`${TCP}/587`]: 'Email',
  [`${TCP}/110`]: 'Email',
  [`${TCP}/995`]: 'Email',
  [`${TCP}/143`]: 'Email',
  [`${TCP}/993`]: 'Email',
  [`${UDP}/123`]: 'NTP',
  [`${UDP}/51820`]: 'WireGuard',
  [`${UDP}/500`]: 'IPsec',
  [`${UDP}/4500`]: 'IPsec',
  [`${TCP}/1723`]: 'VPN (PPTP)',
  [`${TCP}/1194`]: 'OpenVPN',
  [`${UDP}/1194`]: 'OpenVPN',
  [`${TCP}/3389`]: 'RDP',
  [`${UDP}/3389`]: 'RDP',
  [`${TCP}/445`]: 'SMB',
  [`${TCP}/139`]: 'SMB',
  [`${TCP}/21`]: 'FTP',
  [`${UDP}/67`]: 'DHCP',
  [`${UDP}/68`]: 'DHCP',
  [`${UDP}/547`]: 'DHCP',
  [`${UDP}/5353`]: 'mDNS',
  [`${UDP}/1900`]: 'SSDP',
  [`${TCP}/8291`]: 'Management',
  [`${TCP}/8728`]: 'Management',
  [`${TCP}/8729`]: 'Management',
  [`${UDP}/161`]: 'Management',
  [`${UDP}/3478`]: 'Video/Voice Calls',
  [`${TCP}/5060`]: 'Video/Voice Calls',
  [`${UDP}/5060`]: 'Video/Voice Calls',
  [`${TCP}/5061`]: 'Video/Voice Calls',
};

/**
 * Port names an admin added under Settings → Firewall Logs (#415), used for
 * ports the table above doesn't name: a VPN on 1198 or an app's own port then
 * shows as an application of its own instead of Other UDP / Other TCP. They
 * never rename a port the table already names, so existing categories and
 * their history stay as they are.
 */
let savedNames = new Map<string, string>();

/**
 * Take the saved Firewall Logs port names (`firewall_log_services`). Anything
 * malformed is skipped. A range (`to`, #415) names every port in it; a single
 * port names itself over a range, and a narrower range over a wider one.
 */
export function setSavedPortNames(entries: unknown): void {
  const next = new Map<string, string>();
  const ok: { lo: number; hi: number; protocol: string; name: string }[] = [];
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const { port, to, protocol, name } = e as Record<string, unknown>;
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) continue;
      if (to !== undefined && (!Number.isInteger(to) || (to as number) < (port as number) || (to as number) > 65535)) continue;
      if (typeof name !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(name)) continue;
      if (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'both') continue;
      ok.push({ lo: port as number, hi: (to as number | undefined) ?? (port as number), protocol, name });
    }
  }
  // Widest first, so narrower ranges and single ports are set over them.
  ok.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
  for (const { lo, hi, protocol, name } of ok) {
    for (let port = lo; port <= hi; port++) {
      if (protocol !== 'udp') next.set(`${TCP}/${port}`, name);
      if (protocol !== 'tcp') next.set(`${UDP}/${port}`, name);
    }
  }
  savedNames = next;
}

/** The application for one port: the table's name, else a saved one. */
function nameFor(protocol: number, port: number): string | undefined {
  const key = `${protocol}/${port}`;
  return PORT_MAP[key] ?? savedNames.get(key);
}

/** A port with a service name, built in (443, 53) or saved by an admin. */
export function isKnownServicePort(protocol: number, port: number): boolean {
  return nameFor(protocol, port) !== undefined;
}

export function classifyApp(
  protocol: number,
  localPort: number,
  remotePort: number
): string {
  if (protocol === ICMP || protocol === ICMPV6) return 'ICMP';
  if (protocol === 47) return 'GRE';
  if (protocol === 50) return 'IPsec';

  // Remote port first (the service the client is talking to), then local port
  // (the client is hosting the service, e.g. inbound SSH).
  const byRemote = nameFor(protocol, remotePort);
  if (byRemote) return byRemote;
  const byLocal = nameFor(protocol, localPort);
  if (byLocal) return byLocal;

  if (protocol === TCP) return 'Other TCP';
  if (protocol === UDP) return 'Other UDP';
  return APP_OTHER;
}
