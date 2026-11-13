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
