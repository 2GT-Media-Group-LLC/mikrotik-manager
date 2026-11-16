/** Builds the text of a client-side WireGuard .conf from router-side peer
 * fields. Mirrors the convention already on this fleet's routers (set up
 * through WinBox's own peer wizard): an empty client-allowed-address means
 * a full tunnel. */
export function buildClientConf(opts: {
  privateKey: string;
  address: string;
  dns?: string;
  serverPublicKey: string;
  endpoint?: string;
  allowedIps?: string;
  keepaliveSeconds?: string;
}): string {
  const lines = ['[Interface]', `PrivateKey = ${opts.privateKey}`, `Address = ${opts.address}`];
  if (opts.dns) lines.push(`DNS = ${opts.dns}`);
  lines.push('', '[Peer]', `PublicKey = ${opts.serverPublicKey}`);
  if (opts.endpoint) lines.push(`Endpoint = ${opts.endpoint}`);
  lines.push(`AllowedIPs = ${opts.allowedIps || '0.0.0.0/0, ::/0'}`);
  if (opts.keepaliveSeconds) lines.push(`PersistentKeepalive = ${opts.keepaliveSeconds}`);
  return lines.join('\n');
}

/**
 * `host:port` for a client's Endpoint line and the router's client-endpoint
 * field, which RouterOS stores with its port ("vpn.example.com:13231"). An
 * IPv6 address goes in brackets. A host that already names a port keeps it,
 * so a peer set up in WinBox isn't given a second one; with no port known,
 * the host is returned alone.
 */
export function endpointWithPort(host: string, port?: string): string {
  const h = host.trim();
  if (!h) return '';
  if (/^\[.+\]:\d+$/.test(h)) return h;                    // [v6]:port
  if (/^[^:]+:\d+$/.test(h)) return h;                       // name or v4 with port
  const bare = h.replace(/^\[(.*)\]$/, '$1');
  const shown = bare.includes(':') ? `[${bare}]` : bare;     // v6 needs brackets
  return port && /^\d+$/.test(port) ? `${shown}:${port}` : shown;
}
