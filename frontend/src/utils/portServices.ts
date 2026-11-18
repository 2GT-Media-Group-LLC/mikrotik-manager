// Firewall Logs: the application behind a port, and traffic worth a colour (#415).

export type ServiceProto = 'tcp' | 'udp' | 'both';
/** `to` makes it a range, `port` to `to` (#415). */
export interface PortService { port: number; to?: number; protocol: ServiceProto; name: string }

/**
 * The ports seen on a MikroTik network, named as /etc/services names them
 * (upper case), with a few made plainer (DNS rather than "domain") and the
 * MikroTik ones (WinBox, the API, MNDP, bandwidth test) that it doesn't know.
 * Settings → Firewall Logs adds to these and overrides them.
 */
const TABLE: [number, ServiceProto, string][] = [
  [7, 'both', 'ECHO'], [20, 'tcp', 'FTP-DATA'], [21, 'tcp', 'FTP'], [22, 'tcp', 'SSH'], [23, 'tcp', 'TELNET'],
  [25, 'tcp', 'SMTP'], [43, 'tcp', 'WHOIS'], [49, 'both', 'TACACS'], [53, 'both', 'DNS'],
  [67, 'udp', 'BOOTPS'], [68, 'udp', 'BOOTPC'], [69, 'udp', 'TFTP'], [80, 'tcp', 'HTTP'], [88, 'both', 'KERBEROS'],
  [110, 'tcp', 'POP3'], [111, 'both', 'SUNRPC'], [119, 'tcp', 'NNTP'], [123, 'udp', 'NTP'], [135, 'both', 'EPMAP'],
  [137, 'udp', 'NETBIOS-NS'], [138, 'udp', 'NETBIOS-DGM'], [139, 'tcp', 'NETBIOS-SSN'], [143, 'tcp', 'IMAP'],
  [161, 'udp', 'SNMP'], [162, 'udp', 'SNMP-TRAP'], [179, 'tcp', 'BGP'], [389, 'both', 'LDAP'],
  [443, 'both', 'HTTPS'], [445, 'tcp', 'MICROSOFT-DS'], [464, 'both', 'KPASSWD'], [465, 'tcp', 'SUBMISSIONS'],
  [500, 'udp', 'ISAKMP'], [514, 'udp', 'SYSLOG'], [515, 'tcp', 'PRINTER'], [520, 'udp', 'RIP'], [521, 'udp', 'RIPNG'],
  [546, 'udp', 'DHCPV6-CLIENT'], [547, 'udp', 'DHCPV6-SERVER'], [554, 'both', 'RTSP'], [587, 'tcp', 'SUBMISSION'],
  [631, 'tcp', 'IPP'], [636, 'tcp', 'LDAPS'], [646, 'both', 'LDP'], [853, 'both', 'DOMAIN-S'], [873, 'tcp', 'RSYNC'],
  [989, 'tcp', 'FTPS-DATA'], [990, 'tcp', 'FTPS'], [993, 'tcp', 'IMAPS'], [995, 'tcp', 'POP3S'],
  [1080, 'tcp', 'SOCKS'], [1194, 'both', 'OPENVPN'], [1433, 'tcp', 'MS-SQL-S'], [1701, 'udp', 'L2TP'],
  [1723, 'tcp', 'PPTP'], [1812, 'udp', 'RADIUS'], [1813, 'udp', 'RADIUS-ACCT'], [1883, 'tcp', 'MQTT'],
  [1900, 'udp', 'SSDP'], [2000, 'tcp', 'BTEST'], [2049, 'both', 'NFS'], [2055, 'udp', 'NETFLOW'],
  [3128, 'tcp', 'SQUID'], [3306, 'tcp', 'MYSQL'], [3389, 'both', 'RDP'], [3478, 'both', 'STUN'],
  [3799, 'udp', 'RADIUS-DYNAUTH'], [4500, 'udp', 'IPSEC-NAT-T'], [4789, 'udp', 'VXLAN'], [5060, 'both', 'SIP'],
  [5061, 'tcp', 'SIPS'], [5246, 'udp', 'CAPWAP-CONTROL'], [5247, 'udp', 'CAPWAP-DATA'], [5353, 'udp', 'MDNS'],
  [5355, 'udp', 'LLMNR'], [5432, 'tcp', 'POSTGRESQL'], [5678, 'udp', 'MNDP'], [5900, 'tcp', 'VNC'],
  [6081, 'udp', 'GENEVE'], [6379, 'tcp', 'REDIS'], [6514, 'tcp', 'SYSLOG-TLS'], [8080, 'tcp', 'HTTP-ALT'],
  [8291, 'tcp', 'WINBOX'], [8443, 'tcp', 'HTTPS-ALT'], [8728, 'tcp', 'API'], [8729, 'tcp', 'API-SSL'],
  [8883, 'tcp', 'SECURE-MQTT'], [9100, 'tcp', 'JETDIRECT'], [10050, 'tcp', 'ZABBIX-AGENT'],
  [10051, 'tcp', 'ZABBIX-TRAPPER'], [13231, 'udp', 'WIREGUARD'], [20561, 'udp', 'MAC-WINBOX'], [51820, 'udp', 'WIREGUARD'],
];
export const BUILTIN_SERVICES: PortService[] = TABLE.map(([port, protocol, name]) => ({ port, protocol, name }));

const key = (port: number, proto: 'tcp' | 'udp') => `${proto}/${port}`;

/**
 * A lookup from the built-in table with the saved entries laid over it. A
 * saved range names every port in it; a saved single port names itself over
 * a range, and a narrower range over a wider one.
 */
export function serviceIndex(custom: PortService[] = []): Map<string, string> {
  const m = new Map<string, string>();
  const width = (s: PortService) => (s.to ?? s.port) - s.port;
  const saved = [...custom].sort((a, b) => width(b) - width(a));
  for (const s of [...BUILTIN_SERVICES, ...saved]) {
    for (let port = s.port; port <= (s.to ?? s.port); port++) {
      if (s.protocol !== 'udp') m.set(key(port, 'tcp'), s.name);
      if (s.protocol !== 'tcp') m.set(key(port, 'udp'), s.name);
    }
  }
  return m;
}

/**
 * The application a line's ports point at: the destination port's, else the
 * source port's (a reply from 53 back to a client's 51234 is DNS too).
 */
export function serviceFor(
  index: Map<string, string>, protocol: string, dstPort?: number, srcPort?: number,
): string | undefined {
  const p = protocol.toLowerCase();
  if (p !== 'tcp' && p !== 'udp') return undefined;
  return (dstPort != null ? index.get(key(dstPort, p)) : undefined)
    ?? (srcPort != null ? index.get(key(srcPort, p)) : undefined);
}

export type TrafficKind = 'dhcp' | 'multicast';

/**
 * DHCP (v4 or v6), or multicast and broadcast. DHCP first: a discover goes to
 * 255.255.255.255. A subnet's own broadcast (192.168.88.255) can't be told
 * from a host without its mask, so only the all-ones address counts.
 */
export function trafficKind(line: { protocol: string; dstIp: string; srcPort?: number; dstPort?: number }): TrafficKind | undefined {
  const ports = [line.srcPort, line.dstPort];
  if (line.protocol.toLowerCase() === 'udp' && ports.some((p) => p === 67 || p === 68 || p === 546 || p === 547)) return 'dhcp';
  const ip = line.dstIp.toLowerCase();
  if (ip.includes(':')) return ip.startsWith('ff') ? 'multicast' : undefined;
  if (ip === '255.255.255.255') return 'multicast';
  const first = Number(ip.split('.')[0]);
  return first >= 224 && first <= 239 ? 'multicast' : undefined;
}

/** The row colours an admin can pick. Literal class names, so Tailwind keeps them. */
export const HIGHLIGHT_COLORS: Record<string, { label: string; row: string; swatch: string }> = {
  none: { label: 'None', row: '', swatch: 'bg-transparent border border-dashed border-gray-300 dark:border-slate-600' },
  gray: { label: 'Gray', row: 'bg-gray-100/70 dark:bg-slate-700/40', swatch: 'bg-gray-300 dark:bg-slate-500' },
  blue: { label: 'Blue', row: 'bg-blue-50 dark:bg-blue-900/20', swatch: 'bg-blue-400' },
  cyan: { label: 'Cyan', row: 'bg-cyan-50 dark:bg-cyan-900/20', swatch: 'bg-cyan-400' },
  teal: { label: 'Teal', row: 'bg-teal-50 dark:bg-teal-900/20', swatch: 'bg-teal-400' },
  green: { label: 'Green', row: 'bg-green-50 dark:bg-green-900/20', swatch: 'bg-green-400' },
  amber: { label: 'Amber', row: 'bg-amber-50 dark:bg-amber-900/20', swatch: 'bg-amber-400' },
  orange: { label: 'Orange', row: 'bg-orange-50 dark:bg-orange-900/20', swatch: 'bg-orange-400' },
  violet: { label: 'Violet', row: 'bg-violet-50 dark:bg-violet-900/20', swatch: 'bg-violet-400' },
  pink: { label: 'Pink', row: 'bg-pink-50 dark:bg-pink-900/20', swatch: 'bg-pink-400' },
};
export const DEFAULT_COLORS: Record<TrafficKind, string> = { dhcp: 'cyan', multicast: 'violet' };

/** The saved colours, each falling back to its default when missing or unknown. */
export function highlightColors(saved: unknown): Record<TrafficKind, string> {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const pick = (k: TrafficKind) => {
    const v = s[k];
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, v) ? v : DEFAULT_COLORS[k];
  };
  return { dhcp: pick('dhcp'), multicast: pick('multicast') };
}

/** The saved entries, keeping only well-formed ones. */
export function savedServices(saved: unknown): PortService[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter((s): s is PortService =>
    !!s && typeof s === 'object' && Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535
    && (s.to === undefined || (Number.isInteger(s.to) && s.to >= s.port && s.to <= 65535))
    && ['tcp', 'udp', 'both'].includes(s.protocol) && typeof s.name === 'string' && s.name.length > 0);
}
