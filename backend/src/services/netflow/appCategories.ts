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

/** A port this table names a service for, such as 443 or 53. */
export function isKnownServicePort(protocol: number, port: number): boolean {
  return PORT_MAP[`${protocol}/${port}`] !== undefined;
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
  const byRemote = PORT_MAP[`${protocol}/${remotePort}`];
  if (byRemote) return byRemote;
  const byLocal = PORT_MAP[`${protocol}/${localPort}`];
  if (byLocal) return byLocal;

  if (protocol === TCP) return 'Other TCP';
  if (protocol === UDP) return 'Other UDP';
  return APP_OTHER;
}
